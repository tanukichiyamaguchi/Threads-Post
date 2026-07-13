import Anthropic from "@anthropic-ai/sdk";
import { brand } from "./config";
import type { PostHistoryItem, Learnings, ViralPlaybook } from "./state";
import type { AngleItem, Coupon, ContentPlan, SalonInfo } from "./content";
import { LENGTH_RANGES, type ChosenArms } from "./bandit";

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
    `# 手順3: 大田区ローカル情報（重要・蒲田だけに偏らない）`,
    `蒲田のローカルな常識・あるある・名所（餃子／商店街／銭湯など）、街の雰囲気に加えて、`,
    `蒲田から3km圏内の周辺エリア（大森・池上・糀谷・六郷・矢口・下丸子・千鳥町など）や、`,
    `大田区全体で知られるエリア（田園調布・洗足池・久が原・雪谷・羽田・馬込など）の`,
    `あるある・名所・雰囲気も集めてください。`,
    `そして大田区に住む・通う女性の生活感（共働き・子育て・忙しさ・コスパ志向・自分時間など）を集めてください。`,
    `最新情報でなくてよく、地元の人が「わかる」と感じる定番ネタでOK。失礼なステレオタイプは避ける。`,
    ``,
    `# 出力`,
    `(A) 当店のメニュー・特徴・アクセス・営業（確認できた事実のみ）`,
    `(B) クーポン（上位5件まで・名称/内容/価格/条件。確認できたもののみ。無ければ「確認できず」と明記）`,
    `(C) 今後2週間の季節・話題の切り口（5〜8個、各1〜2行）`,
    `(D) 大田区ローカルの素材（蒲田＋3km圏内の周辺エリア＋区全体のあるある・常識・名所・地元女性に刺さる切り口を8個以上。蒲田だけに偏らせない）`,
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
    `   うち12個以上は、蒲田・大田区のローカルな常識・あるある・名所や、そこに住む女性の生活感に自然に絡めたアングルにする（category は "local"）。蒲田だけに偏らず、3km圏内の周辺エリア（大森・池上・糀谷・六郷・矢口・下丸子など）や大田区全体（田園調布・洗足池・久が原・雪谷・羽田・馬込など）のネタも織り交ぜる。`,
    `   目元・眉・垢抜け・自分磨きなど美容の共感ネタも多めに入れる（category は "beauty" か "tips"）。`,
    `## 大田区ローカルの背景（蒲田＋3km圏内の周辺エリア＋区全体）`,
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
    `B) 大田区（蒲田＋3km圏内の周辺エリア＋区全体）のローカルな話題・イベント・季節ネタ（お祭り、商店街、周辺の出来事、天気・混雑など）。蒲田だけに偏らず、大森・池上・田園調布・羽田など他エリアの話題も対象にする。`,
    `※政治・災害・事故・訃報など、美容アカウントが便乗すると不謹慎・炎上しうる話題は除外する。`,
    `※各話題は、20〜40代女性の共感・美容・大田区の日常に自然に絡められるかも一言添える。`,
    `※重要: Web検索で実際に確認できた話題だけを出すこと。検索できなかった・確認できなかった場合は、`,
    `推測や一般知識で話題を作らず「話題を確認できませんでした」とだけ出力する（事実誤認の投稿を防ぐため）。`,
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
        max_uses: 8,
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
    `  ※重要: 単一の勝ちパターン（例: あるある＋どっち派？の二択）だけを推奨しない。伸びた投稿の中から互いに異なる型・要素を最低3系統抽出する。同じ型ばかり作るとフォロワーに飽きられ・アルゴリズムに反復コンテンツとして降格されるため。`,
    `- avoid: 伸びなかった／宣伝臭い・避けるべき型。`,
    `- todayTopics: 本日のインプが狙える話題を6〜10個。各項目に美容や共感・蒲田の日常への自然な絡め方を添える。不謹慎・炎上リスクのある話題は除外する。`,
    `  ※話題メモが「確認できませんでした」等で実際の話題を含まない場合、todayTopics は空配列にする（推測で話題を作らない）。`,
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

