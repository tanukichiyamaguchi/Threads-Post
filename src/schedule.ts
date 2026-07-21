// 1日の投稿スケジュールを生成する。
// - 1日の件数はボリューム実験モデル（state/volume-model.json・週次で学習）から決まる（既定 9・範囲 3〜15）
// - 朝・昼・夜に分散しつつ、視聴率の高い時間帯に多く配分
//   （時間帯の重みは実測から学習した state/hour-weights.json を優先、無ければ静的な既定値）
// - 具体的な時刻は日付シードで決まるため、毎日少しずつ変動する

import { loadHourWeights, loadVolumeModel } from "./state";

// 運用者指定: 1日の投稿数は3〜15回に制限する。
export const MIN_POSTS_PER_DAY = 3;
export const MAX_POSTS_PER_DAY = 15;
export const DEFAULT_POSTS_PER_DAY = 9;

// スロット間の最低間隔（分）。当初の予定時刻の間引きだけでなく、
// 起動が遅れて複数件をまとめて投稿する際の「実際の投稿間隔」にも使う（連投防止）。
export const MIN_SLOT_GAP_MINUTES = 8;

// [JSTの時, 相対ウェイト]。ウェイトが大きい時間帯ほど投稿数が増える。
// 夜20〜22時台・昼12時台を最重視（エンゲージメントが高い傾向）。
// ※学習済みの重み（hour-weights.json）があればそちらが優先される。
export const WEIGHTED_HOURS: Array<[number, number]> = [
  [7, 2],
  [8, 3],
  [9, 2],
  [10, 1],
  [11, 2],
  [12, 4],
  [13, 2],
  [14, 1],
  [15, 1],
  [16, 1],
  [17, 2],
  [18, 3],
  [19, 3],
  [20, 4],
  [21, 5],
  [22, 3],
];

/** 決定的な擬似乱数（mulberry32）。同じseedなら毎回同じ並びを返す。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** その日の設定投稿数（ボリューム実験モデルから。3〜15にクランプ。範囲外・無効なら既定値） */
export function currentPostsPerDay(_now?: JstNow): number {
  const v = loadVolumeModel();
  const n = v?.postsPerDay;
  if (Number.isFinite(n) && n! >= MIN_POSTS_PER_DAY && n! <= MAX_POSTS_PER_DAY) return n!;
  return DEFAULT_POSTS_PER_DAY;
}

/** その日に使う時間帯重み（学習済みがあれば優先・平日/週末別） */
export function hourWeightsFor(weekend: boolean): Array<[number, number]> {
  const learned = loadHourWeights();
  const table = weekend ? learned?.weekend : learned?.weekday;
  if (table && table.length >= 8) return table;
  return WEIGHTED_HOURS;
}

/** その日の投稿時刻（minute of day, JST）を昇順で返す。 */
export function computeDailySlots(now: JstNow): number[] {
  const postsPerDay = currentPostsPerDay(now);
  const hours = hourWeightsFor(now.weekend);
  const rng = mulberry32(now.seed);
  const total = hours.reduce((s, [, w]) => s + w, 0);

  // ウェイトに比例して各時間帯へ件数を配分（最大剰余法で合計を postsPerDay に）
  const raw = hours.map(([, w]) => (w / total) * postsPerDay);
  const counts = raw.map((x) => Math.floor(x));
  let remainder = postsPerDay - counts.reduce((s, c) => s + c, 0);
  const byFraction = raw
    .map((x, i) => [x - Math.floor(x), i] as [number, number])
    .sort((a, b) => b[0] - a[0]);
  for (let k = 0; k < remainder; k++) counts[byFraction[k % byFraction.length][1]]++;

  // 各時間帯の中で件数ぶんを散らして配置（毎日シードでずれる）
  const slots: number[] = [];
  hours.forEach(([hour], i) => {
    const c = counts[i];
    for (let k = 0; k < c; k++) {
      const minute = Math.floor((k + rng()) * (60 / c));
      slots.push(hour * 60 + Math.min(59, minute));
    }
  });
  slots.sort((a, b) => a - b);

  // 近接しすぎを避けるため最低 MIN_SLOT_GAP_MINUTES 分の間隔を確保
  for (let i = 1; i < slots.length; i++) {
    if (slots[i] - slots[i - 1] < MIN_SLOT_GAP_MINUTES) {
      slots[i] = Math.min(23 * 60 + 59, slots[i - 1] + MIN_SLOT_GAP_MINUTES);
    }
  }
  return slots;
}

export interface JstNow {
  dateStr: string; // YYYY-MM-DD
  minuteOfDay: number;
  seed: number;
  hhmm: string;
  weekday: number; // 0=日 〜 6=土
  weekend: boolean; // 土日か
}

/** 現在時刻をJSTで分解する */
export function currentJst(d: Date): JstNow {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const p: Record<string, string> = Object.fromEntries(
    fmt.formatToParts(d).map((x) => [x.type, x.value]),
  );
  const hour = Number(p.hour) % 24;
  const minute = Number(p.minute);
  const dateStr = `${p.year}-${p.month}-${p.day}`;
  const weekday = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return {
    dateStr,
    minuteOfDay: hour * 60 + minute,
    seed: Number(`${p.year}${p.month}${p.day}`),
    hhmm: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    weekday,
    weekend: weekday === 0 || weekday === 6,
  };
}

/** minute of day を HH:MM 表記に */
export function fmtMin(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

// 文字数・エリア言及（蒲田＋周辺3km圏＋大田区）・締め方などの「型」の選択は src/bandit.ts の学習モデルが担う
// （以前の pickTargetChars / shouldMentionKamata はバンディットのアームに置き換え）。

/** 投稿ごとのアーム選択用シード（日付×スロットで決定的） */
export function slotSeed(seed: number, slotIndex: number): number {
  return (seed + (slotIndex + 1) * 7919) >>> 0;
}

/**
 * 予約導線（プロフィールから）を入れる「その日の通算何件目の投稿か」を返す。
 * 1日1回だけCTAを入れるための番号（conversionモードのみ使用）。
 */
export function ctaOrdinal(seed: number): number {
  return 3 + (seed % 4); // 3〜6件目（1日3〜15投稿の範囲内に収める）
}
