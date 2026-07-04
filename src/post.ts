import { env, brand } from "./config";
import { ThreadsClient } from "./threads";
import { generatePost, composePostText } from "./anthropic";
import {
  loadPostHistory,
  savePostHistory,
  loadScheduleState,
  saveScheduleState,
  loadLearnings,
  loadViralPlaybook,
} from "./state";
import { loadContentPlan, pickAngle, pickCoupon } from "./content";
import {
  computeDailySlots,
  currentJst,
  fmtMin,
  pickTargetChars,
  ctaOrdinal,
  shouldMentionKamata,
} from "./schedule";
import { log, error } from "./logger";

// GitHubのスケジュール実行は間引かれ、1日に数回しか起動しないことがある。
// そのため「起動時に、予定時刻を過ぎた未投稿スロットをまとめて投稿」して1日の目標件数を確保する。
// 1回の起動で投稿しすぎないよう上限を設ける（残りは次回起動で消化）。
const MAX_POSTS_PER_RUN = 15;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const todayLabel = new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "full",
    timeZone: "Asia/Tokyo",
  }).format(new Date());
  log(`=== 自動投稿ルーチン開始 (${todayLabel}) ===`);

  const now = currentJst(new Date());
  const force = ["1", "true", "yes"].includes(
    (process.env.FORCE_POST || "").trim().toLowerCase(),
  );

  // 認知モード（awareness）では店舗誘導・予約CTA・クーポンを出さず、バズ×蒲田×美容に徹する
  const awareness = (brand.postMode ?? "conversion") === "awareness";

  env.anthropicApiKey();
  const client = new ThreadsClient(env.threadsUserId(), env.threadsToken());

  // 共通素材を一度だけ読み込む
  const plan = loadContentPlan(); // 投稿アングル集＋店舗情報（2週に1回更新）
  const playbook = loadViralPlaybook(); // バズる投稿の型（静的）
  const learnings = loadLearnings(); // 毎日の学習知見（実績分析＋本日の話題）
  const history = loadPostHistory();

  /** 指定スロットの投稿を1件生成して公開し、履歴に保存する */
  async function postForSlot(slotIndex: number, includeCta: boolean): Promise<void> {
    const targetChars = pickTargetChars(now.seed, slotIndex);
    const angle = pickAngle(plan, now.seed, slotIndex);
    const coupon = awareness ? null : pickCoupon(plan, angle, now.seed, slotIndex);
    const mentionKamata = shouldMentionKamata(now.seed, slotIndex);
    log(
      `テーマ: [${angle.category}] ${angle.angle}` +
        (coupon ? ` / クーポン: ${coupon.name}（${coupon.price}）` : "") +
        (awareness ? " / 認知モード" : "") +
        ` / 目安${targetChars}字`,
    );

    const post = await generatePost(
      angle,
      coupon,
      history,
      targetChars,
      includeCta,
      mentionKamata,
      plan.salonInfo,
      learnings,
      playbook,
    );
    const finalText = composePostText(post);
    log(`生成 (${finalText.length}文字 / ${post.topic}):\n${finalText}`);

    const id = await client.createPost({ text: finalText });
    log(`投稿成功! ID: ${id}`);

    history.push({
      date: new Date().toISOString(),
      topic: post.topic,
      text: finalText,
      postId: id,
    });
    savePostHistory(history);
  }

  // --- 手動（force）: スケジュールを無視して今すぐ1件投稿 ---
  if (force) {
    log("FORCE_POST 指定: スケジュールを無視して今すぐ投稿します。");
    await postForSlot(now.minuteOfDay, !awareness);
    log("=== 自動投稿ルーチン完了（force 1件）===");
    return;
  }

  // --- スケジュール: 予定時刻を過ぎた未投稿スロットをまとめて投稿 ---
  const slots = computeDailySlots(now.seed);
  let st = loadScheduleState();
  if (st.date !== now.dateStr) st = { date: now.dateStr, fired: [] };

  const due = slots
    .map((min, i) => ({ min, i }))
    .filter(({ min, i }) => min <= now.minuteOfDay && !st.fired.includes(i))
    .map(({ i }) => i);

  if (due.length === 0) {
    const next = slots.find((s) => s > now.minuteOfDay);
    log(
      `現在 ${now.hhmm} JST は投稿予定時刻ではありません` +
        `（本日 ${slots.length} 投稿予定 / 残り ${slots.length - st.fired.length} 件 / ` +
        `次回 ${next !== undefined ? fmtMin(next) : "なし"}）。`,
    );
    return;
  }

  const batch = due.slice(0, MAX_POSTS_PER_RUN);
  log(
    `未投稿の予定スロット ${due.length} 件を検出。今回は ${batch.length} 件投稿します` +
      `（1回の上限 ${MAX_POSTS_PER_RUN} 件 / 残りは次回起動で消化）。`,
  );

  let done = 0;
  for (const slotIndex of batch) {
    // 先にスロットを消化して保存（投稿失敗時もコミットされ二重投稿を防ぐ）
    st.fired.push(slotIndex);
    saveScheduleState(st);
    // 予約導線は1日1回だけ（通算 ctaOrdinal 件目）。認知モードでは入れない。
    const includeCta = !awareness && st.fired.length === ctaOrdinal(now.seed);
    log(
      `-- スロット ${slotIndex + 1}/${slots.length}（予定 ${fmtMin(slots[slotIndex])} JST / ` +
        `本日${st.fired.length}件目${includeCta ? " ★予約CTAあり" : ""}）`,
    );
    try {
      await postForSlot(slotIndex, includeCta);
      done++;
    } catch (e: any) {
      // 1件失敗しても残りは続行（該当スロットは消化済みなので再投稿されない）
      error(`スロット ${slotIndex + 1} の投稿に失敗: ${e?.message || e}`);
    }
    if (slotIndex !== batch[batch.length - 1]) await sleep(3000);
  }

  log(`=== 自動投稿ルーチン完了（${done}/${batch.length} 件投稿）===`);
}

main().catch((e: any) => {
  error(e?.stack || e?.message || String(e));
  process.exit(1);
});
