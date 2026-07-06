// インプレッション最大化のためのバンディット学習コア（Thompson Sampling・純TS）。
//
// 仕組み:
// - 投稿の「型」を独立した次元（フック・長さ・締め方・蒲田言及・話題乗り）に分解し、
//   次元ごとにアーム（選択肢）のガウス事後分布 {n, mean, m2} を保持する。
// - 報酬 = log(1+views24h) − 同日投稿の中央値。日ごとの地合い・フォロワー成長の影響を除去し、
//   「同じ日に投稿した中で相対的に伸びたか」だけを学習する。
// - 毎日の学習時に指数減衰（DECAY_PER_DAY）を適用し、古いデータの影響を薄める。
//   Threadsのアルゴリズム変更や季節変化に事後分布が自動追従する（半減期 約23日）。
// - 生成時は各次元をThompsonサンプリングで選択。EXPLORE_RATE の確率で一様ランダム
//   （強制探索）にして、収束後も環境変化を検知できる余地を残す。

import { mulberry32 } from "./schedule";
import type { ArmStats, BanditModel, PostFeatures } from "./state";

/** 学習する次元とアーム。プロンプトのディレクティブ文はこのラベルから組み立てる */
export const DIMENSIONS: Record<string, string[]> = {
  hook: ["問題提起", "数字", "逆説", "共感", "あるある", "リスト", "意見募集", "自己開示"],
  length: ["S", "M", "L", "XL"],
  ending: ["二択質問", "共感確認", "開いた質問", "言い切り"],
  kamata: ["あり", "なし"],
  newsRiding: ["乗る", "乗らない"],
};

/** 長さアームの文字数レンジ（プロンプト指示・実測判定の両方で使う） */
export const LENGTH_RANGES: Record<string, { min: number; max: number; label: string }> = {
  S: { min: 20, max: 80, label: "20〜80文字の短文" },
  M: { min: 81, max: 200, label: "81〜200文字の中文" },
  L: { min: 201, max: 350, label: "201〜350文字のやや長文" },
  XL: { min: 351, max: 500, label: "351〜500文字の長文" },
};

export const EXPLORE_RATE = 0.15; // 強制探索の割合
const DECAY_PER_DAY = 0.97; // 実効サンプル数の日次減衰（半減期 ≈ 23日）
const MIN_VARIANCE = 0.25; // 事後分散の下限（過信防止）

/**
 * プレイブックの知見を弱い楽観的事前分布としてシードした初期モデル。
 * データが薄い初週でも既知の「効きやすい型」から始め、探索で検証していく。
 */
export function emptyModel(today: string): BanditModel {
  const optimistic: Record<string, string[]> = {
    hook: ["問題提起", "共感", "あるある"],
    length: ["S", "M"],
    ending: ["二択質問", "共感確認"],
    kamata: ["あり"],
    newsRiding: ["乗る"],
  };
  const dimensions: Record<string, Record<string, ArmStats>> = {};
  for (const [dim, arms] of Object.entries(DIMENSIONS)) {
    dimensions[dim] = {};
    for (const arm of arms) {
      const opt = optimistic[dim]?.includes(arm);
      // 楽観アームは「わずかに正の平均・実効2サンプル」程度の弱い事前。すぐ実測に上書きされる
      dimensions[dim][arm] = opt ? { n: 2, mean: 0.1, m2: 1.0 } : { n: 1, mean: 0, m2: 0.5 };
    }
  }
  return { updated: today, decayAppliedOn: today, dimensions, ingested: [] };
}

/** モデルに未知の次元・アームがあれば補完する（次元追加時の後方互換） */
export function ensureArms(model: BanditModel): void {
  for (const [dim, arms] of Object.entries(DIMENSIONS)) {
    if (!model.dimensions[dim]) model.dimensions[dim] = {};
    for (const arm of arms) {
      if (!model.dimensions[dim][arm]) {
        model.dimensions[dim][arm] = { n: 1, mean: 0, m2: 0.5 };
      }
    }
  }
}

/** 日次の指数減衰。mean は保ち、確信度（n）だけを下げて新データへの感応度を上げる */
export function applyDecay(model: BanditModel, todayStr: string): void {
  const last = Date.parse(model.decayAppliedOn || todayStr);
  const today = Date.parse(todayStr);
  if (!Number.isFinite(last) || !Number.isFinite(today)) return;
  const days = Math.max(0, Math.round((today - last) / 86400000));
  if (days === 0) return;
  const factor = Math.pow(DECAY_PER_DAY, days);
  for (const arms of Object.values(model.dimensions)) {
    for (const s of Object.values(arms)) {
      s.n = Math.max(1, s.n * factor);
      s.m2 = s.m2 * factor;
    }
  }
  model.decayAppliedOn = todayStr;
}

