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
const scheduleFile = path.join(paths.state, "post-schedule.json");
const learningsFile = path.join(paths.state, "learnings.json");

export interface PostHistoryItem {
  date: string;
  topic: string;
  text: string;
  postId?: string;
  metrics?: PostMetrics; // 改善ルーチンが後から追記する実績値
}

/** 投稿のエンゲージメント実績（Threads Insights から取得） */
export interface PostMetrics {
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  views: number;
  score: number; // 総合エンゲージメントスコア
  fetchedAt: string;
}

/**
 * 「バズる投稿」を毎日学習した知見。改善ルーチン（improve）が更新し、
 * 各投稿の生成時にプロンプトへ注入して投稿を日々改善する。
 */
export interface Learnings {
  updated: string;
  playbook: string[]; // バズる投稿の型・原則（Web調査＋自店の実績から）
  doMore: string[]; // 伸びた投稿の共通点・もっとやるべきこと
  avoid: string[]; // 伸びなかった投稿の共通点・避けるべきこと
  viralAngles: string[]; // 新しくバズを狙える切り口のアイデア
  topExamples: string[]; // 自店の実際に伸びた投稿（お手本として提示）
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

/** その日の投稿スロットの消化状況（二重投稿防止） */
export interface ScheduleState {
  date: string; // JSTの YYYY-MM-DD
  fired: number[]; // 実行済みスロットのインデックス
}

export function loadScheduleState(): ScheduleState {
  return readJson<ScheduleState>(scheduleFile, { date: "", fired: [] });
}

export function saveScheduleState(s: ScheduleState): void {
  writeJson(scheduleFile, s);
}

/** バズる投稿の学習知見（毎日 improve が更新） */
export function loadLearnings(): Learnings | null {
  const l = readJson<Learnings | null>(learningsFile, null);
  if (!l || typeof l !== "object") return null;
  return {
    updated: String(l.updated ?? ""),
    playbook: Array.isArray(l.playbook) ? l.playbook.map(String) : [],
    doMore: Array.isArray(l.doMore) ? l.doMore.map(String) : [],
    avoid: Array.isArray(l.avoid) ? l.avoid.map(String) : [],
    viralAngles: Array.isArray(l.viralAngles) ? l.viralAngles.map(String) : [],
    topExamples: Array.isArray(l.topExamples) ? l.topExamples.map(String) : [],
  };
}

export function saveLearnings(l: Learnings): void {
  writeJson(learningsFile, l);
}
