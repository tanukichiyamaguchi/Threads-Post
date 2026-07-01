import Anthropic from "@anthropic-ai/sdk";
import { brand } from "./config";
import type { PostHistoryItem } from "./state";
import type { AngleItem, Coupon, ContentPlan, SalonInfo } from "./content";

const MODEL = "claude-sonnet-5";

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
}

// ==========================================
// 2週に1回: 公式情報・クーポン・季節をリサーチ（Web検索あり・effort高）
// ==========================================
export async function researchNotes(today: string): Promise<string> {
  const system =
    "あなたは日本の美容業界に詳しい集客マーケティングのリサーチャーです。" +
    "指定店舗の公式情報（メニュー・クーポン・価格）を確認し、今後2週間の集客投稿に役立つ事実と季節の切り口を整理します。";

  const user = [
    `本日: ${today}（日本・東京）。`,
    `店舗: ${brand.name}（${brand.area}の${brand.businessType}）。公式: ${brand.sourceUrl}`,
    `※当店はまつげパーマと眉毛WAXの専門店。まつげエクステ（まつエク）は扱わない。`,
    ``,
    `# 手順1: 公式情報・クーポンの確認（重要・粘り強く）`,
    `公式ページ ${brand.sourceUrl} を web_fetch で取得してください。ブロック等で取れない場合は、`,
    `「${brand.name} クーポン」「${brand.name} 料金」「slnH000797013 クーポン」「蒲田 まつげパーマ クーポン」等で web_search し、`,
    `検索結果やまとめ・キャッシュから当店の「メニュー」「クーポンの内容と価格（上位5件まで）」「コンセプト・特徴」「アクセス・営業」を確認してください。`,
    `※クーポンの価格・内容は、公式ページで直接確認できたもの、または複数の信頼できるソースで一致したものだけを正確に書き出す。検索スニペットだけで価格が食い違う場合や確認できない場合は「確認できず」とし、絶対に創作・推測しない（誤った価格を出さない）。`,
    ``,
    `# 手順2: 今後2週間の季節・話題`,
    `web_search で、今の季節・天候・直近のイベントなど、来店動機につながる切り口を5〜8個確認してください（深掘りは不要）。`,
    ``,
    `# 手順3: 蒲田のローカル情報（重要）`,
    `蒲田（大田区）のローカルな常識・あるある・名所（餃子／商店街／銭湯など）、街の雰囲気、`,
    `そして蒲田に住む・通う女性の生活感（共働き・子育て・忙しさ・コスパ志向・自分時間など）を集めてください。`,
    `最新情報でなくてよく、地元の人が「わかる」と感じる定番ネタでOK。失礼なステレオタイプは避ける。`,
    ``,
    `# 出力`,
    `(A) 当店のメニュー・特徴・アクセス・営業（確認できた事実のみ）`,
    `(B) クーポン（上位5件まで・名称/内容/価格/条件。確認できたもののみ。無ければ「確認できず」と明記）`,
    `(C) 今後2週間の季節・話題の切り口（5〜8個、各1〜2行）`,
    `(D) 蒲田ローカルの素材（あるある・常識・名所・蒲田の女性に刺さる切り口を8個以上）`,
  ].join("\n");

  const stream = client().messages.stream({
    model: MODEL,
    max_tokens: 5000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    tools: [
      {
        type: "web_search_20260209",
        name: "web_search",
        max_uses: 12,
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
        max_uses: 6,
      },
    ],
    system,
    messages: [{ role: "user", content: user }],
  } as any);

  const msg = await stream.finalMessage();
  return (
    textOf((msg as any).content) ||
    "（リサーチ情報を取得できませんでした。一般的な季節感で作成します。）"
  );
}

const CONTENT_PLAN_SCHEMA = {
  type: "object",
  properties: {
    salonInfo: {
      type: "object",
      properties: {
        concept: { type: "string", description: "店舗のコンセプト・特徴（短く）" },
        menu: { type: "array", items: { type: "string" } },
        accessHours: { type: "string", description: "アクセス・営業時間（分かれば）" },
        coupons: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              price: { type: "string" },
              content: { type: "string" },
              note: { type: "string", description: "条件など（任意）" },
            },
            required: ["name", "price", "content"],
            additionalProperties: false,
          },
          description: "確認できたクーポンのみ。上位5件まで。無ければ空配列。",
        },
      },
      required: ["concept", "menu", "coupons"],
      additionalProperties: false,
    },
    anglePool: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string", description: "menu / tips / trust / season など" },
          angle: { type: "string", description: "投稿の切り口を1〜2文で具体的に" },
          coupon: { type: "boolean", description: "クーポン紹介に向くなら true" },
        },
        required: ["category", "angle"],
        additionalProperties: false,
      },
      description: "今後2週間ぶんの投稿アングル集。36個程度。",
    },
  },
  required: ["salonInfo", "anglePool"],
  additionalProperties: false,
};