/** Welford法での逐次更新 */
export function updateArm(s: ArmStats, reward: number): void {
  s.n += 1;
  const delta = reward - s.mean;
  s.mean += delta / s.n;
  s.m2 += delta * (reward - s.mean);
}

/** 1投稿ぶんの実績をモデルに取り込む */
export function ingestObservation(
  model: BanditModel,
  features: PostFeatures,
  reward: number,
): void {
  const armOf: Record<string, string> = {
    hook: features.hook,
    length: features.length,
    ending: features.ending,
    kamata: features.kamata ? "あり" : "なし",
    newsRiding: features.newsRiding ? "乗る" : "乗らない",
  };
  for (const [dim, arm] of Object.entries(armOf)) {
    const stats = model.dimensions[dim]?.[arm];
    if (stats) updateArm(stats, reward);
  }
}

/** Box-Muller法による標準正規乱数（決定的rngから生成） */
function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface ChosenArms {
  hook: string;
  length: string;
  ending: string;
  kamata: boolean;
  newsRiding: boolean;
  explore: boolean;
}

/**
 * この投稿が使う型をThompsonサンプリングで選ぶ。
 * seedは日付+スロットから作る（同一スロットの再実行では同じ選択になり再現可能）。
 */
export function chooseArms(model: BanditModel, seed: number): ChosenArms {
  const rng = mulberry32(seed >>> 0);
  const explore = rng() < EXPLORE_RATE;

  const pick = (dim: string): string => {
    const arms = DIMENSIONS[dim];
    if (explore) return arms[Math.floor(rng() * arms.length)];
    let best = arms[0];
    let bestSample = -Infinity;
    for (const arm of arms) {
      const s = model.dimensions[dim]?.[arm] ?? { n: 1, mean: 0, m2: 0.5 };
      const sampleVar = s.n > 1 ? s.m2 / (s.n - 1) : MIN_VARIANCE;
      const sigma = Math.sqrt(Math.max(MIN_VARIANCE, sampleVar) / Math.max(1, s.n));
      const sample = s.mean + sigma * gaussian(rng);
      if (sample > bestSample) {
        bestSample = sample;
        best = arm;
      }
    }
    return best;
  };

  return {
    hook: pick("hook"),
    length: pick("length"),
    ending: pick("ending"),
    kamata: pick("kamata") === "あり",
    newsRiding: pick("newsRiding") === "乗る",
    explore,
  };
}

/** 実文から長さアームを実測判定する */
export function measureLengthArm(text: string): string {
  const len = text.length;
  if (len <= LENGTH_RANGES.S.max) return "S";
  if (len <= LENGTH_RANGES.M.max) return "M";
  if (len <= LENGTH_RANGES.L.max) return "L";
  return "XL";
}

/** 実文から締め方アームを実測判定する（判定不能なら指示値を使う） */
export function measureEndingArm(text: string, directed: string): string {
  const tail = text.trim().slice(-60);
  const hasQuestion = /[？?]\s*$/.test(text.trim());
  if (!hasQuestion) return "言い切り";
  // 「AかBか」「どっち」のような二択表現
  if (/どっち|どちら|それとも|派[？?]/.test(tail)) return "二択質問";
  // 「〜ですよね」「〜じゃない？」「私だけ？」のような共感確認
  if (/よね[？?]|じゃない[？?]|ません[？?]|だけ[？?]|わかる/.test(tail)) return "共感確認";
  return directed === "言い切り" ? "開いた質問" : directed;
}

/** アーム統計の要約（週次レポート用） */
export function summarizeModel(model: BanditModel): string {
  const lines: string[] = [];
  for (const [dim, arms] of Object.entries(model.dimensions)) {
    const sorted = Object.entries(arms).sort((a, b) => b[1].mean - a[1].mean);
    const parts = sorted.map(
      ([arm, s]) => `${arm}: 平均${s.mean.toFixed(3)} (n≈${s.n.toFixed(1)})`,
    );
    lines.push(`- ${dim}: ${parts.join(" / ")}`);
  }
  return lines.join("\n");
}
