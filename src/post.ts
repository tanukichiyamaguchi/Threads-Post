import { env, brand } from "./config";
import { ThreadsClient } from "./threads";
import { generatePost, composePostText } from "./anthropic";
import {
  loadPostHistory,
  savePostHistory,
  loadScheduleState,
  saveScheduleState,
  loadLearnings,
  loadViralPlaybook,
  loadBanditModel,
  type PostFeatures,
} from "./state";
import { loadContentPlan, pickAngle, pickCoupon } from "./content";
import {
  computeDailySlots,
  currentJst,
  fmtMin,
  ctaOrdinal,
  slotSeed,
  MIN_SLOT_GAP_MINUTES,
} from "./schedule";
import {
  chooseArms,
  planDailyArms,
  emptyModel,
  ensureArms,
  measureEndingArm,
  measureLengthArm,
  type ChosenArms,
} from "./bandit";
import { log, warn, error } from "./logger";

// GitHubのスケジュール実行は間引かれ、1日に数回しか起動しないことがある。
// そのため「起動時に、予定時刻を過ぎた未投稿スロットをまとめて投稿」して1日の目標件数を確保する。
// ただし同じ瞬間に連投すると不自然なので、投稿の間は最低 MIN_SLOT_GAP_MINUTES 分あける。
// 1回の起動で投稿しすぎないよう上限を設ける（残りは次回起動で消化）。
const MAX_POSTS_PER_RUN = 8;
const CATCHUP_GAP_MS = MIN_SLOT_GAP_MINUTES * 60_000;

// 多様性ガード: 直近の投稿と似すぎた本文・書き出しは作り直す
// （Threadsは反復的・非オリジナルなコンテンツの配信を降格するため。
//   一行目が最重要なので、本文全体とは別に一行目単体でも重複を検査する）
const SIMILARITY_THRESHOLD = 0.55; // 本文全体のバイグラム類似度の上限
const FIRST_LINE_SIMILARITY_THRESHOLD = 0.5; // 一行目同士のバイグラム類似度の上限
const FIRST_LINE_PREFIX_LEN = 6; // 一行目の先頭N文字が一致したら重複とみなす
const SIMILARITY_LOOKBACK = 30;
const MAX_REGENERATIONS = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 文字バイグラムのJaccard類似度（0〜1）。表記ゆれに頑健な軽量チェック */
function bigramSimilarity(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const t = s.replace(/\s+/g, "");
    const set = new Set<string>();
    for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter);
}

function firstLineOf(text: string): string {
  return text.split("\n")[0].trim();
}

function normalizeLine(s: string): string {
  return s.replace(/[\s、。！？!?・…]/g, "");
}

/** 本文・一行目の重複を検査し、問題があれば理由を返す（無ければ null） */
function diversityIssue(text: string, history: { text: string }[]): string | null {
  const recent = history.slice(-SIMILARITY_LOOKBACK);
  const firstLine = firstLineOf(text);
  const normFirst = normalizeLine(firstLine);

  for (const h of recent) {
    const hFirst = firstLineOf(h.text);
    // 一行目: 先頭が同じ、または一行目同士が似ている → 使い回しとみなす
    if (
      normFirst.length >= FIRST_LINE_PREFIX_LEN &&
      normalizeLine(hFirst).startsWith(normFirst.slice(0, FIRST_LINE_PREFIX_LEN))
    ) {
      return `一行目の出だしが過去投稿「${hFirst.slice(0, 20)}…」と同じ`;
    }
    if (bigramSimilarity(firstLine, hFirst) >= FIRST_LINE_SIMILARITY_THRESHOLD) {
      return `一行目が過去投稿「${hFirst.slice(0, 20)}…」と類似`;
    }
  }
  let maxSim = 0;
  for (const h of recent) maxSim = Math.max(maxSim, bigramSimilarity(text, h.text));
  if (maxSim >= SIMILARITY_THRESHOLD) return `本文全体が直近の投稿と類似（${maxSim.toFixed(2)}）`;
  return null;
}

