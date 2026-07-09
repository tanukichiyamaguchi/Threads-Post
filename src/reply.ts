import { env } from "./config";
import { ThreadsClient } from "./threads";
import { generateReply } from "./anthropic";
import { loadRepliedIds, saveRepliedIds, loadRepliedUsers, saveRepliedUsers } from "./state";
import { log, warn, error } from "./logger";

const MAX_REPLIES_PER_RUN = 25;
const POSTS_TO_SCAN = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  log("=== AI返信ルーチン開始 ===");

  env.anthropicApiKey();
  const client = new ThreadsClient(env.threadsUserId(), env.threadsToken());
  const myUsername = env.threadsUsername().toLowerCase();
  if (!myUsername) {
    warn("THREADS_USERNAME が未設定です。自分のコメントに返信してしまう恐れがあります。");
  }

  const replied = loadRepliedIds();
  const repliedUsers = loadRepliedUsers(); // 「投稿×ユーザー」単位の返信済み（往復ラリー防止）
  const posts = await client.listOwnPosts(POSTS_TO_SCAN);
  log(`チェック対象の投稿: ${posts.length}件`);

  let count = 0;
  for (const p of posts) {
    if (count >= MAX_REPLIES_PER_RUN) break;

    let comments;
    try {
      comments = await client.getConversation(p.id);
    } catch (e: any) {
      warn(`会話取得に失敗 (${p.id}): ${e.message}`);
      continue;
    }

    for (const c of comments) {
      if (count >= MAX_REPLIES_PER_RUN) break;
      const id = c.id;
      if (!id) continue;
      if (id === p.id) continue; // 元投稿そのものはスキップ
      if (replied.has(id)) continue;

      const user = (c.username || "").toLowerCase();
      const text = (c.text || "").trim();

      // 自分のコメント・空コメントは処理済み扱いにしてスキップ
      if (myUsername && user === myUsername) {
        replied.add(id);
        continue;
      }
      if (!text) {
        replied.add(id);
        continue;
      }

      // 同じ投稿の会話では一人につき1回まで（往復ラリーを止める）。
      // ユーザー名が取れないコメントはコメントID単位の重複防止のみ。
      const userKey = user ? `${p.id}:${user}` : "";
      if (userKey && repliedUsers.has(userKey)) {
        log(`@${user} には この投稿で返信済みのためスキップ`);
        replied.add(id);
        continue;
      }

      log(`新着コメント @${user}: 「${text}」`);
      try {
        const reply = await generateReply(text);
        if (reply) {
          const replyId = await client.createPost({ text: reply, replyToId: id });
          log(`✓ 返信成功: 「${reply}」 (返信ID: ${replyId})`);
          // 実際に返信できたときだけ「この投稿でこの人へは返信済み」と記録する
          if (userKey) {
            repliedUsers.add(userKey);
            saveRepliedUsers(repliedUsers);
          }
        } else {
          warn("返信の生成に失敗しました");
        }
        replied.add(id);
        count++;
        saveRepliedIds(replied); // 都度保存（途中で落ちても再返信しない）
        await sleep(5000);
      } catch (e: any) {
        warn(`返信に失敗 (${id}): ${e.message}`);
        replied.add(id);
        saveRepliedIds(replied);
      }
    }
    await sleep(1500);
  }

  saveRepliedIds(replied);
  log(`=== AI返信ルーチン完了 (返信 ${count}件) ===`);
}

main().catch((e: any) => {
  error(e?.stack || e?.message || String(e));
  process.exit(1);
});
