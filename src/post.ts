import { env, brand } from "./config";
import { ThreadsClient } from "./threads";
import { clip } from "./text";
import { generatePost, generateAppealPost, composePostText } from "./anthropic";
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
import { loadContentPlan, pickAngle, pickCoupon, type Coupon } from "./content";
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
import { execFileSync } from "node:child_process";

// GitHubのスケジュール実行は間引かれ、1日に数回しか起動しないことがある。
// そのため「起動時に、予定時刻を過ぎた未投稿スロットをまとめて投稿」して1日の目標件数を確保する。
// ただし同じ瞬間に連投すると不自然なので、投稿の間は最低 MIN_SLOT_GAP_MINUTES 分あける。
// 1回の起動で投稿しすぎないよう上限を設ける（残りは次回起動で消化）。
const MAX_POSTS_PER_RUN = 8;
const CATCHUP_GAP_MS = MIN_SLOT_GAP_MINUTES * 60_000;
// 起動が1日数回に間引かれると、最後の起動より後の枠（主に夜）が消えてしまう。
// そこで1回の起動の中で次の枠まで待って投稿する。post.yml の timeout-minutes より短くすること。
const MAX_RUN_MS = 300 * 60_000;

// エリア言及の実測判定に使う地名（蒲田＋3km圏内の周辺エリア＋大田区全体）
const AREA_MENTION_PATTERN =
  /蒲田|大田区|大森|池上|糀谷|萩中|六郷|矢口|下丸子|千鳥町|田園調布|久が原|雪谷|石川台|羽田|馬込|洗足池|平和島/;

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
      return `一行目の出だしが過去投稿「${clip(hFirst, 20)}…」と同じ`;
    }
    if (bigramSimilarity(firstLine, hFirst) >= FIRST_LINE_SIMILARITY_THRESHOLD) {
      return `一行目が過去投稿「${clip(hFirst, 20)}…」と類似`;
    }
  }
  let maxSim = 0;
  for (const h of recent) maxSim = Math.max(maxSim, bigramSimilarity(text, h.text));
  if (maxSim >= SIMILARITY_THRESHOLD) return `本文全体が直近の投稿と類似（${maxSim.toFixed(2)}）`;
  return null;
}

/** 1日 n 枠のうち来店訴求に充てる枠の番号（1日の中で間隔をあけて配置する） */
function appealSlotIndices(n: number, perDay: number): number[] {
  const a = Math.min(perDay, n);
  return Array.from({ length: a }, (_, k) => Math.floor(((k + 0.5) * n) / a));
}

/** 待機に入る前に投稿履歴とスケジュール状態をコミットする（途中で落ちても二重投稿しないため） */
function persistState(): void {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  try {
    execFileSync("bash", [".github/scripts/commit-state.sh", "chore: 投稿状態を更新 [skip ci]"], {
      stdio: "inherit",
    });
  } catch (e: any) {
    warn(`状態のコミットに失敗: ${e?.message || e}`);
  }
}

