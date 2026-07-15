import { env } from "./config";
import { ThreadsClient, isAuthError, isDeadObjectError } from "./threads";
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
  let deadCount = 0; // 削除済み・非対応など、その投稿だけの恒久エラー
  let otherFail = 0; // 認証でも削除でもない予期しない失敗
  let authProblem: string | null = null; // トークン/スコープ自体の疑い

  for (const h of history) {
    if (!h.postId) continue;
    if (attempts >= MAX_FETCH_PER_RUN) break;
    const postedAt = Date.parse(h.date);
    if (!Number.isFinite(postedAt)) continue;
    const age = now - postedAt;

    const existing = store[h.postId];
    if (existing?.dead) continue; // 取得不可と分かっている投稿は再試行しない
    const entry = existing ?? { postedAt: h.date };
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
      if (isDeadObjectError(msg)) {
        // 投稿が削除された/存在しない/インサイト非対応。以後スキップして再試行しない。
        entry.dead = { reason: msg.slice(0, 160), at: new Date(now).toISOString() };
        store[h.postId] = entry;
        deadCount++;
        warn(`投稿 ${h.postId} は取得不可（削除済み・非対応など）。以後スキップします。`);
      } else if (isAuthError(msg)) {
        authProblem = msg;
        warn(`インサイト取得で認証系エラー: ${msg}`);
        break; // 認証系なら全件同じ失敗になるため打ち切る
      } else {
        otherFail++;
        warn(`スナップショット取得に失敗 (${h.postId}): ${msg}`);
      }
    }
  }
  saveMetricsStore(store);
  log(
    `スナップショット: 取得${ok} / 試行${attempts}` +
      `（新規スキップ ${deadCount} / その他失敗 ${otherFail}）`,
  );

  // --- アカウント全体の日次統計（1日1回だけ更新） ---
  // ここが取得できればトークンに threads_manage_insights スコープがある決定的な証拠になる。
  let accountOk = false;
  const stats = loadAccountStats();
  const todayEntry = stats.find((s) => s.date === jst.dateStr);
  if (!todayEntry || todayEntry.accountViews === undefined) {
    try {
      const until = Math.floor(now / 1000);
      const since = until - 3 * 24 * 3600; // 直近3日ぶん（取りこぼし補完）
      const ins = await client.getUserInsights(since, until);
      accountOk = true;
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
      const msg = e?.message ?? String(e);
      if (isAuthError(msg)) authProblem = msg;
      warn(`アカウント統計の取得に失敗: ${msg}`);
    }
  } else {
    accountOk = true; // 本日ぶんは取得済み（この起動では叩かない）
  }

  // --- 終了判定 ---
  // アカウントインサイトが取れていればトークン/スコープは有効。個別投稿の「削除済み等」は正常な事象。
  if (!accountOk && authProblem) {
    error(
      `インサイトの取得に失敗しました（トークン/スコープの問題の可能性）: ${authProblem}\n` +
        `THREADS_ACCESS_TOKEN を threads_manage_insights スコープ付きで再発行し、` +
        `GitHub Secrets を更新してください（手順はREADME参照）。`,
    );
    process.exit(1);
  }
  if (accountOk && authProblem) {
    warn(
      "一部投稿で認証系エラーが出ましたが、アカウントインサイトは取得できています（トークンは有効）。" +
        "該当投稿固有の問題の可能性が高く、ジョブは正常終了します。",
    );
  }
  // 削除済みでも認証でもない「予期しない失敗」ばかりで1件も取れないときだけ赤くする
  if (ok === 0 && otherFail > 0 && deadCount === 0) {
    error(
      "スナップショットが1件も取得できませんでした（削除済み以外の予期しないエラー）。" +
        "APIエラーの内容を確認してください。",
    );
    process.exit(1);
  }

  log("=== メトリクス収集ルーチン完了 ===");
}

main().catch((e: any) => {
  error(e?.stack || e?.message || String(e));
  process.exit(1);
});
