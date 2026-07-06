import Anthropic from "@anthropic-ai/sdk";
import { brand } from "./config";
import type { PostHistoryItem, Learnings, ViralPlaybook } from "./state";
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
    "指定店舗の公式情報（メニュー・クーポン・価格）を確認し、今後2週間の『バズる×蒲田×美容』投稿に役立つ事実・季節・蒲田ローカルの切り口を整理します。";

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
      description: "今後2週間ぶんの投稿アングル集。44個程度（同日内でも重複しにくいよう多め）。",
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
    `上記リサーチをもとに、今後2週間ぶんの投稿素材を作成してください。最優先は『バズる × 蒲田 × 美容』で20〜40代女性の認知を広げること（来店誘導は目的にしない）。`,
    `1) salonInfo: 確認できたメニュー・コンセプト・アクセス・クーポン（上位5件まで）。クーポンの価格は公式ページで直接確認できた、または複数ソースで一致したものだけ採用し、食い違う/不確かなものは載せない（空でよい）。創作・推測は禁止。`,
    `2) anglePool: 投稿アングルを44個程度。category と angle（切り口を1〜2文で具体的に）。クーポン紹介に向くものがあれば coupon:true（任意。認知モードでは基本使わない）。`,
    `   全体として「思わず反応したくなる共感・あるある・気づき」を中心にし、メニューの売り込みや価格訴求に寄せすぎない。`,
    `   うち12個以上は、蒲田のローカルな常識・あるある・名所や、蒲田に住む女性の生活感に自然に絡めたアングルにする（category は "local"）。`,
    `   目元・眉・垢抜け・自分磨きなど美容の共感ネタも多めに入れる（category は "beauty" か "tips"）。`,
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

// ==========================================
// 一度だけ（詳細）: バズる投稿の「型」を調査してプレイブックを作る
// ==========================================
export async function researchViralPlaybook(today: string): Promise<string> {
  const system =
    "あなたはSNS（特にThreads・X・Instagram）で拡散する投稿の型に精通したバイラルコンテンツの分析家です。" +
    "日本の20〜40代女性に刺さり実際にバズった（保存・返信・拡散された）投稿の共通パターンを、具体的に言語化します。";

  const user = [
    `本日: ${today}（日本）。`,
    `対象読者: 蒲田・大田区に住む／働く20〜40代の女性。`,
    `発信者: 蒲田西口のまつげパーマ・眉毛WAX専門店の広報（美容に詳しい等身大の20代女性）。`,
    `目的: 『バズる × 蒲田 × 美容』の投稿で"認知"を広げること（来店誘導が目的ではない）。`,
    ``,
    `# 依頼（これは一度きりの詳細調査です。じっくり深く調べてください）`,
    `web_search で、実際に伸びた／バズった投稿の「型」を深く調べ、次を具体的にまとめてください。`,
    `1) Threads・Xで女性に刺さってバズる投稿の構成・書き出し・締め方の型（共感・あるある・意外な豆知識・問いかけ・リスト形式・逆張り・自己開示など）。`,
    `2) 美容（まつげ・眉・目元・垢抜け・自分磨き）ジャンルで保存・返信されやすいネタの型。`,
    `3) 地元・ローカル（蒲田／大田区のような街）ネタで共感を集める投稿の型。`,
    `4) 逆に伸びにくい・宣伝臭くて避けるべき型。`,
    `※特定のバズ投稿を丸写しするのではなく、応用できる「型・原則」を抽出する。`,
    ``,
    `# 出力`,
    `箇条書きで、(1)バズる型・原則 (2)美容ジャンルで効くネタ (3)ローカルで効くネタ (4)避けるべき型 をそれぞれ具体的に、多めに。`,
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
        max_uses: 10,
        user_location: {
          type: "approximate",
          country: "JP",
          region: "Tokyo",
          city: "Tokyo",
          timezone: "Asia/Tokyo",
        },
      },
    ],
    system,
    messages: [{ role: "user", content: user }],
  } as any);

  const msg = await stream.finalMessage();
  return (
    textOf((msg as any).content) ||
    "（バイラル調査の情報を取得できませんでした。一般的な原則で作成します。）"
  );
}

