import { env } from "./config";
import { ThreadsClient } from "./threads";
import { generatePost, composePostText } from "./anthropic";
import {
  loadPostHistory,
  savePostHistory,
  loadScheduleState,
  saveScheduleState,
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

  // forceでない場合は「その日の投稿予定スロット」が来たときだけ投稿する
  let slotIndex = now.minuteOfDay; // force時のばらつき用シード
  let includeCta = force; // 予約導線を入れるか（手動投稿は確認のため入れる）
  if (!force) {
    const slots = computeDailySlots(now.seed);
    let st = loadScheduleState();
    if (st.date !== now.dateStr) st = { date: now.dateStr, fired: [] };

    let dueIndex = -1;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i] <= now.minuteOfDay && !st.fired.includes(i)) {
        dueIndex = i;
        break;
      }
    }
    if (dueIndex === -1) {
      const next = slots.find((s) => s > now.minuteOfDay);
      log(
        `現在 ${now.hhmm} JST は投稿予定時刻ではありません` +
          `（本日 ${slots.length} 投稿予定 / 残り ${slots.length - st.fired.length} 件 / ` +
          `次回 ${next !== undefined ? fmtMin(next) : "なし"}）。`,
      );
      return;
    }

    // 先にスロットを消化して保存（投稿失敗時もコミットされ二重投稿を防ぐ）
    st.fired.push(dueIndex);
    saveScheduleState(st);
    slotIndex = dueIndex;
    // 予約導線は1日1回だけ（通算 ctaOrdinal 件目の投稿）
    includeCta = st.fired.length === ctaOrdinal(now.seed);
    log(
      `投稿スロット ${dueIndex + 1}/${slots.length}（予定 ${fmtMin(slots[dueIndex])} JST / ` +
        `本日${st.fired.length}件目${includeCta ? " ★予約CTAあり" : ""}）を実行します。`,
    );
  } else {
    log("FORCE_POST 指定: スケジュールを無視して今すぐ投稿します。");
  }

  const targetChars = pickTargetChars(now.seed, slotIndex);
  log(`本文の目安文字数: ${targetChars}文字`);

  env.anthropicApiKey();
  const client = new ThreadsClient(env.threadsUserId(), env.threadsToken());

  // 素材（2週に1回更新）から、このスロットのアングルと（必要なら）クーポンを選ぶ
  const plan = loadContentPlan();
  const angle = pickAngle(plan, now.seed, slotIndex);
  const coupon = pickCoupon(plan, angle, now.seed, slotIndex);
  log(
    `テーマ: [${angle.category}] ${angle.angle}` +
      (coupon ? ` / クーポン: ${coupon.name}（${coupon.price}）` : ""),
  );

  const mentionKamata = shouldMentionKamata(now.seed, slotIndex);

  const history = loadPostHistory();
  log("投稿文を生成中...");
  const post = await generatePost(
    angle,
    coupon,
    history,
    targetChars,
    includeCta,
    mentionKamata,
    plan.salonInfo,
  );
  const finalText = composePostText(post);
  log(`生成された投稿 (${finalText.length}文字 / テーマ: ${post.topic}):\n${finalText}`);

  const id = await client.createPost({ text: finalText });
  log(`投稿成功! ID: ${id}`);

  history.push({
    date: new Date().toISOString(),
    topic: post.topic,
    text: finalText,
    postId: id,
  });
  savePostHistory(history);

  log("=== 自動投稿ルーチン完了 ===");
}

main().catch((e: any) => {
  error(e?.stack || e?.message || String(e));
  process.exit(1);
});
