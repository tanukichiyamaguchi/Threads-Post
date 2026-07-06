import { env } from "./config";
import {
  researchTrendingTopics,
  researchEnvironmentTrends,
  buildLearnings,
  buildWeeklyMeta,
  type ScoredPost,
} from "./anthropic";
import {
  loadPostHistory,
  loadMetricsStore,
  loadAccountStats,
  loadBanditModel,
  saveBanditModel,
  saveLearnings,
  loadViralPlaybook,
  saveViralPlaybook,
  saveHourWeights,
  loadVolumeModel,
  saveVolumeModel,
  saveReport,
  type BanditModel,
  type ArmStats,
  type VolumeModel,
} from "./state";
import {
  emptyModel,
  ensureArms,
  applyDecay,
  ingestObservation,
  updateArm,
  summarizeModel,
} from "./bandit";
import { currentJst, WEIGHTED_HOURS, mulberry32, DEFAULT_POSTS_PER_DAY } from "./schedule";
import { log, warn, error } from "./logger";

// 毎日1回実行（05:00 JST）。
// 1) 24時間齢スナップショット（state/metrics.json・metricsジョブが収集）を報酬に変換し、
//    バンディットモデル（state/model.json）を更新 → 投稿の「型」が実測で日々賢くなる
// 2) その日のインプが狙える話題（全国/大田区/蒲田）をWeb検索 → 学習知見を更新
// 3) 月曜のみ: 環境センシング＋週次メタ分析＋時間帯重みの再計算＋投稿数の週次実験を更新し、
//    人間可読レポート（state/report.md）を生成

const VOLUME_ARMS = [30, 40, 50];

/** その日付が属する週の月曜日（YYYY-MM-DD） */
function mondayOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const shift = (d.getUTCDay() + 6) % 7; // 月曜=0
  d.setUTCDate(d.getUTCDate() - shift);
  return d.toISOString().slice(0, 10);
}