// ==========================================
// 週1回: 環境センシング（今Threadsで伸びている型）＋メタ分析
// ==========================================
export async function researchEnvironmentTrends(today: string): Promise<string> {
  const system =
    "あなたは日本のSNS（特にThreads）の動向に詳しいコンテンツ戦略の分析家です。" +
    "いま実際に伸びている投稿の傾向・型の変化を調べ、実行可能な示唆に落とします。";

  const user = [
    `本日: ${today}（日本）。`,
    `発信者: 蒲田西口のまつげパーマ・眉毛WAX専門店（20〜40代女性向け・テキスト投稿のみ・目的はインプレッション最大化）。`,
    ``,
    `# 依頼`,
    `web_search で、ここ数週間の日本のThreadsで「実際に伸びている投稿の傾向」を調べてください。`,
    `1) 美容・ライフスタイル系で今伸びている投稿の型・ネタの変化`,
    `2) Threadsのアルゴリズム・機能の最近の変化（配信・おすすめ・タグなど）`,
    `3) 地域・ローカル系アカウントで反応が取れている型`,
    `※確認できたものだけを書き、推測は「不確実」と明記する。`,
    ``,
    `# 出力`,
    `箇条書きで8〜12件。各行に「観察された傾向 → 当アカウントへの応用」の形で。`,
  ].join("\n");

  const stream = client().messages.stream({
    model: MODEL,
    max_tokens: 3500,
    output_config: { effort: "medium" },
    tools: [
      {
        type: "web_search_20260209",
        name: "web_search",
        max_uses: 8,
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
  return textOf((msg as any).content) || "（環境トレンドを取得できませんでした）";
}

const WEEKLY_META_SCHEMA = {
  type: "object",
  properties: {
    environmentTrends: {
      type: "array",
      items: { type: "string" },
      description:
        "今の環境（Threadsの傾向）を踏まえて投稿生成時に意識すべきこと。5〜8個。ネタ・題材・雰囲気レベルの知見に限る。投稿の構造（締め方・書き出しの型・長さ・フォーマット）を固定する指示は書かない（構造は別のクォータ付き学習システムが管理しており、全投稿に同じ構造を強制するとワンパターン化するため）。",
    },
    analysis: {
      type: "string",
      description:
        "今週の実績の分析（何が効いた/効かなかった・次週やるべきこと）をMarkdownで400字程度。",
    },
  },
  required: ["environmentTrends", "analysis"],
  additionalProperties: false,
};

/** 週次メタ分析: アーム統計＋実文＋環境調査から、環境トレンドと人間可読の分析を作る */
export async function buildWeeklyMeta(
  modelSummary: string,
  top: ScoredPost[],
  weak: ScoredPost[],
  envNotes: string,
): Promise<{ environmentTrends: string[]; analysis: string }> {
  const fmt = (arr: ScoredPost[]) =>
    arr.length
      ? arr
          .map((p, i) => `${i + 1}. [24h views相対 ${p.score.toFixed(2)}] ${p.text.replace(/\n/g, " ").slice(0, 100)}`)
          .join("\n")
      : "（データなし）";

  const user = [
    `# 学習モデルのアーム統計（型ごとの実測平均報酬）`,
    modelSummary,
    ``,
    `# 今週伸びた投稿`,
    fmt(top),
    ``,
    `# 今週伸びなかった投稿`,
    fmt(weak),
    ``,
    `# 環境調査メモ（今Threadsで伸びている型）`,
    envNotes,
    ``,
    `# 依頼`,
    `上記から次を作成:`,
    `- environmentTrends: 環境の変化を踏まえて投稿生成時に意識すべきこと5〜8個（具体的・実行可能に）。`,
    `  ※禁止: 「文末は必ず〇〇で締める」「〇〇形式を基本フォーマットにする」「〇〇のフックは使わない」のような、投稿の構造を全投稿に固定する指示。構造（書き出し・締め方・長さ）はクォータ付きの学習システムが確率的に管理しており、ここで固定するとワンパターン化と反復コンテンツ降格を招く。ネタ・題材・トーン・地域文脈レベルの知見だけを書く。`,
    `- analysis: 今週の分析（何が効いた/効かなかった・数字の根拠・次週の重点）をMarkdownで。`,
  ].join("\n");

  const res = await client().messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: WEEKLY_META_SCHEMA },
    },
    system:
      "あなたはSNS運用のデータ分析家です。実測のアーム統計と実文、環境調査を統合し、" +
      "インプレッション最大化のための実行可能な知見を作ります。",
    messages: [{ role: "user", content: user }],
  } as any);

  const raw = textOf((res as any).content);
  if (!raw) throw new Error(`週次メタ分析が空でした（stop_reason=${(res as any).stop_reason}）`);
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`週次メタ分析のJSON解析に失敗しました: ${raw.slice(0, 200)}`);
  }
  const arr = (x: any): string[] =>
    Array.isArray(x) ? x.map(String).filter((s: string) => s.trim().length > 0) : [];
  return { environmentTrends: arr(data.environmentTrends), analysis: String(data.analysis ?? "") };
}

