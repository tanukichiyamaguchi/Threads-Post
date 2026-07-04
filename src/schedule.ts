// 1日の投稿スケジュールを生成する。
// - 1日 POSTS_PER_DAY 件
// - 朝・昼・夜に分散しつつ、視聴率の高い時間帯（昼・夜のピーク）に多く配分
// - 具体的な時刻は日付シードで決まるため、毎日少しずつ変動する

const POSTS_PER_DAY = 40;

// [JSTの時, 相対ウェイト]。ウェイトが大きい時間帯ほど投稿数が増える。
// 夜20〜22時台・昼12時台を最重視（エンゲージメントが高い傾向）。
const WEIGHTED_HOURS: Array<[number, number]> = [
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
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** その日の投稿時刻（minute of day, JST）を昇順で返す。要素数は POSTS_PER_DAY。 */
export function computeDailySlots(seed: number): number[] {
  const rng = mulberry32(seed);
  const total = WEIGHTED_HOURS.reduce((s, [, w]) => s + w, 0);

  // ウェイトに比例して各時間帯へ件数を配分（最大剰余法で合計を POSTS_PER_DAY に）
  const raw = WEIGHTED_HOURS.map(([, w]) => (w / total) * POSTS_PER_DAY);
  const counts = raw.map((x) => Math.floor(x));
  let remainder = POSTS_PER_DAY - counts.reduce((s, c) => s + c, 0);
  const byFraction = raw
    .map((x, i) => [x - Math.floor(x), i] as [number, number])
    .sort((a, b) => b[0] - a[0]);
  for (let k = 0; k < remainder; k++) counts[byFraction[k][1]]++;

  // 各時間帯の中で件数ぶんを散らして配置（毎日シードでずれる）
  const slots: number[] = [];
  WEIGHTED_HOURS.forEach(([hour], i) => {
    const c = counts[i];
    for (let k = 0; k < c; k++) {
      const minute = Math.floor((k + rng()) * (60 / c));
      slots.push(hour * 60 + Math.min(59, minute));
    }
  });
  slots.sort((a, b) => a - b);

  // 近接しすぎを避けるため最低8分の間隔を確保
  for (let i = 1; i < slots.length; i++) {
    if (slots[i] - slots[i - 1] < 8) {
      slots[i] = Math.min(23 * 60 + 59, slots[i - 1] + 8);
    }
  }
  return slots;
}

export interface JstNow {
  dateStr: string; // YYYY-MM-DD
  minuteOfDay: number;
  seed: number;
  hhmm: string;
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
  return {
    dateStr: `${p.year}-${p.month}-${p.day}`,
    minuteOfDay: hour * 60 + minute,
    seed: Number(`${p.year}${p.month}${p.day}`),
    hhmm: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

/** minute of day を HH:MM 表記に */
export function fmtMin(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** 投稿ごとに目安文字数をばらつかせる（20〜120字程度） */
export function pickTargetChars(seed: number, slotIndex: number): number {
  const rng = mulberry32((seed + (slotIndex + 1) * 7919) >>> 0);
  return 20 + Math.floor(rng() * 101); // 20〜120
}

/**
 * その投稿で「蒲田／大田区」に言及するか。
 * 1日のスロットのちょうど約6割を決定的に選ぶ（毎日メンバーは変動）。
 */
export function shouldMentionKamata(
  seed: number,
  slotIndex: number,
  totalSlots: number = POSTS_PER_DAY,
): boolean {
  const idx = Array.from({ length: totalSlots }, (_, i) => i);
  const rng = mulberry32((seed ^ 0x5f3a9c7b) >>> 0);
  for (let i = totalSlots - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const count = Math.round(totalSlots * 0.6); // 約6割
  return idx.slice(0, count).includes(slotIndex);
}

/**
 * 予約導線（プロフィールから）を入れる「その日の通算何件目の投稿か」を返す。
 * 1日1回だけCTAを入れるための番号。視認性の高い夜にあたる20〜25件目に置く。
 */
export function ctaOrdinal(seed: number): number {
  return 20 + (seed % 6); // 20〜25件目
}
