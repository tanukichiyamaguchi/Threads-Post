import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

export const paths = {
  root,
  state: path.join(root, "state"),
  brand: path.join(root, "config", "brand.json"),
  // 2週に1回のリサーチで生成される素材（アングル集＋リサーチ由来の店舗情報）
  contentPlan: path.join(root, "state", "content-plan.json"),
  // 手動メンテのクーポン（正確な価格・内容。あればリサーチ結果より優先）
  coupons: path.join(root, "config", "coupons.json"),
};

export interface Brand {
  name: string;
  businessType: string;
  area: string;
  sourceUrl: string;
  audience: string;
  localContext: string;
  persona: string;
  toneOfVoice: string;
  services: string[];
  cta: string;
  postMode?: "awareness" | "conversion";
  appealPostsPerDay: number; // 1日の投稿のうち来店訴求に充てる件数（残りは美容情報の投稿）
  appealThemes: string[]; // 来店訴求の切り口（日替わりで順に使う）
  appealRules: string[]; // 来店訴求の書き方
  goal: string;
  contentMix: string;
  prohibitions: string[];
  postRules: {
    maxLength: number; // 生成の安全上限（クランプ）。長さの選択は学習が行い、9割はS（38字以内）に固定
    emoji: string;
    useHashtags: boolean;
  };
  replyRules: {
    maxLength: number;
    emoji: string;
    style: string;
  };
  compliance: string;
}

export const brand: Brand = JSON.parse(fs.readFileSync(paths.brand, "utf8"));
brand.appealPostsPerDay = Math.max(0, Math.floor(Number(brand.appealPostsPerDay) || 0));
brand.appealThemes = Array.isArray(brand.appealThemes) ? brand.appealThemes : [];
brand.appealRules = Array.isArray(brand.appealRules) ? brand.appealRules : [];

function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`環境変数 ${name} が未設定です。`);
  }
  return v.trim();
}

function opt(name: string): string {
  return (process.env[name] ?? "").trim();
}

export const env = {
  anthropicApiKey: () => req("ANTHROPIC_API_KEY"),
  threadsUserId: () => req("THREADS_USER_ID"),
  threadsToken: () => req("THREADS_ACCESS_TOKEN"),
  threadsUsername: () => opt("THREADS_USERNAME"),
};
