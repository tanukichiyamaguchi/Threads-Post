import Anthropic from "@anthropic-ai/sdk";
import { brand } from "./config";
import type { PostHistoryItem } from "./state";

const MODEL = "claude-sonnet-4-6";

let _client: Anthropic | null = null;
function client(): Anthropic {
  // ANTHROPIC_API_KEY は環境変数から自動的に読み込まれる
  if (!_client) _client = new Anthropic();
  return _client;
}

function textOf(content: any[]): string {
  return content
    .filter((b) => b && b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export interface GeneratedPost {
  topic: string;
  text: string;
  hashtags: string[];
}

/**
 * Web検索で「今の季節・流行・話題」を調べ、集客投稿に使える切り口をまとめる。
 */
export async function researchTrends(today: string): Promise<string> {
  const system =
    "あなたは日本の美容業界に詳しい集客マーケティングのリサーチャーです。" +
    "まず指定された店舗の公式情報を確認し、その上で集客SNS投稿に役立つ" +
    "「今この時期ならではの切り口」を、信頼できる最新情報をもとにまとめます。";

  const user = [
    `本日: ${today}（日本・東京）。`,
    `店舗: ${brand.name}（${brand.area}の${brand.businessType}）。`,
    `公式ページ（最優先の事実ソース）: ${brand.sourceUrl}`,
    ``,
    `# 手順1: 当店の正確な情報を確認`,
    `公式ページ ${brand.sourceUrl} を web_fetch で取得し、取得できない（ブロック等）場合は`,
    `「${brand.name} 蒲田 まつげパーマ 眉毛WAX」等で web_search して、`,
    `当店の実際のメニュー・コンセプト・強み・特徴を把握してください。`,
    `※当店はまつげパーマと眉毛WAXの専門店です。まつげエクステ（まつエク）は提供していません。`,
    ``,
    `# 手順2: 今の季節・トレンドを調査`,
    `web_search で次を確認してください。`,
    `- 季節・天候・気温の話題（今の時期ならではの悩みや気分）`,
    `- 直近〜今後2週間程度のイベント／行事／連休／記念日`,
    `- まつげパーマ・眉毛・アイメイク関連の流行やトレンド`,
    `- 蒲田・大田区エリアならではの話題があれば`,
    ``,
    `# 出力`,
    `次の2部構成でまとめてください（投稿文そのものは書かない）。`,
    `(A) 確認した当店の情報の要点（メニュー・特徴・強み・アクセス等。確認できた事実のみ）`,
    `(B) 今の季節・トレンドの切り口を5〜8個（各1〜2行で「切り口＋なぜ今その人に刺さるか」）`,
  ].join("\n");

  const stream = client().messages.stream({
    model: MODEL,
    max_tokens: 6000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    tools: [
      {
        type: "web_search_20260209",
        name: "web_search",
        max_uses: 6,
        user_location: {
          type: "approximate",
          country: "JP",
          region: "Tokyo",
          city: "Tokyo",
          timezone: "Asia/Tokyo",
        },
      },
      {
        type: "web_fetch_20260209",
        name: "web_fetch",
        max_uses: 3,
        allowed_domains: ["beauty.hotpepper.jp"],
      },
    ],
    system,
    messages: [{ role: "user", content: user }],
  } as any);

  const msg = await stream.finalMessage();
  const text = textOf((msg as any).content);
  return text || "（トレンド情報を取得できませんでした。一般的な季節感で作成します。）";
}

const POST_SCHEMA = {
  type: "object",
  properties: {
    topic: {
      type: "string",
      description: "この投稿の季節／トレンドのテーマ（短い日本語）",
    },
    text: {
      type: "string",
      description:
        "Threads投稿の本文。ハッシュタグは含めない。改行可。指定された目安文字数（30〜120字）に近づける。",
    },
    hashtags: {
      type: "array",
      items: { type: "string" },
      description: "#を付けないハッシュタグ語のみ。ちょうど1個だけ（最も効果的なものを1つ）。",
    },
  },
  required: ["topic", "text", "hashtags"],
  additionalProperties: false,
};

/**
 * トレンド情報と過去投稿をもとに、集客投稿を1つ生成する。
 */
export async function generatePost(
  trendBrief: string,
  history: PostHistoryItem[],
  targetChars: number,
): Promise<GeneratedPost> {
  const recent =
    history
      .slice(-10)
      .map((h) => `- (${h.date.slice(0, 10)}) ${h.text.replace(/\n/g, " ").slice(0, 80)}`)
      .join("\n") || "（過去投稿はまだありません）";

  const user = [
    `# 当店情報と今の季節・トレンド（リサーチ結果）`,
    trendBrief,
    ``,
    `# 直近の自分の投稿（内容や言い回しの繰り返しを避けること）`,
    recent,
    ``,
    `# 文字数の目安`,
    `本文（ハッシュタグを除く）は約${targetChars}文字。30〜120字の範囲で、この目安に近づけてください。短い指定なら一言ぎゅっと、長い指定ならしっかり描写、とメリハリをつける。`,
    ``,
    `# 依頼`,
    `上記の季節・トレンドを自然に取り入れ、今この瞬間に最も集客・予約につながるThreads投稿を1つ作成してください。`,
  ].join("\n");

  const res = await client().messages.create({
    model: MODEL,
    max_tokens: 3000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: POST_SCHEMA },
    },
    system: buildPostSystemPrompt(),
    messages: [{ role: "user", content: user }],
  } as any);

  const raw = textOf((res as any).content);
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`投稿生成結果のJSON解析に失敗しました: ${raw.slice(0, 200)}`);
  }
  return {
    topic: String(data.topic ?? ""),
    text: String(data.text ?? ""),
    hashtags: Array.isArray(data.hashtags) ? data.hashtags.map(String) : [],
  };
}