const VIRAL_PLAYBOOK_SCHEMA = {
  type: "object",
  properties: {
    playbook: {
      type: "array",
      items: { type: "string" },
      description: "バズる投稿の型・原則（書き出し・構成・締め方・避けるべき型を含む）。12〜18個、具体的で実行可能に。",
    },
    viralAngles: {
      type: "array",
      items: { type: "string" },
      description: "蒲田×美容（20〜40代女性）で普遍的にバズを狙える切り口アイデア。10〜16個。",
    },
  },
  required: ["playbook", "viralAngles"],
  additionalProperties: false,
};

/** 詳細調査メモを、静的に使うプレイブック（型・切り口）へ構造化する。 */
export async function buildViralPlaybook(
  notes: string,
): Promise<Pick<ViralPlaybook, "playbook" | "viralAngles">> {
  const user = [
    `# バズる投稿の詳細調査メモ`,
    notes,
    ``,
    `# 依頼`,
    `上記を、今後ずっと使えるバズる投稿のプレイブックへ整理してください（20〜40代女性向け・『バズる×蒲田×美容』・認知拡大が目的）。`,
    `- playbook: バズる型・原則（書き出し／構成／締め方／避けるべき型を含む）。12〜18個、具体的で実行可能に。`,
    `- viralAngles: 蒲田×美容で普遍的にバズを狙える切り口アイデアを10〜16個。`,
    `※当店はまつげパーマ・眉毛WAX専門（まつエクは扱わない・言及しない）。売り込みではなく認知拡大が目的。`,
  ].join("\n");

  const res = await client().messages.create({
    model: MODEL,
    max_tokens: 8000,
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: VIRAL_PLAYBOOK_SCHEMA },
    },
    system:
      "あなたはSNSのバイラル分析家です。調査メモから、今後ずっと使える『バズる投稿の型・切り口』のプレイブックを作ります。",
    messages: [{ role: "user", content: user }],
  } as any);

  const raw = textOf((res as any).content);
  if (!raw) {
    throw new Error(`プレイブック生成が空でした（stop_reason=${(res as any).stop_reason}）。`);
  }
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`プレイブック生成結果のJSON解析に失敗しました: ${raw.slice(0, 200)}`);
  }
  const arr = (x: any): string[] =>
    Array.isArray(x) ? x.map(String).filter((s) => s.trim().length > 0) : [];
  return { playbook: arr(data.playbook), viralAngles: arr(data.viralAngles) };
}

// ==========================================
// 毎日: その日のインプが狙える話題（全国／大田区／蒲田）を調査（Web検索あり）
// ==========================================
export async function researchTrendingTopics(today: string): Promise<string> {
  const system =
    "あなたは日本のトレンドと地域ニュースに敏感なSNS運用のリサーチャーです。" +
    "その日に多くの人が反応しそうな（インプレッションが取れそうな）話題を素早く見つけ、要点を短くまとめます。";

  const user = [
    `本日: ${today}（日本・東京）。`,
    `発信者: 蒲田西口のまつげパーマ・眉毛WAX専門店の広報（美容に詳しい等身大の20代女性）。`,
    `対象読者: 蒲田・大田区に住む／働く20〜40代の女性。目的は認知拡大（来店誘導ではない）。`,
    ``,
    `# 依頼`,
    `web_search で、今日〜ここ数日で「インプレッションが取れそう・話題になっている」ネタを集めてください。`,
    `A) 全国的なトレンド・季節・話題（ニュース、行事、天気、SNSで話題の事柄、美容・ライフスタイル系の流行など）。`,
    `B) 大田区・蒲田のローカルな話題・イベント・季節ネタ（お祭り、商店街、周辺の出来事、天気・混雑など）。`,
    `※政治・災害・事故・訃報など、美容アカウントが便乗すると不謹慎・炎上しうる話題は除外する。`,
    `※各話題は、20〜40代女性の共感・美容・蒲田の日常に自然に絡められるかも一言添える。`,
    ``,
    `# 出力`,
    `箇条書きで6〜10件。各行「話題（全国 or 蒲田/大田区）→ 美容や共感・日常への自然な絡め方」。`,
  ].join("\n");

  const stream = client().messages.stream({
    model: MODEL,
    max_tokens: 3500,
    output_config: { effort: "medium" },
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
    ],
    system,
    messages: [{ role: "user", content: user }],
  } as any);

  const msg = await stream.finalMessage();
  return (
    textOf((msg as any).content) ||
    "（本日の話題を取得できませんでした。話題なしで作成します。）"
  );
}

