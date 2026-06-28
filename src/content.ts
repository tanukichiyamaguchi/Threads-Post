import fs from "node:fs";
import { paths } from "./config";

// 投稿の「素材」。Web検索APIを使わず、Claude Code（人手）が約2週間ごとに更新する。
// - salonInfo.coupons … HotPepperのクーポン上位5件（内容・価格）。空の間はクーポンに言及しない。
// - anglePool … 季節やメニューに沿った投稿アングル集。各投稿はここから本文化する。

export interface Coupon {
  name: string;
  price: string;
  content: string;
  note?: string;
}

export interface AngleItem {
  category: string; // menu / tips / trust / season など
  angle: string; // 投稿の切り口（1〜2文）
  coupon?: boolean; // クーポン紹介に向くアングルなら true
}

export interface SalonInfo {
  concept?: string;
  menu?: string[];
  accessHours?: string;
  coupons: Coupon[];
}

export interface ContentPlan {
  updated: string;
  salonInfo: SalonInfo;
  anglePool: AngleItem[];
}

export function loadContentPlan(): ContentPlan {
  let p: any;
  try {
    p = JSON.parse(fs.readFileSync(paths.contentPlan, "utf8"));
  } catch {
    p = { updated: "", salonInfo: { coupons: [] }, anglePool: [] };
  }
  if (!p.salonInfo) p.salonInfo = { coupons: [] };
  if (!Array.isArray(p.salonInfo.coupons)) p.salonInfo.coupons = [];
  if (!Array.isArray(p.anglePool)) p.anglePool = [];

  // 手動メンテのクーポン（config/coupons.json）があれば最優先で使う
  try {
    const c = JSON.parse(fs.readFileSync(paths.coupons, "utf8"));
    if (Array.isArray(c.coupons) && c.coupons.length > 0) {
      p.salonInfo.coupons = c.coupons.slice(0, 5);
    }
  } catch {
    /* ファイルが無ければ素材側のクーポンをそのまま使う */
  }
  return p as ContentPlan;
}

export function saveContentPlan(plan: ContentPlan): void {
  fs.writeFileSync(paths.contentPlan, JSON.stringify(plan, null, 2) + "\n");
}

/** 日付シードで決定的にインデックスをシャッフル（その日ごとに並びが変わる） */
function shuffledIndices(n: number, seed: number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  let a = (seed >>> 0) || 1;
  const rng = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

const FALLBACK_ANGLE: AngleItem = {
  category: "menu",
  angle:
    "まつげパーマまたは眉毛WAXの魅力やお悩み解決を、信頼感のある美容の視点で一つ伝える",
};

/** その日の slotIndex 番目の投稿に使うアングルを選ぶ */
export function pickAngle(plan: ContentPlan, seed: number, slotIndex: number): AngleItem {
  const pool = plan.anglePool;
  if (!pool.length) return FALLBACK_ANGLE;
  const order = shuffledIndices(pool.length, seed);
  return pool[order[slotIndex % pool.length]];
}

/** クーポンに触れるべき投稿なら、紹介するクーポンを1件返す（なければ null） */
export function pickCoupon(
  _plan: ContentPlan,
  _angle: AngleItem,
  seed: number,
  slotIndex: number,
): Coupon | null {
  const coupons = _plan.salonInfo?.coupons ?? [];
  if (!coupons.length) return null;
  // 宣伝感を抑えるため約4投稿に1回だけクーポンに触れる
  if (slotIndex % 4 !== 0) return null;
  return coupons[(slotIndex + seed) % coupons.length];
}