async function main(): Promise<void> {
  const todayLabel = new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "full",
    timeZone: "Asia/Tokyo",
  }).format(new Date());
  log(`=== 自動投稿ルーチン開始 (${todayLabel}) ===`);

  let now = currentJst(new Date());
  const force = ["1", "true", "yes"].includes(
    (process.env.FORCE_POST || "").trim().toLowerCase(),
  );

  // 認知モード（awareness）では店舗誘導・予約CTA・クーポンを出さず、バズる美容の投稿に徹する
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
      `テーマ: [${angle.category}] ${clip(angle.angle, 60)}` +
        (coupon ? ` / クーポン: ${coupon.name}` : "") +
        ` / 型: ${arms.hook}×${arms.length}×${arms.ending}` +
        `${arms.kamata ? "×エリア" : ""}${arms.newsRiding ? "×話題" : ""}`,
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
      kamata: AREA_MENTION_PATTERN.test(finalText),
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

  /** 来店訴求の投稿を1件生成して公開する（美容情報の投稿の学習からは除外） */
  async function postAppeal(ordinal: number): Promise<void> {
    const coupons = plan.salonInfo?.coupons ?? [];
    const themes = brand.appealThemes.filter((t) => coupons.length > 0 || !t.includes("クーポン"));
    if (!themes.length) throw new Error("来店訴求の切り口（brand.json の appealThemes）がありません");
    const dayIndex = Math.floor(Date.parse(`${now.dateStr}T00:00:00Z`) / 86_400_000);
    const theme = themes[(dayIndex * brand.appealPostsPerDay + ordinal) % themes.length];
    const withCoupon = coupons.length > 0 && (ordinal % 2 === 0 || theme.includes("クーポン"));
    const coupon: Coupon | null = withCoupon ? coupons[(dayIndex + ordinal) % coupons.length] : null;
    log(`来店訴求: ${theme}${coupon ? ` / クーポン: ${coupon.name}` : ""}`);

    let post = await generateAppealPost(theme, coupon, history, plan.salonInfo);
    let finalText = composePostText(post);
    for (let attempt = 0; attempt < MAX_REGENERATIONS; attempt++) {
      const issue = diversityIssue(finalText, history);
      if (!issue) break;
      warn(`多様性ガード: ${issue}。作り直します（${attempt + 1}/${MAX_REGENERATIONS}）。`);
      post = await generateAppealPost(
        theme,
        coupon,
        history,
        plan.salonInfo,
        `直前の生成は不合格（理由: ${issue}）。一行目を全く別の言い回し・別の角度から書き直し、過去のどの投稿とも似ていない投稿にすること。`,
      );
      finalText = composePostText(post);
    }
    log(`生成 (${finalText.length}文字 / 来店訴求):\n${finalText}`);

    const id = await client.createPost({ text: finalText });
    log(`投稿成功! ID: ${id}`);
    history.push({
      date: new Date().toISOString(),
      topic: post.topic,
      text: finalText,
      postId: id,
      purpose: "appeal",
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

  // --- スケジュール: 予定時刻を過ぎた未投稿スロットを投稿し、次の枠が近ければ待って投稿する ---
  const startedAt = Date.now();
  let lastPostedAt = 0;
  let done = 0;
  let tried = 0;
  for (;;) {
    now = currentJst(new Date());
    const slots = computeDailySlots(now);
    let st = loadScheduleState();
    if (st.date !== now.dateStr) st = { date: now.dateStr, fired: [] };
    const appealSlots = appealSlotIndices(slots.length, brand.appealPostsPerDay);

    const due = slots
      .map((min, i) => ({ min, i }))
      .filter(({ min, i }) => min <= now.minuteOfDay && !st.fired.includes(i))
      .map(({ i }) => i);

    if (due.length === 0) {
      const nextIdx = slots.findIndex((m, i) => m > now.minuteOfDay && !st.fired.includes(i));
      if (nextIdx < 0) {
        log(`本日（${now.dateStr}）の ${slots.length} 枠はすべて消化済みです。`);
        break;
      }
      const waitMs = (slots[nextIdx] - now.minuteOfDay) * 60_000 + 30_000;
      if (Date.now() - startedAt + waitMs > MAX_RUN_MS) {
        log(
          `現在 ${now.hhmm} JST。次の枠 ${fmtMin(slots[nextIdx])} は待機上限を超えるため次回起動に任せます` +
            `（本日 ${slots.length} 枠 / 残り ${slots.length - st.fired.length} 枠）。`,
        );
        break;
      }
      persistState();
      log(`次の枠 ${fmtMin(slots[nextIdx])} JST まで約${Math.ceil(waitMs / 60_000)}分待機します。`);
      await sleep(waitMs);
      continue;
    }

    const batch = due.slice(0, MAX_POSTS_PER_RUN);
    log(
      `未投稿の予定スロット ${due.length} 件を検出。今回は ${batch.length} 件投稿します` +
        `（1回の上限 ${MAX_POSTS_PER_RUN} 件 / 残りは次回起動で消化）。`,
    );

    // その日の全スロットぶんの型の割り当て表（クォータ制約つき・決定的）。
    // 1日の中で書き出し・締め方などが必ず混ざることを構造的に保証する。
    const dayPlan = planDailyArms(model, now.seed, slots.length);

    for (const slotIndex of batch) {
      // 連投防止の間隔は、待機をはさんだ場合も含めて直前の投稿から数える
      const gap = lastPostedAt + CATCHUP_GAP_MS - Date.now();
      if (lastPostedAt > 0 && gap > 0) {
        log(`直前の投稿から${MIN_SLOT_GAP_MINUTES}分あけるため ${Math.ceil(gap / 60_000)}分待機します。`);
        await sleep(gap);
      }
      // 先にスロットを消化して保存（投稿失敗時もコミットされ二重投稿を防ぐ）
      st.fired.push(slotIndex);
      saveScheduleState(st);
      const appealOrdinal = appealSlots.indexOf(slotIndex);
      // 予約導線は1日1回だけ（通算 ctaOrdinal 件目）。認知モードでは入れない。
      const includeCta =
        appealOrdinal < 0 && !awareness && st.fired.length === ctaOrdinal(now.seed);
      log(
        `-- スロット ${slotIndex + 1}/${slots.length}（予定 ${fmtMin(slots[slotIndex])} JST / ` +
          `本日${st.fired.length}件目${appealOrdinal >= 0 ? " ★来店訴求" : ""}${includeCta ? " ★予約CTAあり" : ""}）`,
      );
      tried++;
      try {
        if (appealOrdinal >= 0) await postAppeal(appealOrdinal);
        else await postForSlot(slotIndex, includeCta, dayPlan[slotIndex]);
        done++;
      } catch (e: any) {
        // 1件失敗しても残りは続行（該当スロットは消化済みなので再投稿されない）
        error(`スロット ${slotIndex + 1} の投稿に失敗: ${e?.message || e}`);
      }
      lastPostedAt = Date.now();
    }
  }

  log(`=== 自動投稿ルーチン完了（${done}/${tried} 件投稿）===`);
  if (tried > 0 && done === 0) {
    // 全件失敗はジョブを赤くして気づけるようにする（以前は成功扱いで投稿停止に気づけなかった）
    process.exitCode = 1;
  }
}

main().catch((e: any) => {
  error(e?.stack || e?.message || String(e));
  process.exit(1);
});