const LEARNINGS_SCHEMA = {
  type: "object",
  properties: {
    doMore: {
      type: "array",
      items: { type: "string" },
      description: "自店で伸びた投稿の共通点・もっとやるべきこと。",
    },
    avoid: {
      type: "array",
      items: { type: "string" },
      description: "伸びなかった・宣伝臭い・避けるべき型。",
    },
    todayTopics: {
      type: "array",
      items: { type: "string" },
      description:
        "その日のインプが狙える話題＋美容や共感・蒲田の日常への絡め方。6〜10個。不謹慎・炎上リスクのある話題は除外。",
    },
  },
  required: ["doMore", "avoid", "todayTopics"],
  additionalProperties: false,
};

export type ScoredPost = { text: string; score: number };

/**
 * 自店の投稿実績（上位・下位）と、その日の話題メモから、
 * 当日の投稿を改善するための学習知見を作る。
 */
export async function buildLearnings(
  trendNotes: string,
  top: ScoredPost[],
  weak: ScoredPost[],
): Promise<Pick<Learnings, "doMore" | "avoid" | "todayTopics">> {
  const fmt = (arr: ScoredPost[]) =>
    arr.length
      ? arr
          .map((p, i) => `${i + 1}. [score ${p.score}] ${p.text.replace(/\n/g, " ").slice(0, 80)}`)
          .join("\n")
      : "（まだ十分なデータがありません）";

  const user = [
    `# 自店で伸びた投稿（エンゲージメント上位）`,
    fmt(top),
    ``,
    `# 自店で伸びなかった投稿（エンゲージメント下位）`,
    fmt(weak),
    ``,
    `# 本日のインプが狙える話題（Web調査メモ）`,
    trendNotes,
    ``,
    `# 依頼`,
    `上記から、本日の『バズる × 蒲田 × 美容』投稿（20〜40代女性向け・認知拡大が目的）を改善するための知見を作成してください。`,
    `- doMore: 自店で伸びた投稿の共通点・もっとやるべきこと（自店の実績分析を最優先。実績が薄ければ一般則で補う）。`,
    `- avoid: 伸びなかった／宣伝臭い・避けるべき型。`,
    `- todayTopics: 本日のインプが狙える話題を6〜10個。各項目に美容や共感・蒲田の日常への自然な絡め方を添える。不謹慎・炎上リスクのある話題は除外する。`,
    `※当店はまつげパーマ・眉毛WAX専門（まつエクは扱わない・言及しない）。売り込みではなく認知拡大が目的。`,
  ].join("\n");

  const res = await client().messages.create({
    model: MODEL,
    max_tokens: 5000,
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: LEARNINGS_SCHEMA },
    },
    system:
      "あなたはSNS運用の分析家です。自店の実績データとその日の話題から、" +
      "本日実行できる具体的な改善知見（やるべきこと・避けること・今日乗るべき話題）を作ります。",
    messages: [{ role: "user", content: user }],
  } as any);

  const raw = textOf((res as any).content);
  if (!raw) {
    throw new Error(`learnings生成が空でした（stop_reason=${(res as any).stop_reason}）。`);
  }
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`learnings生成結果のJSON解析に失敗しました: ${raw.slice(0, 200)}`);
  }
  const arr = (x: any): string[] =>
    Array.isArray(x) ? x.map(String).filter((s) => s.trim().length > 0) : [];
  return {
    doMore: arr(data.doMore),
    avoid: arr(data.avoid),
    todayTopics: arr(data.todayTopics),
  };
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
        `Threads投稿の本文。ハッシュタグは付けない。「」『』や""''などの括弧・引用符は使わない。抜け感のあるトーンで句点（。）はできるだけ省く。冒頭1〜2行で手を止めさせ、末尾は必ず返信したくなる問いかけで締める。スマホで読みやすいよう意味のまとまりごとに改行し（\\n）、適度に空行も入れて余白を作る。短く簡潔に、全体で${brand.postRules.targetLength}、${brand.postRules.maxLength}字を超えない（途中で切らない）。`,
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
  learnings?: Learnings | null,
  playbook?: ViralPlaybook | null,
): Promise<GeneratedPost> {
  const recent =
    history
      .slice(-6)
      .map((h) => `- ${h.text.replace(/\n/g, " ").slice(0, 50)}`)
      .join("\n") || "（過去投稿はまだありません）";

  const learnBlock = buildLearningsBlock(playbook, learnings);

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
    ? `# 予約導線\n本文中に予約導線を自然に短く1回だけ入れる（押し付けない）: ${brand.cta}\nただし最後の一文は予約の呼びかけではなく、返信したくなる問いかけにする。`
    : `# 予約・宣伝について\nこの投稿では予約・来店の呼びかけ（ご予約・プロフィールのリンク等）は入れない。売り込まない。目的は『バズる×蒲田×美容』での認知拡大。共感・気づき・あるあるに徹する。`;

  const kamataBlock = mentionKamata
    ? `# 蒲田の言及\n本文に「蒲田」（または大田区）を自然に1回入れる。地元の女性が『わかる』と感じるローカル感を出す。`
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
    learnBlock,
    ``,
    `# 直近の自分の投稿（言い回しの繰り返しを避ける）`,
    recent,
    ``,
    `# 文字数の目安`,
    `本文は約${targetChars}文字。短く簡潔に、全体で最大${brand.postRules.maxLength}字を超えない（途中で切らない）。`,
    ``,
    `# 依頼`,
    `上記の切り口で、20〜40代女性が思わず反応（いいね・保存・返信）したくなるThreads投稿を1つ作成してください。`,
    `『バズる × 蒲田 × 美容』が最優先。まつげパーマ・眉毛WAX専門店ならではの美容の視点は自然に効かせるが、売り込みや宣伝臭は出さない。`,
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
          `次のコメントの内容・文脈をよく読み取り、敬語で、人間が自然に返信しているように返信してください。` +
          `お店への誘導・宣伝は入れないこと。返信本文のみを出力してください。\n\n` +
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
    `美容に詳しく信頼感のある発信者として、『バズる × 蒲田 × 美容』で20〜40代女性の認知を広げる投稿素材を設計します。`,
    ``,
    `## 目的`,
    brand.goal,
    `## 専門（視点として自然に効かせる。売り込みはしない）`,
    brand.services.map((s) => `- ${s}`).join("\n"),
    `## 蒲田ローカルの背景`,
    brand.localContext,
    `## 方針`,
    `- ${brand.contentMix}`,
    `- 各アングルは「思わず反応（いいね・保存・返信）したくなる」ことを最優先に狙う。予約・来店誘導は狙わない。`,
    `- 美容知識・お悩み共感・ケアのコツは、上から教えず自然な気づきとして織り込み信頼感を高める。`,
    `- 蒲田のローカルな常識・あるある・生活感を積極的に織り込み、蒲田の女性に「自分ごと」「わかる」と感じてもらう。`,
    `- クーポンは確認できたもののみ。価格・内容を創作しない。`,
    ``,
    `## 禁止事項（厳守）`,
    ...brand.prohibitions.map((p) => `- ${p}`),
  ].join("\n");
}