async function main(): Promise<void> {
  const todayLabel = new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "full",
    timeZone: "Asia/Tokyo",
  }).format(new Date());
  log(`=== 自動投稿ルーチン開始 (${todayLabel}) ===`);

  const now = currentJst(new Date());
  const force = ["1", "true", "yes"].includes(
    (process.env.FORCE_POST || "").trim().toLowerCase(),
  );

  // 認知モード（awareness）では店舗誘導・予約CTA・クーポンを出さず、バズ×蒲田×美容に徹する
  const awareness = (brand.postMode ?? "conversion") === "awareness";

  env.anthropicApiKey();
  const client = new ThreadsClient(env.threadsUserId(), env.threadsToken());

  // 共通素材を一度だけ読み込む
  const plan = loadContentPlan(); // 投稿アングル集＋店舗情報（2週に1回更新）
  const playbook = loadViralPlaybook(); // バズる投稿の型（静的＋週次の環境トレンド）
  const learnings = loadLearnings(); // 毎日の学習知見（実績分析＋本日の話題）
  const model = loadBanditModel() ?? emptyModel(now.dateStr); // 学習モデル（毎日improveが更新）
  ensureArms(model);
  const history = loadPostHistory();

  /** 指定スロットの投稿を1件生成して公開し、特徴量つきで履歴に保存する */
  async function postForSlot(
    slotIndex: number,
    includeCta: boolean,
    plannedArms?: ChosenArms,
  ): Promise<void> {
    // その日の割り当て表（クォータ制約つき）から型を取得。force時はThompson単発
    const arms: ChosenArms = plannedArms ?? chooseArms(model, slotSeed(now.seed, slotIndex));
    const angle = pickAngle(plan, now.seed, slotIndex);
    const coupon = awareness ? null : pickCoupon(plan, angle, now.seed, slotIndex);
    log(
      `テーマ: [${angle.category}] ${angle.angle.slice(0, 60)}` +
        (coupon ? ` / クーポン: ${coupon.name}` : "") +
        ` / 型: ${arms.hook}×${arms.length}×${arms.ending}` +
        `${arms.kamata ? "×蒲田" : ""}${arms.newsRiding ? "×話題" : ""}`,
    );

    // 生成 → 多様性ガード（一行目の重複・本文の類似）で不合格なら理由を渡して作り直し
    let post = await generatePost(
      angle,
      coupon,
      history,
      arms,
      includeCta,
      plan.salonInfo,
      learnings,
      playbook,
    );
    let finalText = composePostText(post);
    for (let attempt = 0; attempt < MAX_REGENERATIONS; attempt++) {
      const issue = diversityIssue(finalText, history);
      if (!issue) break;
      warn(`多様性ガード: ${issue}。作り直します（${attempt + 1}/${MAX_REGENERATIONS}）。`);
      post = await generatePost(
        angle,
        coupon,
        history,
        arms,
        includeCta,
        plan.salonInfo,
        learnings,
        playbook,
        `直前の生成は不合格（理由: ${issue}）。特に一行目を全く別の言い回し・別の角度から書き直し、構成も変えて、過去のどの投稿とも似ていない投稿にすること。`,
      );
      finalText = composePostText(post);
    }
    log(`生成 (${finalText.length}文字 / ${post.topic}):\n${finalText}`);

    const id = await client.createPost({ text: finalText });
    log(`投稿成功! ID: ${id}`);

    // 学習用の特徴量。length/ending/kamata は実文から実測して記録（指示とのズレを補正）
    const features: PostFeatures = {
      hook: arms.hook,
      length: measureLengthArm(finalText),
      ending: measureEndingArm(finalText, arms.ending),
      kamata: /蒲田|大田区/.test(finalText),
      newsRiding: arms.newsRiding,
      slotHour: Math.floor(now.minuteOfDay / 60),
      weekend: now.weekend,
      explore: arms.explore || undefined,
    };

    history.push({
      date: new Date().toISOString(),
      topic: post.topic,
      text: finalText,
      postId: id,
      features,
    });
    savePostHistory(history);
  }

  // --- 手動（force）: スケジュールを無視して今すぐ1件投稿 ---
  if (force) {
    log("FORCE_POST 指定: スケジュールを無視して今すぐ投稿します。");
    await postForSlot(now.minuteOfDay, !awareness);
    log("=== 自動投稿ルーチン完了（force 1件）===");
    return;
  }

  // --- スケジュール: 予定時刻を過ぎた未投稿スロットをまとめて投稿 ---
  const slots = computeDailySlots(now);
  let st = loadScheduleState();
  if (st.date !== now.dateStr) st = { date: now.dateStr, fired: [] };

  const due = slots
    .map((min, i) => ({ min, i }))
    .filter(({ min, i }) => min <= now.minuteOfDay && !st.fired.includes(i))
    .map(({ i }) => i);

  if (due.length === 0) {
    const next = slots.find((s) => s > now.minuteOfDay);
    log(
      `現在 ${now.hhmm} JST は投稿予定時刻ではありません` +
        `（本日 ${slots.length} 投稿予定 / 残り ${slots.length - st.fired.length} 件 / ` +
        `次回 ${next !== undefined ? fmtMin(next) : "なし"}）。`,
    );
    return;
  }

  const batch = due.slice(0, MAX_POSTS_PER_RUN);
  log(
    `未投稿の予定スロット ${due.length} 件を検出。今回は ${batch.length} 件投稿します` +
      `（1回の上限 ${MAX_POSTS_PER_RUN} 件 / 残りは次回起動で消化）。`,
  );

  // その日の全スロットぶんの型の割り当て表（クォータ制約つき・決定的）。
  // 1日の中で書き出し・締め方などが必ず混ざることを構造的に保証する。
  const dayPlan = planDailyArms(model, now.seed, slots.length);

  let done = 0;
  for (const slotIndex of batch) {
    // 先にスロットを消化して保存（投稿失敗時もコミットされ二重投稿を防ぐ）
    st.fired.push(slotIndex);
    saveScheduleState(st);
    // 予約導線は1日1回だけ（通算 ctaOrdinal 件目）。認知モードでは入れない。
    const includeCta = !awareness && st.fired.length === ctaOrdinal(now.seed);
    log(
      `-- スロット ${slotIndex + 1}/${slots.length}（予定 ${fmtMin(slots[slotIndex])} JST / ` +
        `本日${st.fired.length}件目${includeCta ? " ★予約CTAあり" : ""}）`,
    );
    try {
      await postForSlot(slotIndex, includeCta, dayPlan[slotIndex]);
      done++;
    } catch (e: any) {
      // 1件失敗しても残りは続行（該当スロットは消化済みなので再投稿されない）
      error(`スロット ${slotIndex + 1} の投稿に失敗: ${e?.message || e}`);
    }
    if (slotIndex !== batch[batch.length - 1]) {
      log(`次の投稿まで ${MIN_SLOT_GAP_MINUTES}分 待機します（連投を避けるため）。`);
      await sleep(CATCHUP_GAP_MS);
    }
  }

  log(`=== 自動投稿ルーチン完了（${done}/${batch.length} 件投稿）===`);
}

main().catch((e: any) => {
  error(e?.stack || e?.message || String(e));
  process.exit(1);
});