function daysAgoStr(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

interface Observation {
  postId: string;
  dateStr: string; // 投稿日（JST近似・ISOの日付部）
  text: string;
  features: NonNullable<import("./state").PostHistoryItem["features"]>;
  views24: number;
  reward: number; // log(1+views24) − 同日中央値（後で埋める）
}

async function main(): Promise<void> {
  const todayLabel = new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "full",
    timeZone: "Asia/Tokyo",
  }).format(new Date());
  const now = currentJst(new Date());

  log(`=== 投稿改善（実測学習）ルーチン開始 (${todayLabel}) ===`);
  env.anthropicApiKey();

  // ---------- 1) 実測スナップショット → バンディット更新 ----------
  const history = loadPostHistory();
  const store = loadMetricsStore();
  const model: BanditModel = loadBanditModel() ?? emptyModel(now.dateStr);
  ensureArms(model);
  applyDecay(model, now.dateStr);

  const ingested = new Set(model.ingested);
  const pending: Observation[] = [];
  for (const h of history) {
    if (!h.postId || !h.features) continue;
    if (ingested.has(h.postId)) continue;
    const snap = store[h.postId]?.s24;
    if (!snap) continue;
    pending.push({
      postId: h.postId,
      dateStr: h.date.slice(0, 10),
      text: h.text,
      features: h.features,
      views24: snap.views,
      reward: 0,
    });
  }

  // 同日中央値との差を報酬にする（日ごとの地合い・フォロワー成長の影響を除去）
  const byDate = new Map<string, Observation[]>();
  for (const o of pending) {
    const arr = byDate.get(o.dateStr) ?? [];
    arr.push(o);
    byDate.set(o.dateStr, arr);
  }
  let newObs = 0;
  for (const [, obs] of byDate) {
    if (obs.length < 5) continue; // 同日サンプルが少なすぎる日は比較にならないため保留
    const med = median(obs.map((o) => Math.log1p(o.views24)));
    for (const o of obs) {
      o.reward = Math.log1p(o.views24) - med;
      ingestObservation(model, o.features, o.reward);
      // 時間帯の実測も蓄積（平日/週末別・投稿の型とは独立に学習）
      const hourDim = o.features.weekend ? "hourWeekend" : "hourWeekday";
      if (!model.dimensions[hourDim]) model.dimensions[hourDim] = {};
      const hourArm = String(o.features.slotHour);
      if (!model.dimensions[hourDim][hourArm]) {
        model.dimensions[hourDim][hourArm] = { n: 1, mean: 0, m2: 0.5 };
      }
      updateArm(model.dimensions[hourDim][hourArm], o.reward);
      model.ingested.push(o.postId);
      newObs++;
    }
  }
  model.updated = now.dateStr;
  saveBanditModel(model);
  log(`学習: 新規 ${newObs} 件の実測を取り込みました（保留 ${pending.length - newObs} 件）。`);

  // 直近7日の実測トップ/ワースト（学習知見・週次分析に使う）
  const week = daysAgoStr(now.dateStr, 7);
  const recentScored: ScoredPost[] = [];
  for (const h of history) {
    if (!h.postId || h.date.slice(0, 10) < week) continue;
    const snap = store[h.postId]?.s24;
    if (!snap) continue;
    recentScored.push({ text: h.text, score: snap.views });
  }
  recentScored.sort((a, b) => b.score - a.score);
  const top = recentScored.slice(0, 6);
  const weak = recentScored.slice(-6).reverse();
  if (top.length) {
    log(`直近7日トップ投稿 (views24h=${top[0].score}): ${top[0].text.replace(/\n/g, " ").slice(0, 40)}`);
  } else {
    log("※ まだ24時間齢スナップショットがありません（metricsジョブの蓄積待ち）。");
  }

  // ---------- 2) 本日の話題 → 学習知見の更新 ----------
  log("本日のインプが狙える話題（全国／大田区／蒲田）をWeb検索で調査中...");
  const trendNotes = await researchTrendingTopics(todayLabel);
  log("話題メモ:\n" + trendNotes.slice(0, 500) + (trendNotes.length > 500 ? " …（略）" : ""));

  log("学習知見を生成中...");
  const { doMore, avoid, todayTopics } = await buildLearnings(
    trendNotes,
    top.map((t) => ({ text: t.text, score: Math.round(t.score) })),
    weak.map((w) => ({ text: w.text, score: Math.round(w.score) })),
  );
  const topExamples = top.filter((t) => t.score > 0).slice(0, 5).map((t) => t.text);
  saveLearnings({ updated: now.dateStr, doMore, avoid, topExamples, todayTopics });
  log(
    `学びを保存（やる ${doMore.length} / 避ける ${avoid.length} / お手本 ${topExamples.length} / 話題 ${todayTopics.length}）。`,
  );

  // ---------- 3) 週次処理（月曜のみ） ----------
  if (now.weekday === 1) {
    await weeklyRoutine(now.dateStr, model, top, weak);
  }

  log("=== 投稿改善ルーチン完了 ===");
}