const POST_SCHEMA = {
  type: "object",
  properties: {
    firstLineDrafts: {
      type: "array",
      items: { type: "string" },
      description:
        "本文を書く前に、一行目（最重要）の候補をちょうど3案作る。それぞれ切り口の違う書き出しにし、最近の投稿と似た言い回しは出さない。最も強い1案を本文の冒頭に採用する。",
    },
    topic: {
      type: "string",
      description: "この投稿のテーマ（短い日本語）",
    },
    text: {
      type: "string",
      description:
        `Threads投稿の本文。firstLineDraftsの中で最も強い1案を一行目にそのまま使う。ハッシュタグは付けない。「」『』や""''などの括弧・引用符は使わない。抜け感のあるトーンで句点（。）はできるだけ省く。スマホで読みやすいよう意味のまとまりごとに改行し（\\n）、適度に空行も入れて余白を作る。長さと締め方は指示された型に従う。最大${brand.postRules.maxLength}字を超えない（途中で切らない）。HTMLタグ（<br>、</br>、<p> など）や記号的な箇条書き記号（A/B、①②、a) b) など）は一切使わない。改行は実際の改行文字だけで表現し、選択肢は自然な日本語の言い回しと改行で区切る。`,
    },
  },
  required: ["firstLineDrafts", "topic", "text"],
  additionalProperties: false,
};

// アーム（学習で選ばれた型）→ プロンプトの具体的な指示文
const HOOK_GUIDE: Record<string, string> = {
  問題提起: "悩みの名指しから入る（例: 〇〇に悩んでいる人へ／もしかして〇〇していませんか）",
  数字: "具体的な数字から入る（例: 3つだけ／5選／◯日で変わった話）",
  逆説: "意外な事実・逆張りから入る（例: 実は〇〇は逆効果／〇〇しなくていい）",
  共感: "気持ちの代弁から入る（読んだ人が わかる… と言いたくなる書き出し）",
  あるある: "対象を絞ったあるあるから入る。ただし「〇〇あるある」という見出しの使い回しは禁止。あるあるの中身を一行目に直接書く（例: 見出しではなく、情景そのものから入る）",
  リスト: "リスト・ランキング形式で構成する（TOP3・チェックリストなど、最後まで読ませる構造）",
  意見募集: "みんなに意見を聞く形で始める（例: 〇〇な人いる？／みんなはどうしてる？）",
  自己開示: "自分の失敗談・本音・体験談から入る（等身大の一人称で）",
};

const ENDING_GUIDE: Record<string, string> = {
  二択質問:
    "末尾は2つの選択肢から答えやすい問いで締める。選択肢はA/Bやアルファベット・番号のラベルを付けず、それぞれ自然な日本語の一文として書き、改行で区切って見やすくする（例:\n傘を持ち歩く派\nそれとも降ってから走る派\nあなたはどっち？）。最後は必ず？で終える。「どっち派？」という聞き方の使い回しは禁止（聞き方を毎回変える）",
  共感確認:
    "末尾は共感を確認する軽い問いで締める（例: これ私だけ？／わかる人いる？の系統。言い回しは毎回変える）。最後は必ず？で終える",
  開いた質問: "末尾は相手の話を聞く開いた問いで締める（例: みんなのおすすめ教えて）。最後は必ず？で終える",
  言い切り: "最後の文に疑問符（？）を使わない。余韻・共感・オチのある言い切りで終える（例: 〜がち／〜なんだよね／また行こ）。問いかけへの言い換えもしない",
};

