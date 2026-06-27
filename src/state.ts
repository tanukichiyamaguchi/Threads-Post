import fs from "node:fs";
import path from "node:path";
import { paths } from "./config";

function ensureDir(): void {
  fs.mkdirSync(paths.state, { recursive: true });
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

const repliedFile = path.join(paths.state, "replied-comments.json");
const historyFile = path.join(paths.state, "post-history.json");

export interface PostHistoryItem {
  date: string;
  topic: string;
  text: string;
  postId?: string;
}

/** 返信済みコメントID（重複返信を防ぐ） */
export function loadRepliedIds(): Set<string> {
  return new Set(readJson<string[]>(repliedFile, []));
}

export function saveRepliedIds(ids: Set<string>): void {
  // 直近3000件だけ保持して肥大化を防ぐ
  writeJson(repliedFile, [...ids].slice(-3000));
}

/** 過去投稿の履歴（繰り返しを避けるためにClaudeへ渡す） */
export function loadPostHistory(): PostHistoryItem[] {
  return readJson<PostHistoryItem[]>(historyFile, []);
}

export function savePostHistory(items: PostHistoryItem[]): void {
  writeJson(historyFile, items.slice(-50));
}
