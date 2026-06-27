import { env } from "./config";
import { ThreadsClient } from "./threads";
import { log, warn, error } from "./logger";
import sodium from "libsodium-wrappers";

/** GitHub Actions のリポジトリシークレットを更新する（libsodiumで暗号化） */
async function updateRepoSecret(
  name: string,
  value: string,
  repo: string,
  pat: string,
): Promise<void> {
  await sodium.ready;
  const headers = {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const keyRes = await fetch(
    `https://api.github.com/repos/${repo}/actions/secrets/public-key`,
    { headers },
  );
  if (!keyRes.ok) {
    throw new Error(`公開鍵の取得に失敗: ${keyRes.status} ${await keyRes.text()}`);
  }
  const { key, key_id } = (await keyRes.json()) as { key: string; key_id: string };

  const binKey = sodium.from_base64(key, sodium.base64_variants.ORIGINAL);
  const encrypted = sodium.crypto_box_seal(sodium.from_string(value), binKey);
  const encrypted_value = sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);

  const put = await fetch(
    `https://api.github.com/repos/${repo}/actions/secrets/${name}`,
    {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ encrypted_value, key_id }),
    },
  );
  if (!put.ok) {
    throw new Error(`シークレット更新に失敗: ${put.status} ${await put.text()}`);
  }
}

async function main(): Promise<void> {
  log("=== Threadsトークン更新ルーチン開始 ===");
  const client = new ThreadsClient(env.threadsUserId(), env.threadsToken());
  const { token, expiresIn } = await client.refreshToken();
  log(`トークンを更新しました（有効期限: 約${Math.round(expiresIn / 86400)}日）`);

  const pat = (process.env.GH_PAT || "").trim();
  const repo = (process.env.GITHUB_REPOSITORY || "").trim();
  if (pat && repo) {
    await updateRepoSecret("THREADS_ACCESS_TOKEN", token, repo, pat);
    log(`GitHubシークレット THREADS_ACCESS_TOKEN を更新しました (${repo})`);
  } else {
    warn(
      "GH_PAT または GITHUB_REPOSITORY が未設定のため、シークレットの自動更新をスキップしました。" +
        "新しいトークンを手動で設定してください（トークンはセキュリティのためログに出力していません）。",
    );
  }
  log("=== Threadsトークン更新ルーチン完了 ===");
}

main().catch((e: any) => {
  error(e?.stack || e?.message || String(e));
  process.exit(1);
});