/** 一行目（最重要）の品質基準。全投稿共通でプロンプトに注入する */
const FIRST_LINE_RULES = [
  "一行目だけで読者の指を止められるかが勝負の9割。一行目単体で意味が完結し、続きを読みたくなること",
  "具体（固有名詞・数字・情景）＞抽象。ぼんやりした導入や前置きは禁止",
  "見出しっぽいラベル（〇〇あるある など）で逃げず、中身のある一文を書く",
  "下の「最近使った書き出し」と似た言い回し・同じ出だしは絶対に使わない",
  "この投稿の大半は38文字以内の超短文。その場合は一行目がほぼ本文そのもの＝一撃で刺さる一文に磨き上げる",
];

/**
 * 素材（アングル＋任意のクーポン）と学習済みの型（アーム）から本文を生成する。
 * Web検索なし・思考オフ・effort低でAPI費用を抑える。
 * extraDirective は多様性ガードの再生成時に追加の指示を渡す。
 */
export async function generatePost(
  angle: AngleItem,
  coupon: Coupon | null,
  history: PostHistoryItem[],
  arms: ChosenArms,
  includeCta: boolean,
  salonInfo?: SalonInfo,
  learnings?: Learnings | null,
  playbook?: ViralPlaybook | null,
  extraDirective?: string,
): Promise<GeneratedPost> {
  const recent =
    history
      .slice(-6)
      .map((h) => `- ${h.text.replace(/\n/g, " ").slice(0, 50)}`)
      .join("\n") || "（過去投稿はまだありません）";

  // 一行目の使い回しを防ぐため、直近の書き出しを禁止リストとして明示する
  const recentFirstLines =
    history
      .slice(-15)
      .map((h) => `- ${h.text.split("\n")[0].slice(0, 40)}`)
      .join("\n") || "（まだありません）";

  const learnBlock = buildLearningsBlock(playbook, learnings);

  const lengthRange = LENGTH_RANGES[arms.length] ?? LENGTH_RANGES.S;
  const hasTopics = (learnings?.todayTopics?.length ?? 0) > 0;
  const firstLineBlock = [
    `# 一行目（最重要・ここに全力を注ぐ）`,
    ...FIRST_LINE_RULES.map((r) => `- ${r}`),
    `## 最近使った書き出し（これらと似た冒頭・同じ出だしは禁止）`,
    recentFirstLines,
  ].join("\n");

  const armBlock = [
    `# この投稿の型（実測データから学習した指定。必ず従う）`,
    `※この型指定は、後述のお手本・プレイブック・学びのどの記述よりも優先する。`,
    `- 書き出し（フック）: ${arms.hook} — ${HOOK_GUIDE[arms.hook] ?? arms.hook}`,
    `- 長さ: ${lengthRange.label}（${lengthRange.min}〜${lengthRange.max}文字に収める）`,
    `- 締め方: ${arms.ending} — ${ENDING_GUIDE[arms.ending] ?? arms.ending}`,
    arms.newsRiding && hasTopics
      ? `- 話題: 下記「今日のインプが狙える話題」から1つ選び、本文に自然に絡める（無理な便乗はしない）`
      : `- 話題: 時事ネタには乗らず、切り口そのもので勝負する`,
  ].join("\n");

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

  const kamataBlock = arms.kamata
    ? `# エリアの言及\n本文に地元のエリアを自然に1回入れる。「蒲田」だけに固定せず、蒲田から3km圏内の周辺エリア（大森・糀谷・六郷・矢口・下丸子・池上・千鳥町など）や、大田区全体の話題（田園調布・洗足池・久が原・雪谷・羽田・馬込など）も織り交ぜて、地元の女性が『わかる』と感じるローカル感を出す。`
    : `# エリアの言及\nこの投稿では蒲田・大田区（周辺エリア含む）には言及しない（全国の読者に刺さる内容にする）。`;

  const user = [
    `# この投稿のテーマ`,
    `カテゴリ: ${angle.category}`,
    `切り口: ${angle.angle}`,
    ``,
    firstLineBlock,
    ``,
    armBlock,
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
    extraDirective ? `# 追加指示\n${extraDirective}` : "",
    `# 依頼`,
    `まず firstLineDrafts に一行目の候補を3案書き、最も強い1案を冒頭に使って本文を書いてください。`,
    `上記の切り口と型で、20〜40代女性が思わず反応（いいね・保存・返信・リポスト）したくなるThreads投稿を1つ作成してください。`,
    `最優先はインプレッション（views）。手が止まる一行目 × 最後まで読ませる構成 × 反応したくなる中身。`,
    `まつげパーマ・眉毛WAX専門店ならではの美容の視点は自然に効かせるが、売り込みや宣伝臭は出さない。`,
    `いいね・コメント・フォロー・シェアの明示的なお願い（エンゲージメントベイト）は絶対にしない（Threadsの配信で降格されるため）。`,
  ]
    .filter((l) => l !== "")
    .join("\n");

  const res = await client().messages.create({
    model: MODEL,
    max_tokens: 1500, // L（〜220字）の本文＋thinking無しでもJSON構造化に十分な余裕
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

/**
 * HTML/Markup由来のゴミを除去する（保険）。
 * モデルが稀に <br>/</br> のようなタグやHTMLエンティティを紛れ込ませることがあり、
 * AI生成であることが露呈する重大な事故になるため、後段で機械的に必ず取り除く。
 */
function stripHtmlArtifacts(text: string): string {
  return text
    .replace(/<\/?\s*(br|p|div|span|b|i|strong|em|ul|ol|li)\s*\/?>/gi, "\n")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]*\n[ \t]*\n[ \t]*\n+/g, "\n\n") // タグ除去で生じた3連以上の空行を圧縮
    .trim();
}

/** 本文を整える（HTML断片・括弧・引用符の除去／ハッシュタグなし／改行の確保／途中で切れない上限ガード） */
export function composePostText(post: GeneratedPost): string {
  const text = ensureLineBreaks(stripBrackets(stripHtmlArtifacts(post.text.trim())));
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

  const text = stripHtmlArtifacts(textOf((res as any).content))
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
    `## 大田区ローカルの背景（蒲田＋3km圏内の周辺エリア＋区全体）`,
    brand.localContext,
    `## 方針`,
    `- ${brand.contentMix}`,
    `- 各アングルは「思わず反応（いいね・保存・返信）したくなる」ことを最優先に狙う。予約・来店誘導は狙わない。`,
    `- 美容知識・お悩み共感・ケアのコツは、上から教えず自然な気づきとして織り込み信頼感を高める。`,
    `- 蒲田・大田区のローカルな常識・あるある・生活感を積極的に織り込み、地元の女性に「自分ごと」「わかる」と感じてもらう。蒲田だけに偏らず、3km圏内の周辺エリアや大田区全体のネタも混ぜる。`,
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
    sec("今の環境で伸びている型（週次の環境調査で更新）", playbook?.environmentTrends, 6),
    sec("バズを狙える切り口（今日のテーマに活かせそうなら取り入れる）", playbook?.viralAngles, 6),
    sec("今日のインプが狙える話題（自然に絡められそうなら1つ乗る）", learnings?.todayTopics, 6),
    sec("伸びた投稿の傾向（もっとやる）", learnings?.doMore, 6),
    sec("伸びなかった傾向（避ける）", learnings?.avoid, 6),
    sec(
      "実際に伸びた自店の投稿（ネタ選びの参考のみ。書き出し・締め方・構成・言い回しの流用は禁止）",
      learnings?.topExamples,
      2,
      (s) => s.replace(/\n/g, " ").slice(0, 60),
    ),
  ].filter(Boolean);
  if (!blocks.length) return "";
  return [
    `# バズる投稿の学び（型は固定・話題と実績は毎日更新。これを踏まえて改善する）`,
    `※以下は参考知見。「この投稿の型」の指定と食い違う場合（例: 問いかけで締める、とあるが型が言い切りの場合）は必ず型の指定を優先する。`,
    blocks.join("\n"),
  ].join("\n");
}

