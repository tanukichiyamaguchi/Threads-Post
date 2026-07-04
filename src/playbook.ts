import { env } from "./config";
import { researchViralPlaybook, buildViralPlaybook } from "./anthropic";
import { saveViralPlaybook } from "./state";
import { currentJst } from "./schedule";
import { log, error } from "./logger";

// 一度だけ（必要に応じて手動で）実行。
// Web検索で「バズる投稿の型」を詳しく調査し、静的なプレイブック（state/viral-playbook.json）を作る。
// このプレイブックは頻繁には更新せず、各投稿の生成時に注入して使う。
// 毎日の話題や自店の実績分析は improve ルーチンが別途担当する。
async function main(): Promise<void> {
  const todayLabel = new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "full",
    timeZone: "Asia/Tokyo",
  }).format(new Date());
  const now = currentJst(new Date());

  log(`=== バズ・プレイブック作成ルーチン開始 (${todayLabel}) ===`);
  env.anthropicApiKey();

  log("バズる投稿の型をWeb検索で詳しく調査中（一度きりの詳細調査）...");
  const notes = await researchViralPlaybook(todayLabel);
  log("調査メモ:\n" + notes);

  log("プレイブック（型・切り口）を整理中...");
  const { playbook, viralAngles } = await buildViralPlaybook(notes);

  saveViralPlaybook({ updated: now.dateStr, playbook, viralAngles });
  log(`プレイブックを保存しました（型 ${playbook.length} / 切り口 ${viralAngles.length}）。`);

  log("=== バズ・プレイブック作成ルーチン完了 ===");
}

main().catch((e: any) => {
  error(e?.stack || e?.message || String(e));
  process.exit(1);
});