/**
 * 静的なバズ・プレイブック＋毎日の学習知見を、プロンプト用ブロックに整形する。
 * どちらも無ければ空文字。
 */
function buildLearningsBlock(
  playbook?: ViralPlaybook | null,
  learnings?: Learnings | null,
): string {
  const sec = (title: string, items: string[] | undefined, n: number, map = (s: string) => s) =>
    items && items.length
      ? `## ${title}\n${items.slice(0, n).map((s) => `- ${map(s)}`).join("\n")}`
      : "";
  const blocks = [
    sec("バズる型・原則（一度の詳細調査で作った普遍の型）", playbook?.playbook, 10),
    sec("バズを狙える切り口（今日のテーマに活かせそうなら取り入れる）", playbook?.viralAngles, 6),
    sec("今日のインプが狙える話題（自然に絡められそうなら1つ乗る）", learnings?.todayTopics, 6),
    sec("伸びた投稿の傾向（もっとやる）", learnings?.doMore, 6),
    sec("伸びなかった傾向（避ける）", learnings?.avoid, 6),
    sec(
      "実際に伸びた自店の投稿（言い回しは真似せず“型”だけ参考に）",
      learnings?.topExamples,
      3,
      (s) => s.replace(/\n/g, " ").slice(0, 60),
    ),
  ].filter(Boolean);
  if (!blocks.length) return "";
  return `# バズる投稿の学び（型は固定・話題と実績は毎日更新。これを踏まえて改善する）\n${blocks.join("\n")}`;
}