function buildPostSystemPrompt(): string {
  const r = brand.postRules;
  return [
    `あなたは「${brand.name}」（${brand.area}の${brand.businessType}）の${brand.persona}です。`,
    `Threadsで『バズる × 蒲田 × 美容』の投稿を作り、インプレッション（views）を最大化して20〜40代女性に広く認知されることを狙います。`,
    `売り込みではなく、思わず反応したくなる共感・気づき・あるあるで拡散を狙う発信者です。`,
    `投稿の「型」（書き出し・長さ・締め方・蒲田言及・話題乗り）は実測データから学習したものが毎回指定されます。必ずその型に従ってください。`,
    ``,
    `## 最重要原則`,
    `1. 一行目がすべて。フィードでは一行目しか見えない。一行目で指が止まらなければ残りは存在しないのと同じ。`,
    `2. 同じに見える投稿を絶対に作らない。書き出しの言い回し・締めの聞き方・構成が直近の投稿と重なったら、それは失敗作。`,
    ``,
    `## 目的`,
    brand.goal,
    `## ターゲット`,
    brand.audience,
    `## トーン`,
    brand.toneOfVoice,
    `## 専門（無理に売り込まないが、視点として自然に効かせる）`,
    brand.services.map((s) => `- ${s}`).join("\n"),
    `## 大田区ローカルの背景（蒲田＋3km圏内の周辺エリア＋区全体・親近感やあるあるづくりに活用）`,
    brand.localContext,
    ``,
    `## 投稿の条件`,
    `- 日本語。長さ・書き出し・締め方は指定された型に従う。全体で最大${r.maxLength}文字を厳守（超えない・途中で切らない）。`,
    `- 「」『』や""''などの括弧・引用符は使わない。`,
    `- HTMLタグ（<br>、</br>、<p> など）やHTMLエンティティ、A/B・①②・a) b) のような記号的な箇条書きラベルは絶対に使わない。改行は実際の改行文字だけで表す。使うとAI生成が露呈する重大な事故になる。`,
    `- 選択肢や候補を並べる投稿は、それぞれを改行で区切り自然な日本語の一文にする（ラベルを振らない）。1行に詰め込まず、一瞬で構造が分かる見た目にする。`,
    `- 抜け感のあるトーン。句点（。）はあえて省き、宣伝感を出さない。`,
    `- 一行目に全力を注ぐ（具体・意外性・自分ごと化。ラベル的な見出しで逃げない）。直近の投稿と似た書き出しは禁止。`,
    `- 締め方の言い回しも毎回変える。特に「どっち派？」「わかる人いる？」のような定番の聞き方を連発しない。`,
    `- 基本は38文字以内の一撃短文（削れる言葉は全部削る。説明せず、言い切るか描写する）。長め（80字超）の指定がある回だけ 導入→展開→オチ の流れにする。`,
    `- 視認性を最優先に、意味のまとまりごとに改行し、適度に空行で余白を作る。1行は長くしすぎない（目安20〜30文字以内）。ただし不自然な分割はしない。`,
    `- 最優先はインプレッション（表示回数）。共感・保存・返信・リポストされやすい中身にする。美容の知識やお悩み解決は、押し付けず自然な気づきとして織り込む。`,
    `- いいね・コメント・フォロー・シェアの明示的なお願い（エンゲージメントベイト）は絶対にしない。Threadsの配信アルゴリズムで降格される。自然な問いかけはOK。`,
    `- 他人の投稿の丸写し・使い回しに見える内容は書かない（非オリジナルコンテンツは配信降格される）。毎回オリジナルの視点・言い回しにする。`,
    `- 売り込み・宣伝・予約や来店の呼びかけは基本的にしない（目的は認知）。別途「予約導線」の指示がある場合のみ、それに従う。`,
    `- エリア言及の指示がある回は、蒲田だけでなく3km圏内の周辺エリアや大田区全体の地元感・あるある・生活感も織り込み『自分ごと』と感じてもらう。事実に反することは書かない。`,
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
