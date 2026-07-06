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

/** 投稿単位のインサイト実測値（lifetime累積） */
export interface MediaMetrics {
  views: number;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  shares: number;
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

      // Graph APIは恒久エラー（存在しないフィールド・権限不足など）もHTTP 500で返すことがある。
      // これらはリトライしても直らないため即座に投げる（リトライ嵐の防止）。
      // code 100=パラメータ/フィールド不正, 190=トークン無効, 10/200番台=権限不足, 3=API機能未許可
      const permanentCodes = [3, 10, 100, 190, 200, 210, 294];
      const isPermanent =
        json?.error && permanentCodes.includes(Number(json.error.code));

      // レート制限・（恒久でない）サーバーエラーは指数バックオフで再試行
      if ((res.status === 429 || res.status >= 500) && !isPermanent && attempt < 4) {
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
   * 投稿のエンゲージメント実績を取得する（Threads Media Insights API・1コール）。
   * Threadsではいいね・返信等も media フィールドではなく insights からしか取れない。
   * 全指標 lifetime 累積値。要トークンスコープ: threads_manage_insights。
   */
  async getMetrics(postId: string): Promise<MediaMetrics> {
    const id = cleanId(postId);
    const url =
      `${BASE}/${id}/insights` +
      `?metric=views,likes,replies,reposts,quotes,shares&access_token=${encodeURIComponent(this.token)}`;
    const json = await this.request(url);
    const arr = Array.isArray(json.data) ? json.data : [];
    const val = (name: string): number => {
      const m = arr.find((x: any) => x.name === name);
      const v = Number(m?.values?.[0]?.value ?? m?.total_value?.value ?? 0);
      return Number.isFinite(v) ? v : 0;
    };
    return {
      views: val("views"),
      likes: val("likes"),
      replies: val("replies"),
      reposts: val("reposts"),
      quotes: val("quotes"),
      shares: val("shares"),
    };
  }

  /**
   * アカウント全体のインサイトを取得する（User Insights API）。
   * views は日次時系列（since/until 指定・Unix秒）、followers_count は現在値のみ。
   */
  async getUserInsights(
    sinceUnix: number,
    untilUnix: number,
  ): Promise<{ dailyViews: Array<{ date: string; views: number }>; followers: number }> {
    const url =
      `${BASE}/${this.userId}/threads_insights` +
      `?metric=views,followers_count&since=${sinceUnix}&until=${untilUnix}` +
      `&access_token=${encodeURIComponent(this.token)}`;
    const json = await this.request(url);
    const arr = Array.isArray(json.data) ? json.data : [];
    const viewsMetric = arr.find((x: any) => x.name === "views");
    const dailyViews = Array.isArray(viewsMetric?.values)
      ? viewsMetric.values.map((v: any) => ({
          date: String(v.end_time ?? "").slice(0, 10),
          views: Number(v.value ?? 0) || 0,
        }))
      : [];
    const followersMetric = arr.find((x: any) => x.name === "followers_count");
    const followers =
      Number(
        followersMetric?.total_value?.value ?? followersMetric?.values?.[0]?.value ?? 0,
      ) || 0;
    return { dailyViews, followers };
  }

  /** 投稿クォータの残量を確認する（250投稿/24h・1000返信/24h）。ボリューム実験の安全弁。 */
  async getPublishingLimit(): Promise<{ used: number; total: number }> {
    const url =
      `${BASE}/${this.userId}/threads_publishing_limit` +
      `?fields=quota_usage,config&access_token=${encodeURIComponent(this.token)}`;
    const json = await this.request(url);
    const d = Array.isArray(json.data) ? json.data[0] : json.data;
    return {
      used: Number(d?.quota_usage ?? 0) || 0,
      total: Number(d?.config?.quota_total ?? 250) || 250,
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
