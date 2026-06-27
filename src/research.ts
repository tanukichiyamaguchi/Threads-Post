import { env } from "./config";
import { researchNotes, buildContentPlan } from "./anthropic";
import { loadPostHistory } from "./state";
import { saveContentPlan } from "./content";
import { currentJst } from "./schedule";
import { log, error } from "./logger";

// 約2週に1回実行。Web検索ありでしっかりリサーチし（公式情報・クーポン・季節）、
// 今後2週間ぶんの投稿素材（クーポン情報＋アングル集）を state/content-plan.json に保存する。
// 普段の各投稿はこの素材から本文だけを安価に生成するため、投稿時のリサーチ費用は発生しない。
async function main(): Promise<void> {
  const todayLabel = new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "full",
    timeZone: "Asia/Tokyo",
  }).format(new Date());
  const now = currentJst(new Date());

  log(`=== リサーチ＆素材更新ルーチン開始 (${todayLabel}) ===`);
  env.anthropicApiKey();

  log("公式情報・クーポン・季節をWeb検索でリサーチ中（2週に1回）...");
  const notes = await researchNotes(todayLabel);
  log("リサーチメモ:\n" + notes);

  const history = loadPostHistory();
  log("投稿素材（クーポン情報＋アングル集）を作成中...");
  const { salonInfo, anglePool } = await buildContentPlan(notes, history);

  saveContentPlan({ updated: now.dateStr, salonInfo, anglePool });
  log(
    `素材を保存しました（クーポン ${salonInfo.coupons.length} 件 / アングル ${anglePool.length} 件）。`,
  );
  if (salonInfo.coupons.length === 0) {
    log(
      "※ クーポンを確認できませんでした（HotPepperがbotを弾く場合あり）。正確なクーポンは config/coupons.json に手動で入れてください。",
    );
  }

  log("=== リサーチ＆素材更新ルーチン完了 ===");
}

main().catch((e: any) => {
  error(e?.stack || e?.message || String(e));
  process.exit(1);
});
