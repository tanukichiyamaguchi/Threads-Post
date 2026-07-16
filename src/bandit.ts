// インプレッション最大化のためのバンディット学習コア（Thompson Sampling・純TS）。
//
// 仕組み:
// - 投稿の「型」を独立した次元（フック・長さ・締め方・エリア言及（蒲田＋周辺3km圏＋大田区）・話題乗り）に分解し、
//   次元ごとにアーム（選択肢）のガウス事後分布 {n, mean, m2} を保持する。
// - 報酬 = log(1+views24h) − 同日投稿の中央値。日ごとの地合い・フォロワー成長の影響を除去し、
//   「同じ日に投稿した中で相対的に伸びたか」だけを学習する。
// - 毎日の学習時に指数減衰（DECAY_PER_DAY）を適用し、古いデータの影響を薄める。
//   Threadsのアルゴリズム変更や季節変化に事後分布が自動追従する（半減期 約23日）。
// - 生成時は「次元ごとに独立して」探索するか最良アームを使うかを決める（重要）。
//   以前は1回のコイン投げで全次元を一括して探索/活用しており、活用時は常に
//   「その時点の最良の組み合わせ」しか生成されず、パターンが同じになって
//   個々の次元の効果を切り分けにくかった。次元ごとに独立させることで、
//   活用中でも他の次元は探索され続け、組み合わせの多様性と分析可能性が上がる。
// - 探索率はデータ量に応じて適応的に下げる（立ち上げ期は広く探索し、
//   十分なサンプルが集まったら基本値に収束させる）。

import { mulberry32 } from "./schedule";
import type { ArmStats, BanditModel, PostFeatures } from "./state";

/** 学習する次元とアーム。プロンプトのディレクティブ文はこのラベルから組み立てる */
export const DIMENSIONS: Record<string, string[]> = {
  hook: ["問題提起", "数字", "逆説", "共感", "あるある", "リスト", "意見募集", "自己開示"],
  length: ["S", "M", "L"],
  ending: ["二択質問", "共感確認", "開いた質問", "言い切り"],
  kamata: ["あり", "なし"],
  newsRiding: ["乗る", "乗らない"],
};

/**
 * 長さアームの文字数レンジ（プロンプト指示・実測判定の両方で使う）。
 * 実測データで短文がM・Lを大きく上回ったこと、および運用者の指定
 * 「投稿の9割は38文字以内」を反映。S(〜38字)を基本形とし、
 * M/Lは残り約1割の実験枠としてのみ残す（QUOTAS.lengthで9割を強制保証）。
 */
export const LENGTH_RANGES: Record<string, { min: number; max: number; label: string }> = {
  S: { min: 12, max: 38, label: "38文字以内の一撃短文（一文〜二文で完結）" },
  M: { min: 39, max: 80, label: "39〜80文字の短文" },
  L: { min: 81, max: 160, label: "81〜160文字の中文" },
};

export const EXPLORE_RATE = 0.15; // 基本の探索率（データが十分溜まった後の値）
const EXPLORE_RATE_COLD_START = 0.35; // 立ち上げ期（サンプルが少ない間）の探索率
const EXPLORE_RATE_RAMP_SAMPLES = 300; // このサンプル数までで基本値へ線形に収束させる
const DECAY_PER_DAY = 0.97; // 実効サンプル数の日次減衰（半減期 ≈ 23日）
const MIN_VARIANCE = 0.25; // 事後分散の下限（過信防止）

/** 学習済みサンプル数に応じた探索率。データが少ないほど広く探索する。 */
export function exploreRateFor(sampleCount: number): number {
  if (sampleCount >= EXPLORE_RATE_RAMP_SAMPLES) return EXPLORE_RATE;
  const t = Math.max(0, sampleCount) / EXPLORE_RATE_RAMP_SAMPLES;
  return EXPLORE_RATE_COLD_START - (EXPLORE_RATE_COLD_START - EXPLORE_RATE) * t;
}

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
 * 1日の中でのアーム出現率の下限(floor)と上限(cap)。
 * Thompsonサンプリングだけだと「今いちばん良い型」に集中しすぎて
 * 全投稿が同じ見た目（例: 全部が質問で締まる）になり、ユーザー体験が悪く
 * 因果の切り分けもできなくなる。日次クォータで構造的に多様性を保証する。
 * - ending: 運用者指定「質問が多すぎる」→ 言い切り（断定）を最低65%に固定し、
 *   質問系3種は合計でも最大35%（各cap: 共感確認は「これ私だけ？」が最も定型化
 *   しやすいため最も低く抑える）。投稿の過半数は疑問符で終わらないことを構造保証。
 * - hook: どの書き出し型も1日の25%まで（あるある一色を防ぐ）
 */
const QUOTAS: Record<string, Record<string, { floor: number; cap: number }>> = {
  hook: Object.fromEntries(
    ["問題提起", "数字", "逆説", "共感", "あるある", "リスト", "意見募集", "自己開示"].map(
      (a) => [a, { floor: 0.05, cap: 0.25 }],
    ),
  ),
  // 運用者指定: 投稿の9割は38文字以内（= Sのfloor 0.9で強制保証・cap 0.93で
  // M/L合計に最低7%程度の実験枠を残し、長さの学習シグナル自体は生かし続ける）。
  length: {
    S: { floor: 0.9, cap: 0.93 },
    M: { floor: 0.03, cap: 0.08 },
    L: { floor: 0, cap: 0.05 },
  },
  ending: {
    二択質問: { floor: 0.04, cap: 0.15 },
    共感確認: { floor: 0.03, cap: 0.12 },
    開いた質問: { floor: 0.05, cap: 0.18 },
    言い切り: { floor: 0.65, cap: 0.82 },
  },
  kamata: {
    あり: { floor: 0.3, cap: 0.7 },
    なし: { floor: 0.3, cap: 0.7 },
  },
  newsRiding: {
    乗る: { floor: 0.15, cap: 0.6 },
    乗らない: { floor: 0.4, cap: 0.85 },
  },
};

