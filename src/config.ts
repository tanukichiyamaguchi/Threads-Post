import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

export const paths = {
  root,
  state: path.join(root, "state"),
  brand: path.join(root, "config", "brand.json"),
};

export interface Brand {
  name: string;
  businessType: string;
  area: string;
  audience: string;
  persona: string;
  toneOfVoice: string;
  services: string[];
  cta: string;
  postRules: {
    maxLength: number;
    targetLength: string;
    emoji: string;
    hashtagCount: string;
    baseHashtags: string[];
  };
  replyRules: {
    maxLength: number;
    emoji: string;
    style: string;
  };
  compliance: string;
}

export const brand: Brand = JSON.parse(fs.readFileSync(paths.brand, "utf8"));

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