export async function buildContentPlan(
  notes: string,
  history: PostHistoryItem[],
): Promise<Pick<ContentPlan, "salonInfo" | "anglePool">> {
  const recent =
    history
      .slice(-20)
      .map((h) => `- ${h.text.replace(/\n/g, " ").slice(0, 50)}`)
      .join("\n") || "（過去投稿はまだありません）";

  const user = [
    `# リサーチ結果`,
    notes,
    ``,
    `# 最近の投稿（テーマ・言い回しの重複を避ける）`,
    recent,
    ``,
    `# 依頼`,
    `上記リサーチをもとに、今後2週間ぶんの投稿素材を作成してください。`,
    `1) salonInfo: 確認できたメニュー・コンセプト・アクセス・クーポン（上位5件まで）。クーポンの価格は公式ページで直接確認できた、または複数ソースで一致したものだけ採用し、食い違う/不確かなものは載せない（空でよい）。創作・推測は禁止。`,
    `2) anglePool: 投稿アングルを36個程度。category と angle（切り口を1〜2文で具体的に）。クーポン紹介に向くものは coupon:true。`,
    `   うち6〜8個は、蒲田のローカルな常識・あるある・名所や、蒲田に住む女性の生活感に自然に絡めたアングルにする（category は "local"）。`,
    `## 蒲田ローカルの背景`,
    brand.localContext,
    `## 内容配分`,
    brand.contentMix,
    `## 目的`,
    brand.goal,
    `アングルはテーマ・切り口がそれぞれ異なるようにし、同じ訴求の単純な繰り返しを避けてください。`,
  ].join("\n");

  // 大きな構造化JSON出力のため、思考はオフにして出力トークンを確保する
  const res = await client().messages.create({
    model: MODEL,
    max_tokens: 16000,
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: CONTENT_PLAN_SCHEMA },
    },
    system: buildPlanSystemPrompt(),
    messages: [{ role: "user", content: user }],
  } as any);

  const raw = textOf((res as any).content);
  if (!raw) {
    throw new Error(
      `素材生成が空でした（stop_reason=${(res as any).stop_reason}）。max_tokens不足の可能性。`,
    );
  }
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`素材生成結果のJSON解析に失敗しました: ${raw.slice(0, 200)}`);
  }
  const salonInfo = {
    concept: String(data?.salonInfo?.concept ?? ""),
    menu: Array.isArray(data?.salonInfo?.menu) ? data.salonInfo.menu.map(String) : [],
    accessHours: String(data?.salonInfo?.accessHours ?? ""),
    coupons: Array.isArray(data?.salonInfo?.coupons)
      ? data.salonInfo.coupons.slice(0, 5).map((c: any) => ({
          name: String(c.name ?? ""),
          price: String(c.price ?? ""),
          content: String(c.content ?? ""),
          note: c.note ? String(c.note) : undefined,
        }))
      : [],
  };
  const anglePool: AngleItem[] = Array.isArray(data?.anglePool)
    ? data.anglePool
        .map((x: any) => ({
          category: String(x.category ?? "menu"),
          angle: String(x.angle ?? ""),
          coupon: x.coupon === true ? true : undefined,
        }))
        .filter((a: AngleItem) => a.angle.trim().length > 0)
    : [];
  if (anglePool.length === 0) throw new Error("アングルが空でした");
  return { salonInfo, anglePool };
}

const POST_SCHEMA = {
  type: "object",
  properties: {
    topic: {
      type: "string",
      description: "この投稿のテーマ（短い日本語）",
    },
    text: {
      type: "string",
      description:
        "Threads投稿の本文。ハッシュタグは付けない。「」『』や\"\"''などの括弧・引用符は使わない。抜け感のあるトーンで句点（。）はできるだけ省く。冒頭1〜2行で手を止めさせ、末尾は必ず返信したくなる問いかけで締める。スマホで読みやすいよう意味のまとまりごとに改行し（\\n）、適度に空行も入れて余白を作る。問いかけや予約導線も含めて20〜80字程度（長くても85字以内）でばらつかせ、85字を超えない。短く簡潔に。",
    },
  },
  required: ["topic", "text"],
  additionalProperties: false,
};