/** 次元名から決定的なシード差分を作る（次元ごとに乱数列を分ける） */
function dimSeed(seed: number, dim: string): number {
  let h = seed >>> 0;
  for (let i = 0; i < dim.length; i++) {
    h = (Math.imul(h, 31) + dim.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** 1次元ぶんの日次割り当てを作る: floor保証 → 残りをcap制約付きThompsonで配分 → シャッフル */
function planDimension(
  model: BanditModel,
  dim: string,
  seed: number,
  total: number,
): string[] {
  const arms = DIMENSIONS[dim];
  const quotas = QUOTAS[dim] ?? {};
  const rng = mulberry32(dimSeed(seed, dim));

  // 1) 下限（floor）ぶんを先に確保
  const counts: Record<string, number> = {};
  for (const arm of arms) {
    counts[arm] = Math.floor(total * (quotas[arm]?.floor ?? 0));
  }
  let assigned = arms.reduce((s, a) => s + counts[a], 0);

  // 2) 残りスロットを、上限（cap）未満のアームからThompsonサンプリングで配分
  const capOf = (arm: string): number =>
    Math.max(1, Math.ceil(total * (quotas[arm]?.cap ?? 1)));
  while (assigned < total) {
    let best: string | null = null;
    let bestSample = -Infinity;
    for (const arm of arms) {
      if (counts[arm] >= capOf(arm)) continue;
      const s = model.dimensions[dim]?.[arm] ?? { n: 1, mean: 0, m2: 0.5 };
      const sampleVar = s.n > 1 ? s.m2 / (s.n - 1) : MIN_VARIANCE;
      const sigma = Math.sqrt(Math.max(MIN_VARIANCE, sampleVar) / Math.max(1, s.n));
      const sample = s.mean + sigma * gaussian(rng);
      if (sample > bestSample) {
        bestSample = sample;
        best = arm;
      }
    }
    // 全アームがcapに達した場合の保険（クォータ設定ミス時のみ到達）
    if (best === null) best = arms[Math.floor(rng() * arms.length)];
    counts[best]++;
    assigned++;
  }

  // 3) スロットへの並び順を日替わりでシャッフル（組み合わせが偏らないように）
  const plan: string[] = [];
  for (const arm of arms) for (let i = 0; i < counts[arm]; i++) plan.push(arm);
  for (let i = plan.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [plan[i], plan[j]] = [plan[j], plan[i]];
  }
  return plan;
}

/**
 * その日の全スロットぶんの「型」の割り当て表を作る（決定的）。
 * 学習が示す良い型に配分を寄せつつ、クォータ（QUOTAS）で
 * 「1日の中で必ず多様な型が混ざる」ことを構造的に保証する。
 * 同じ (モデル状態, seed, total) からは常に同じ表が出るため、
 * 起動をまたいでもスロットごとの型はぶれない。
 */
export function planDailyArms(
  model: BanditModel,
  seed: number,
  total: number,
): ChosenArms[] {
  const n = Math.max(1, total);
  const hookPlan = planDimension(model, "hook", seed, n);
  const lengthPlan = planDimension(model, "length", seed, n);
  const endingPlan = planDimension(model, "ending", seed, n);
  const kamataPlan = planDimension(model, "kamata", seed, n);
  const newsPlan = planDimension(model, "newsRiding", seed, n);
  return Array.from({ length: n }, (_, i) => ({
    hook: hookPlan[i],
    length: lengthPlan[i],
    ending: endingPlan[i],
    kamata: kamataPlan[i] === "あり",
    newsRiding: newsPlan[i] === "乗る",
    explore: false, // クォータのfloorが探索を恒常的に担保するため個別フラグは持たない
  }));
}

/**
 * この投稿が使う型をThompsonサンプリングで選ぶ。
 * 次元（フック・長さ・締め方・エリア言及（蒲田＋周辺3km圏＋大田区）・話題乗り）は「それぞれ独立に」探索するか
 * 最良アームを使うかを決める。1つのコインで全次元を揃えると、活用時に常に同じ
 * 「今の一番良い組み合わせ」だけが生成され続けてしまうため、次元ごとに切り分ける。
 * 探索率は学習済みサンプル数に応じて適応的（データが少ないほど広く探索）。
 * seedは日付+スロットから作る（同一スロットの再実行では同じ選択になり再現可能）。
 */
export function chooseArms(model: BanditModel, seed: number): ChosenArms {
  const rng = mulberry32(seed >>> 0);
  const rate = exploreRateFor(model.ingested.length);
  let anyExplore = false;

  const pick = (dim: string): string => {
    const arms = DIMENSIONS[dim];
    if (rng() < rate) {
      anyExplore = true;
      return arms[Math.floor(rng() * arms.length)];
    }
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
    explore: anyExplore, // 1つでも次元が探索されたか（ログ表示用）
  };
}

/** 実文から長さアームを実測判定する（枠を超えても最上位アームに丸め、学習データを捨てない） */
export function measureLengthArm(text: string): string {
  const len = text.length;
  if (len <= LENGTH_RANGES.S.max) return "S";
  if (len <= LENGTH_RANGES.M.max) return "M";
  return "L";
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
