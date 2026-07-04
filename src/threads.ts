import { warn } from "./logger";

const BASE = "https://graph.threads.net/v1.0";

export interface ThreadsComment {
  id: string;
  text?: string;
  username?: string;
  timestamp?: string;
}

export interface OwnPost {
  id: string;
  text?: string;
  timestamp?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function cleanId(id: string): string {
  return String(id)
    .replace(/^'+|'+$/g, "")
    .trim();
}

/**
 * Threads（Meta）Graph API クライアント。
 * 認証はアクセストークン（環境変数）で行う。
 */
export class ThreadsClient {
  constructor(
    private readonly userId: string,
    private readonly token: string,
  ) {}

  private async request(
    url: string,
    init?: RequestInit,
    attempt = 0,
  ): Promise<any> {
    try {
      const res = await fetch(url, init);
      const body = await res.text();
      let json: any = {};
      try {
        json = body ? JSON.parse(body) : {};
      } catch {
        json = { raw: body };
      }

      // レート制限・サーバーエラーは指数バックオフで再試行
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const wait = (attempt + 1) * 5000;
        warn(`Threads API ${res.status}。${wait / 1000}s 待機して再試行 (${attempt + 1}/4)`);
        await sleep(wait);
        return this.request(url, init, attempt + 1);
      }
      if (json && json.error) {
        throw new Error(
          `Threads APIエラー: ${json.error.message} (code ${json.error.code ?? res.status})`,
        );
      }
      if (!res.ok) {
        throw new Error(`Threads HTTPエラー: ${res.status} ${body.slice(0, 200)}`);
      }
      return json;
    } catch (e: any) {
      const networkish =
        e?.name === "TypeError" || /network|fetch failed|ECONN|ETIMEDOUT/i.test(e?.message ?? "");
      if (networkish && attempt < 4) {
        const wait = (attempt + 1) * 2000;
        warn(`通信エラー (${e.message})。${wait / 1000}s 待機して再試行`);
        await sleep(wait);
        return this.request(url, init, attempt + 1);
      }
      throw e;
    }
  }

  /** 投稿（または返信）を作成して公開し、公開された投稿IDを返す */
  async createPost(opts: { text: string; imageUrl?: string; replyToId?: string }): Promise<string> {
    const hasImage = !!(opts.imageUrl && opts.imageUrl.trim());

    const containerParams = new URLSearchParams();
    containerParams.set("access_token", this.token);
    containerParams.set("text", opts.text);
    containerParams.set("media_type", hasImage ? "IMAGE" : "TEXT");
    if (hasImage) containerParams.set("image_url", opts.imageUrl!.trim());
    if (opts.replyToId) containerParams.set("reply_to_id", cleanId(opts.replyToId));

    const container = await this.request(`${BASE}/${this.userId}/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: containerParams,
    });
    if (!container.id) throw new Error("コンテナIDの取得に失敗しました");

    // メディア処理のため公開前に少し待機（画像は長め）
    await sleep(hasImage ? 8000 : 2500);

    const publishParams = new URLSearchParams();
    publishParams.set("access_token", this.token);
    publishParams.set("creation_id", container.id);

    const published = await this.request(`${BASE}/${this.userId}/threads_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: publishParams,
    });
    if (!published.id) throw new Error("投稿IDの取得に失敗しました");
    return published.id as string;
  }

  /** 自分の最近の投稿を取得 */
  async listOwnPosts(limit = 25): Promise<OwnPost[]> {
    const url =
      `${BASE}/${this.userId}/threads` +
      `?fields=id,text,timestamp&limit=${limit}&access_token=${encodeURIComponent(this.token)}`;
    const json = await this.request(url);
    return Array.isArray(json.data) ? json.data : [];
  }

  /**
   * 投稿のエンゲージメント実績を取得する。
   * いいね・返信・リポスト・引用は media フィールドから、閲覧数(views)は insights から。
   */
  async getMetrics(postId: string): Promise<{
    likes: number;
    replies: number;
    reposts: number;
    quotes: number;
    views: number;
  }> {
    const id = cleanId(postId);
    const fieldsUrl =
      `${BASE}/${id}` +
      `?fields=like_count,reply_count,repost_count,quote_count&access_token=${encodeURIComponent(this.token)}`;
    const f = await this.request(fieldsUrl);

    let views = 0;
    try {
      const insUrl =
        `${BASE}/${id}/insights?metric=views&access_token=${encodeURIComponent(this.token)}`;
      const ins = await this.request(insUrl);
      const arr = Array.isArray(ins.data) ? ins.data : [];
      const v = arr.find((x: any) => x.name === "views");
      views = Number(v?.values?.[0]?.value ?? v?.total_value?.value ?? 0);
    } catch {
      /* insights が取得できない場合は views=0 のまま続行 */
    }

    return {
      likes: Number(f.like_count ?? 0),
      replies: Number(f.reply_count ?? 0),
      reposts: Number(f.repost_count ?? 0),
      quotes: Number(f.quote_count ?? 0),
      views: Number.isFinite(views) ? views : 0,
    };
  }

  /** 投稿に紐づく会話（他ユーザーからの返信を含む）を取得 */
  async getConversation(postId: string): Promise<ThreadsComment[]> {
    const url =
      `${BASE}/${postId}/conversation` +
      `?fields=id,text,username,timestamp&access_token=${encodeURIComponent(this.token)}`;
    const json = await this.request(url);
    return Array.isArray(json.data) ? json.data : [];
  }

  /** 長期アクセストークンを更新する */
  async refreshToken(): Promise<{ token: string; expiresIn: number }> {
    const url =
      "https://graph.threads.net/refresh_access_token" +
      `?grant_type=th_refresh_token&access_token=${encodeURIComponent(this.token)}`;
    const json = await this.request(url);
    if (!json.access_token) {
      throw new Error(`トークン更新に失敗しました: ${JSON.stringify(json).slice(0, 200)}`);
    }
    return { token: json.access_token, expiresIn: json.expires_in ?? 0 };
  }
}