/**
 * 素材（アングル＋任意のクーポン）から本文だけを高速生成する。
 * Web検索なし・思考オフ・effort低でAPI費用を抑える。
 */
export async function generatePost(
  angle: AngleItem,
  coupon: Coupon | null,
  history: PostHistoryItem[],
  targetChars: number,
  includeCta: boolean,
  mentionKamata: boolean,
  salonInfo?: SalonInfo,
): Promise<GeneratedPost> {
  const recent =
    history
      .slice(-6)
      .map((h) => `- ${h.text.replace(/\n/g, " ").slice(0, 50)}`)
      .join("\n") || "（過去投稿はまだありません）";

  const couponBlock = coupon
    ? [
        `# 今回紹介するクーポン（内容・価格は下記をそのまま正確に使う。割引額や条件の創作・改変は禁止）`,
        `名称: ${coupon.name}`,
        `内容: ${coupon.content}`,
        `価格: ${coupon.price}`,
        coupon.note ? `条件: ${coupon.note}` : "",
        `この投稿では上記クーポンの内容と価格に自然に触れてください。`,
        `対象・条件（例：新規／初回限定／平日限定）も必ず明記し、誰でも対象であるかのように誤解させない。`,
        ``,
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const infoBits: string[] = [];
  if (salonInfo?.concept) infoBits.push(`コンセプト: ${salonInfo.concept}`);
  if (salonInfo?.accessHours) infoBits.push(`アクセス/営業: ${salonInfo.accessHours}`);
  const infoBlock = infoBits.length
    ? `# 店舗情報（必要なときだけ自然に1つ触れる程度。羅列しない）\n${infoBits.join("\n")}`
    : "";

  const ctaBlock = includeCta
    ? `# 予約導線\n本文中に予約導線を自然に短く1回だけ入れる（押し付けない）: ${brand.cta}\nただし最後の一文は予約の呼びかけではなく、返信したくなる問いかけにする。全体で80字程度に収まるよう簡潔に。`
    : `# 予約導線\nこの投稿では予約の呼びかけ（ご予約・プロフィールのリンク等）は入れない。価値提供・共感に徹する。`;

  const kamataBlock = mentionKamata
    ? `# 蒲田の言及\n本文に「蒲田」（または大田区）を自然に1回入れる。`
    : `# 蒲田の言及\n蒲田への言及は任意（無理に入れない）。`;

  const user = [
    `# この投稿のテーマ`,
    `カテゴリ: ${angle.category}`,
    `切り口: ${angle.angle}`,
    ``,
    couponBlock,
    infoBlock,
    ctaBlock,
    kamataBlock,
    ``,
    `# 直近の自分の投稿（言い回しの繰り返しを避ける）`,
    recent,
    ``,
    `# 文字数の目安`,
    `本文は約${targetChars}文字。問いかけ・予約導線も含めて20〜80字程度に収める（長くても85字以内、超えない・途中で切らない）。短く簡潔に。`,
    ``,
    `# 依頼`,
    `上記の切り口で、まつげパーマ・眉毛WAXの集客につながるThreads投稿を1つ、信頼感のある美容の視点で作成してください。`,
    `冒頭1〜2行で手を止めさせ（結論や共感を誘う問いから始める）、末尾は必ず返信したくなる問いかけで締めること。`,
  ]
    .filter((l) => l !== "")
    .join("\n");

  const res = await client().messages.create({
    model: MODEL,
    max_tokens: 700,
    output_config: {
      effort: "low",
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
  return { topic: String(data.topic ?? angle.category), text: String(data.text ?? "") };
}

/** 改行が無い場合に、文の区切りで改行を入れて視認性を上げる（保険） */
function ensureLineBreaks(text: string): string {
  if (text.includes("\n")) return text; // モデルが改行済みならそのまま尊重
  // 文末記号（。！？!?）の後で改行（直後が空白の場合は除く）
  return text.replace(/([。！？!?])(?=[^\s])/g, "$1\n");
}

/** 上限超過時は、途中で切れないよう文末/改行の区切りで切り詰める（「…」は付けない） */
function clampLength(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const boundary = Math.max(
    slice.lastIndexOf("\n"),
    slice.lastIndexOf("？"),
    slice.lastIndexOf("?"),
    slice.lastIndexOf("。"),
    slice.lastIndexOf("！"),
    slice.lastIndexOf("!"),
  );
  return (boundary >= Math.floor(max * 0.5) ? slice.slice(0, boundary + 1) : slice).trim();
}

/** 括弧・引用符（「」『』“”‘’""''）を取り除く */
function stripBrackets(text: string): string {
  return text.replace(/[「」『』“”‘’"']/g, "");
}

/** 本文を整える（括弧・引用符の除去／ハッシュタグなし／改行の確保／途中で切れない上限ガード） */
export function composePostText(post: GeneratedPost): string {
  const text = ensureLineBreaks(stripBrackets(post.text.trim()));
  return clampLength(text, brand.postRules.maxLength);
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

// ==========================================
// システムプロンプト
// ==========================================
function buildPlanSystemPrompt(): string {
  return [
    `あなたは「${brand.name}」（${brand.area}の${brand.businessType}）の${brand.persona}です。`,
    `美容に詳しく信頼感のある発信者として、まつげパーマ・眉毛WAXの集客を最大化する投稿素材を設計します。`,
    ``,
    `## 目的`,
    brand.goal,
    `## 提供メニュー`,
    brand.services.map((s) => `- ${s}`).join("\n"),
    `## 蒲田ローカルの背景`,
    brand.localContext,
    `## 方針`,
    `- ${brand.contentMix}`,
    `- 各アングルは「まつげパーマ・眉毛WAXに興味を持ち、予約したくなる」ことを狙う。`,
    `- 正しい美容知識・お悩み解決・ケアのコツなどで信頼感を高める。`,
    `- 蒲田のローカルな常識・あるある・生活感を適度に織り込み、蒲田の女性に「自分ごと」と感じてもらう（毎回ではなく自然に）。`,
    `- クーポンは確認できたもののみ。価格・内容を創作しない。`,
    ``,
    `## 禁止事項（厳守）`,
    ...brand.prohibitions.map((p) => `- ${p}`),
  ].join("\n");
}

function buildPostSystemPrompt(): string {
  const r = brand.postRules;
  return [
    `あなたは「${brand.name}」（${brand.area}の${brand.businessType}）の${brand.persona}です。`,
    `美容に詳しく信頼感のある発信者として、まつげパーマ・眉毛WAXの集客につながるThreads投稿を作成します。`,
    ``,
    `## 目的`,
    brand.goal,
    `## ターゲット`,
    brand.audience,
    `## トーン`,
    brand.toneOfVoice,
    `## 提供メニュー`,
    brand.services.map((s) => `- ${s}`).join("\n"),
    `## 蒲田ローカルの背景（親近感づくりに活用）`,
    brand.localContext,
    ``,
    `## 投稿の条件`,
    `- 日本語。本文の長さは指定された目安文字数（${r.targetLength}）に合わせ、毎回ばらつかせる。問いかけ・予約導線を含めて最大${r.maxLength}文字を厳守（超えない・途中で切らない）。`,
    `- 「」『』や""''などの括弧・引用符は使わない。`,
    `- 抜け感のあるトーン。句点（。）はあえて省き、宣伝感を出さない。`,
    `- 冒頭1〜2行で手を止めさせる。結論や共感を誘う問いから始め、続きを読みたいと思わせる。`,
    `- 末尾は必ず、返信したくなる問いかけで締める（会話が続く投稿ほど拡散されるため）。具体的で答えやすい問いにする。`,
    `- 視認性を最優先に、意味のまとまりごとに改行し、適度に空行で余白を作る。1行は長くしすぎない（目安20〜30文字以内）。ただし不自然な分割はしない。`,
    `- 共感 → 価値（メニューの魅力・お悩み解決・信頼感のある美容知識）の流れを意識。`,
    `- 予約導線は別途指示に従う（毎回は入れない。指示がなければ予約の呼びかけはしない）。`,
    `- 切り口が蒲田ローカル(local)のとき、または自然に合うときは、蒲田の地元感・あるある・生活感を織り込み、蒲田の女性に親近感を持ってもらう。ただし無理に毎回入れない。事実に反することは書かない。`,
    `- 絵文字は${r.emoji}。`,
    `- ハッシュタグは付けない（本文にも入れない）。`,
    `- クーポンに触れる場合は、与えられた内容・価格・条件のみを使い、絶対に創作・改変しない。`,
    `- AIが書いたと分からない、人間味のある自然な文章にする。テンプレ感・宣伝臭は避ける。`,
    `- ${brand.compliance}`,
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