function buildPostSystemPrompt(): string {
  const r = brand.postRules;
  return [
    `あなたは「${brand.name}」（${brand.area}の${brand.businessType}）の${brand.persona}です。`,
    `Threadsで『バズる × 蒲田 × 美容』の投稿を作り、20〜40代女性に広く認知される（覚えてもらう）ことを狙います。`,
    `売り込みではなく、思わず反応したくなる共感・気づき・あるあるで拡散を狙う発信者です。`,
    ``,
    `## 目的`,
    brand.goal,
    `## ターゲット`,
    brand.audience,
    `## トーン`,
    brand.toneOfVoice,
    `## 専門（無理に売り込まないが、視点として自然に効かせる）`,
    brand.services.map((s) => `- ${s}`).join("\n"),
    `## 蒲田ローカルの背景（親近感・あるあるづくりに活用）`,
    brand.localContext,
    ``,
    `## 投稿の条件`,
    `- 日本語。本文の長さは指定された目安文字数（${r.targetLength}）に合わせ、毎回大きくばらつかせる。全体で最大${r.maxLength}文字を厳守（超えない・途中で切らない）。`,
    `- 「」『』や""''などの括弧・引用符は使わない。`,
    `- 抜け感のあるトーン。句点（。）はあえて省き、宣伝感を出さない。`,
    `- 冒頭1〜2行で手を止めさせる。結論・共感・意外性のある問いから始め、続きを読みたいと思わせる。`,
    `- 末尾は必ず、返信したくなる問いかけで締める（会話が続く投稿ほど拡散されるため）。具体的で答えやすい問いにする。`,
    `- 視認性を最優先に、意味のまとまりごとに改行し、適度に空行で余白を作る。1行は長くしすぎない（目安20〜30文字以内）。ただし不自然な分割はしない。`,
    `- まず『バズる（共感・保存・返信されやすい）』を最優先。美容の知識やお悩み解決は、押し付けず自然な気づきとして織り込む。`,
    `- 売り込み・宣伝・予約や来店の呼びかけは基本的にしない（目的は認知）。別途「予約導線」の指示がある場合のみ、それに従う。`,
    `- 切り口が蒲田ローカル(local)のとき、または自然に合うときは、蒲田の地元感・あるある・生活感を織り込み、蒲田の女性に『自分ごと』『わかる』と感じてもらう。ただし無理に毎回は入れない。事実に反することは書かない。`,
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
    `お店の投稿に来たコメントへ、人間が返信しているかのように自然に返信します。`,
    ``,
    `## ルール`,
    `- ${r.style}`,
    `- 敬語（です・ます調）を基本にする。堅苦しすぎず、温かみのある自然な言葉遣いにする。`,
    `- コメントの内容・文脈をしっかり読み取り、それに沿った具体的な返信をする。当たり障りのないテンプレ的な相槌だけで終わらせない。`,
    `- 共感を示し、自然に会話が続くようにする。`,
    `- 「ご予約はこちらから」「プロフィールのリンクから」など、お店への誘導・宣伝につながる内容は入れない。あくまで会話への自然な返信に徹する。`,
    `- 絵文字を${r.emoji}使う。`,
    `- ${r.maxLength}文字以内。`,
    `- 絶対にAIだと分からないようにする。定型文っぽさを避ける。`,
    `- 返信本文のみを出力する（説明や引用符は不要）。`,
    ``,
    `## 禁止事項（厳守）`,
    ...brand.prohibitions.map((p) => `- ${p}`),
  ].join("\n");
}