/** 本文とハッシュタグを結合し、最終的な投稿テキストを作る */
export function composePostText(post: GeneratedPost): string {
  const tags = (post.hashtags ?? [])
    .slice(0, 1)
    .map((h) => "#" + String(h).replace(/^#/, "").trim().replace(/\s+/g, ""))
    .filter((s) => s.length > 1);
  const text = post.text.trim();
  const tagLine = tags.join(" ");
  let full = tagLine ? `${text}\n\n${tagLine}` : text;
  if (full.length > brand.postRules.maxLength) {
    full = text.length > brand.postRules.maxLength ? text.slice(0, brand.postRules.maxLength - 1) + "…" : text;
  }
  return full;
}

/** コメントへのAI返信を生成する */
export async function generateReply(commentText: string): Promise<string | null> {
  const res = await client().messages.create({
    model: MODEL,
    max_tokens: 300,
    output_config: { effort: "low" },
    system: buildReplySystemPrompt(),
    messages: [
      {
        role: "user",
        content:
          `次のコメントに、お店の広報として自然に返信してください。返信本文のみを出力してください。\n\n` +
          `コメント:「${commentText}」`,
      },
    ],
  } as any);

  const text = textOf((res as any).content)
    .replace(/\s*\n\s*/g, " ")
    .trim();
  return text || null;
}

function buildPostSystemPrompt(): string {
  const r = brand.postRules;
  return [
    `あなたは「${brand.name}」（${brand.area}の${brand.businessType}）の${brand.persona}です。`,
    `Threads（テキスト中心のSNS）で、見込み客の興味を引き来店・予約につなげる集客投稿を作成します。`,
    ``,
    `## ターゲット`,
    brand.audience,
    `## トーン`,
    brand.toneOfVoice,
    `## 提供メニュー`,
    brand.services.map((s) => `- ${s}`).join("\n"),
    `（公式情報: ${brand.sourceUrl}）`,
    ``,
    `## 投稿の条件`,
    `- リサーチ結果に当店の公式情報（メニュー・特徴など）が含まれる場合は、それを正確な事実として最優先で使う。事実が確認できない内容は断定しない。`,
    `- 日本語。本文の長さはリクエストで指定された目安文字数（${r.targetLength}）に合わせ、毎回ばらつかせる。最大${r.maxLength}文字。`,
    `- 冒頭の1行で必ず読み手の興味・共感を引く（フックを作る）。`,
    `- 今の季節・トレンドを自然に絡め、「今行きたい／予約したい」と思わせる。`,
    `- 共感 → 価値（メニューの魅力やお悩み解決）→ 行動喚起(CTA) の流れを意識する。`,
    `- CTAは押し付けず自然に: ${brand.cta}`,
    `- 絵文字は${r.emoji}。`,
    `- ハッシュタグは本文に含めず hashtags 配列に${r.hashtagCount}入れる（地域名＋メニュー名を含めると効果的。例: ${r.baseHashtags.join(
      ", ",
    )}）。`,
    `- AIが書いたと分からない、人間味のある自然な文章にする。テンプレ感・宣伝臭は避ける。`,
    `- ${brand.compliance}`,
    `- 直近の投稿と内容や言い回しが被らないようにする。`,
    ``,
    `## 禁止事項（厳守）`,
    ...brand.prohibitions.map((p) => `- ${p}`),
  ].join("\n");
}

function buildReplySystemPrompt(): string {
  const r = brand.replyRules;
  return [
    `あなたは「${brand.name}」の${brand.persona}です。`,
    `お店の投稿に来たコメントへ、フレンドリーに短く返信します。`,
    ``,
    `## ルール`,
    `- ${r.style}`,
    `- 共感を示し、自然に会話が続くようにする。`,
    `- 絵文字を${r.emoji}使う。`,
    `- ${r.maxLength}文字以内。`,
    `- 絶対にAIだと分からないようにする。定型文っぽさを避ける。`,
    `- 返信本文のみを出力する（説明や引用符は不要）。`,
    ``,
    `## 禁止事項（厳守）`,
    ...brand.prohibitions.map((p) => `- ${p}`),
  ].join("\n");
}