/** 月曜のみ: 環境センシング・時間帯重み・投稿数実験・週次レポート */
async function weeklyRoutine(
  todayStr: string,
  model: BanditModel,
  top: ScoredPost[],
  weak: ScoredPost[],
): Promise<void> {
  log("--- 週次処理を開始（環境センシング・時間帯・投稿数・レポート） ---");

  // 3a) 時間帯重みの再計算（実測の平均報酬で静的重みを補正。データが薄い時間帯は静的値に寄る）
  const toWeights = (dim: string): Array<[number, number]> =>
    WEIGHTED_HOURS.map(([hour, prior]) => {
      const s: ArmStats | undefined = model.dimensions[dim]?.[String(hour)];
      if (!s || s.n < 2) return [hour, prior] as [number, number];
      const blend = s.n / (s.n + 20);
      const adj = 1 + blend * Math.max(-0.6, Math.min(0.6, s.mean));
      return [hour, Math.max(0.5, Math.round(prior * adj * 10) / 10)] as [number, number];
    });
  saveHourWeights({
    updated: todayStr,
    weekday: toWeights("hourWeekday"),
    weekend: toWeights("hourWeekend"),
  });
  log("時間帯重みを更新しました（実測補正・平日/週末別）。");

  // 3b) 投稿数の週次実験（報酬 = アカウント日次views平均の対前週比・対数）
  const stats = loadAccountStats();
  const avgViews = (from: string, to: string): number => {
    const xs = stats
      .filter((s) => s.date >= from && s.date < to && (s.accountViews ?? 0) > 0)
      .map((s) => s.accountViews!) as number[];
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  };
  const thisMonday = mondayOf(todayStr);
  const lastMonday = daysAgoStr(thisMonday, 7);
  const prevMonday = daysAgoStr(thisMonday, 14);

  let volume: VolumeModel = loadVolumeModel() ?? {
    weekStart: thisMonday,
    postsPerDay: DEFAULT_POSTS_PER_DAY,
    arms: Object.fromEntries(
      VOLUME_ARMS.map((v) => [
        String(v),
        v === DEFAULT_POSTS_PER_DAY ? { n: 2, mean: 0.05, m2: 0.5 } : { n: 1, mean: 0, m2: 0.5 },
      ]),
    ),
    history: [],
  };

  const lastWeekAvg = avgViews(lastMonday, thisMonday);
  const prevWeekAvg = avgViews(prevMonday, lastMonday);
  let volumeNote = "";
  if (volume.weekStart !== thisMonday) {
    // 先週の結果を精算してアームを更新
    if (lastWeekAvg > 0 && prevWeekAvg > 0) {
      const reward = Math.log1p(lastWeekAvg) - Math.log1p(prevWeekAvg);
      const arm = volume.arms[String(volume.postsPerDay)];
      if (arm) updateArm(arm, reward);
      volume.history.push({
        week: volume.weekStart,
        postsPerDay: volume.postsPerDay,
        avgDailyViews: Math.round(lastWeekAvg),
      });
      log(
        `先週(${volume.weekStart})の精算: ${volume.postsPerDay}件/日 → 日次views平均 ${Math.round(lastWeekAvg)}（報酬 ${reward.toFixed(3)}）`,
      );
    } else {
      log("先週のアカウントviewsデータが不足しているため、ボリューム精算をスキップしました。");
    }

    // スパム降格の安全弁: 投稿を増やした週に「1投稿あたりの伸び」が半分未満に落ちたら最小に戻す
    const perPostDrop = detectPerPostDrop(lastMonday, thisMonday, prevMonday);
    if (perPostDrop) {
      volume.postsPerDay = Math.min(...VOLUME_ARMS);
      volumeNote = "⚠ 投稿あたりviewsの急落を検知したため、今週は最小ボリュームに戻します。";
      warn(volumeNote);
    } else {
      // Thompsonサンプリングで今週のボリュームを選択
      const rng = mulberry32(Number(todayStr.replace(/-/g, "")) ^ 0x9e3779b9);
      const gauss = (): number => {
        let u = 0;
        let v = 0;
        while (u === 0) u = rng();
        while (v === 0) v = rng();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      };
      let best = DEFAULT_POSTS_PER_DAY;
      let bestSample = -Infinity;
      for (const v of VOLUME_ARMS) {
        const s = volume.arms[String(v)] ?? { n: 1, mean: 0, m2: 0.5 };
        const sampleVar = s.n > 1 ? s.m2 / (s.n - 1) : 0.25;
        const sigma = Math.sqrt(Math.max(0.25, sampleVar) / Math.max(1, s.n));
        const sample = s.mean + sigma * gauss();
        if (sample > bestSample) {
          bestSample = sample;
          best = v;
        }
      }
      volume.postsPerDay = best;
    }
    volume.weekStart = thisMonday;
    saveVolumeModel(volume);
    log(`今週の投稿数: ${volume.postsPerDay}件/日`);
  }

  // 3c) 環境センシング（今Threadsで伸びている型）＋ 週次メタ分析
  let envTrends: string[] = [];
  let analysis = "";
  try {
    const todayLabel = new Intl.DateTimeFormat("ja-JP", {
      dateStyle: "full",
      timeZone: "Asia/Tokyo",
    }).format(new Date());
    log("環境トレンド（今Threadsで伸びている型）をWeb検索で調査中...");
    const envNotes = await researchEnvironmentTrends(todayLabel);
    const meta = await buildWeeklyMeta(summarizeModel(model), top, weak, envNotes);
    envTrends = meta.environmentTrends;
    analysis = meta.analysis;
    const playbook = loadViralPlaybook();
    if (playbook) {
      playbook.environmentTrends = envTrends;
      saveViralPlaybook(playbook);
      log(`環境トレンドをプレイブックに反映（${envTrends.length}件）。`);
    }
  } catch (e: any) {
    warn(`週次メタ分析に失敗（学習自体は完了しています）: ${e?.message ?? e}`);
  }

  // 3d) 人間可読レポート
  const followers = [...stats].reverse().find((s) => s.followers)?.followers;
  const growth =
    prevWeekAvg > 0 ? ` (前週比 ${(((lastWeekAvg - prevWeekAvg) / prevWeekAvg) * 100).toFixed(1)}%)` : "";
  const report = [
    `# 週次レポート ${todayStr}`,
    ``,
    `## 今週の数字`,
    `- アカウント日次views平均（先週）: ${Math.round(lastWeekAvg)}${growth}`,
    `- フォロワー: ${followers ?? "不明"}`,
    `- 今週の投稿数設定: ${volume.postsPerDay}件/日${volumeNote ? `\n- ${volumeNote}` : ""}`,
    ``,
    `## 型別の学習状況（平均報酬 = 同日中央値との差・対数views）`,
    summarizeModel(model),
    ``,
    `## 分析`,
    analysis || "（今週は分析を生成できませんでした）",
    ``,
    `## 環境トレンド（投稿生成に反映済み）`,
    envTrends.length ? envTrends.map((t) => `- ${t}`).join("\n") : "（更新なし）",
    ``,
    `## ボリューム実験の履歴`,
    volume.history.length
      ? volume.history
          .slice(-8)
          .map((h) => `- ${h.week}週: ${h.postsPerDay}件/日 → 日次views平均 ${h.avgDailyViews}`)
          .join("\n")
      : "（まだ履歴がありません）",
  ].join("\n");
  saveReport(report + "\n");
  log("週次レポート（state/report.md）を生成しました。");
}

/** 投稿を増やした直後に「1投稿あたりのviews」が急落していないか（スパム的降格の検知） */
function detectPerPostDrop(lastMonday: string, thisMonday: string, prevMonday: string): boolean {
  const history = loadPostHistory();
  const store = loadMetricsStore();
  const viewsIn = (from: string, to: string): number[] =>
    history
      .filter((h) => h.postId && h.date.slice(0, 10) >= from && h.date.slice(0, 10) < to)
      .map((h) => store[h.postId!]?.s24?.views)
      .filter((v): v is number => typeof v === "number");
  const lastWeek = viewsIn(lastMonday, thisMonday);
  const prevWeek = viewsIn(prevMonday, lastMonday);
  if (lastWeek.length < 10 || prevWeek.length < 10) return false;
  const mLast = median(lastWeek);
  const mPrev = median(prevWeek);
  return mPrev > 0 && mLast < mPrev * 0.5 && lastWeek.length > prevWeek.length;
}

main().catch((e: any) => {
  error(e?.stack || e?.message || String(e));
  process.exit(1);
});
