import { env } from "./config";
import { ThreadsClient } from "./threads";
import { researchTrends, generatePost, composePostText } from "./anthropic";
import { loadPostHistory, savePostHistory } from "./state";
import { log, error } from "./logger";

async function main(): Promise<void> {
  const today = new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "full",
    timeZone: "Asia/Tokyo",
  }).format(new Date());

  log(`=== 自動投稿ルーチン開始 (${today}) ===`);

  // 必須の環境変数を早めに検証
  env.anthropicApiKey();
  const client = new ThreadsClient(env.threadsUserId(), env.threadsToken());

  log("公式情報の確認と季節・トレンドをリサーチ中...");
  const brief = await researchTrends(today);
  log("リサーチ結果:\n" + brief);

  const history = loadPostHistory();
  log("投稿文を生成中...");
  const post = await generatePost(brief, history);
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
