import { env } from "./config";
import { ThreadsClient } from "./threads";
import {
  loadPostHistory,
  loadMetricsStore,
  saveMetricsStore,
  loadAccountStats,
  saveAccountStats,
} from "./state";
import { currentJst, currentPostsPerDay } from "./schedule";
import { log, warn, error } from "./logger";

// 2時間ごとに実行。投稿を「同じ齢」で計測して比較可能にする。
// - 投稿齢 22〜30時間: snapshot24h（バンディット学習の報酬に使う主指標）
// - 投稿齢 66〜78時間: snapshot72h（伸びの持続の分析用）
// - 1日1回: アカウント全体の日次views・フォロワー数を記録（ボリューム実験の報酬）
// 保存先は state/metrics.json / state/account-stats.json（post-history.json とは
// 分離し、並走する投稿ジョブとのgitコミット競合を避ける）。

const MAX_FETCH_PER_RUN = 60;
const HOUR = 3600 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  log("=== メトリクス収集ルーチン開始 ===");
  const client = new ThreadsClient(env.threadsUserId(), env.threadsToken());
  const now = Date.now();
  const jst = currentJst(new Date());

  const history = loadPostHistory();
  const store = loadMetricsStore();

  // --- 投稿単位の固定齢スナップショット ---
  let attempts = 0;
  let ok = 0;
  let permissionError: string | null = null;

  for (const h of history) {
    if (!h.postId) continue;
    if (attempts >= MAX_FETCH_PER_RUN) break;
    const postedAt = Date.parse(h.date);
    if (!Number.isFinite(postedAt)) continue;
    const age = now - postedAt;

    const entry = store[h.postId] ?? { postedAt: h.date };
    const need24 = !entry.s24 && age >= 22 * HOUR && age <= 30 * HOUR;
    const need72 = !entry.s72 && age >= 66 * HOUR && age <= 78 * HOUR;
    if (!need24 && !need72) continue;

    attempts++;
    try {
      const m = await client.getMetrics(h.postId);
      const snap = { ...m, fetchedAt: new Date(now).toISOString() };
      if (need24) entry.s24 = snap;
      if (need72) entry.s72 = snap;
      store[h.postId] = entry;
      ok++;
      await sleep(300);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      warn(`スナップショット取得に失敗 (${h.postId}): ${msg}`);
      if (/threads_manage_insights|permission|OAuth|code 190|code 10\b|code 200/i.test(msg)) {
        permissionError = msg;
        break; // 権限エラーは全件同じ失敗になるため打ち切る
      }
    }
  }
  saveMetricsStore(store);
  log(`スナップショット: ${ok}/${attempts} 件取得（対象になった投稿のみ）`);

  // --- アカウント全体の日次統計（1日1回だけ更新） ---
  const stats = loadAccountStats();
  const todayEntry = stats.find((s) => s.date === jst.dateStr);
  if (!todayEntry || todayEntry.accountViews === undefined) {
    try {
      const until = Math.floor(now / 1000);
      const since = until - 3 * 24 * 3600; // 直近3日ぶん（取りこぼし補完）
      const ins = await client.getUserInsights(since, until);
      for (const d of ins.dailyViews) {
        if (!d.date) continue;
        const existing = stats.find((s) => s.date === d.date);
        if (existing) {
          existing.accountViews = d.views;
        } else {
          stats.push({ date: d.date, accountViews: d.views });
        }
      }
      const today = stats.find((s) => s.date === jst.dateStr);
      if (today) {
        today.followers = ins.followers;
        today.postsPerDay = currentPostsPerDay(jst);
      } else {
        stats.push({
          date: jst.dateStr,
          followers: ins.followers,
          postsPerDay: currentPostsPerDay(jst),
        });
      }
      stats.sort((a, b) => a.date.localeCompare(b.date));
      saveAccountStats(stats);
      log(`アカウント統計を更新（フォロワー ${ins.followers} / 日次views ${ins.dailyViews.length}日分）`);
    } catch (e: any) {
      warn(`アカウント統計の取得に失敗: ${e?.message ?? e}`);
    }
  }

  // 権限エラー（threads_manage_insights 不足など）はジョブを赤くして確実に気づけるようにする
  if (permissionError) {
    error(
      `インサイトの取得権限がありません: ${permissionError}\n` +
        `THREADS_ACCESS_TOKEN を threads_manage_insights スコープ付きで再発行し、` +
        `GitHub Secrets を更新してください（手順はREADME参照）。`,
    );
    process.exit(1);
  }
  if (attempts > 0 && ok === 0) {
    error("スナップショットが1件も取得できませんでした。APIエラーの内容を確認してください。");
    process.exit(1);
  }

  log("=== メトリクス収集ルーチン完了 ===");
}

main().catch((e: any) => {
  error(e?.stack || e?.message || String(e));
  process.exit(1);
});
