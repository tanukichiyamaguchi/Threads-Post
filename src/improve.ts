import { env } from "./config";
import { ThreadsClient } from "./threads";
import { researchViralPatterns, buildLearnings, type ScoredPost } from "./anthropic";
import {
  loadPostHistory,
  savePostHistory,
  saveLearnings,
  type PostMetrics,
} from "./state";
import { currentJst } from "./schedule";
import { log, warn, error } from "./logger";

// 毎日1回実行。
// 1) 自店の最近の投稿のエンゲージメント実績（いいね・返信・リポスト・引用・閲覧）を取得
// 2) Web検索で「バズる投稿の型」を調査
// 3) 両者を統合して学習知見（state/learnings.json）を更新
// 各投稿の生成時にこの知見を注入することで、投稿を日々改善する。

const MAX_POSTS_TO_ANALYZE = 40;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** エンゲージメントの総合スコア（会話・拡散を高めに評価） */
function scoreOf(m: {
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  views: number;
}): number {
  return Math.round(m.views * 0.1 + m.likes * 1 + m.replies * 3 + m.reposts * 5 + m.quotes * 5);
}

async function main(): Promise<void> {
  const todayLabel = new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "full",
    timeZone: "Asia/Tokyo",
  }).format(new Date());
  const now = currentJst(new Date());

  log(`=== 投稿改善（バズ学習）ルーチン開始 (${todayLabel}) ===`);
  env.anthropicApiKey();

  // 1) 自店の投稿実績を集計
  const history = loadPostHistory();
  const recent = history.filter((h) => h.postId).slice(-MAX_POSTS_TO_ANALYZE);
  log(`実績を集計する投稿: ${recent.length}件`);

  const scored: Array<ScoredPost & { postId: string }> = [];
  if (recent.length) {
    const client = new ThreadsClient(env.threadsUserId(), env.threadsToken());
    for (const h of recent) {
      try {
        const m = await client.getMetrics(h.postId!);
        const score = scoreOf(m);
        const metrics: PostMetrics = {
          likes: m.likes,
          replies: m.replies,
          reposts: m.reposts,
          quotes: m.quotes,
          views: m.views,
          score,
          fetchedAt: new Date().toISOString(),
        };
        h.metrics = metrics; // 履歴に実績を追記
        scored.push({ text: h.text, score, postId: h.postId! });
        await sleep(400);
      } catch (e: any) {
        warn(`実績取得に失敗 (${h.postId}): ${e.message}`);
      }
    }
    savePostHistory(history); // metrics を書き戻す
  } else {
    log("まだ実績のある投稿がありません。外部のバズ調査のみで学びを作成します。");
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 6);
  const topIds = new Set(top.map((t) => t.postId));
  const weak = scored
    .slice()
    .reverse()
    .filter((w) => !topIds.has(w.postId))
    .slice(0, 6);
  if (top.length) {
    log(
      `トップ投稿 (score=${top[0].score}): ${top[0].text.replace(/\n/g, " ").slice(0, 40)}`,
    );
  }

  // 2) 外部のバズ投稿の型を調査（Web検索あり）
  log("バズる投稿の型をWeb検索で調査中...");
  const viralNotes = await researchViralPatterns(todayLabel);
  log(
    "調査メモ:\n" + viralNotes.slice(0, 600) + (viralNotes.length > 600 ? " …（略）" : ""),
  );

  // 3) 学習知見を生成して保存
  log("学習知見を生成中...");
  const { playbook, doMore, avoid, viralAngles } = await buildLearnings(
    viralNotes,
    top.map((t) => ({ text: t.text, score: t.score })),
    weak.map((w) => ({ text: w.text, score: w.score })),
  );

  const topExamples = top
    .filter((t) => t.score > 0)
    .slice(0, 5)
    .map((t) => t.text);

  saveLearnings({
    updated: now.dateStr,
    playbook,
    doMore,
    avoid,
    viralAngles,
    topExamples,
  });
  log(
    `学びを保存しました（型 ${playbook.length} / 切り口 ${viralAngles.length} / ` +
      `やる ${doMore.length} / 避ける ${avoid.length} / お手本 ${topExamples.length}）。`,
  );

  log("=== 投稿改善ルーチン完了 ===");
}

main().catch((e: any) => {
  error(e?.stack || e?.message || String(e));
  process.exit(1);
});
