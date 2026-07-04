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
const playbookFile = path.join(paths.state, "viral-playbook.json");

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
 * 「バズる投稿の型」を一度詳しく調査した静的な参照（プレイブック）。
 * playbook ルーチンで作成し、頻繁には更新しない。各投稿の生成時に注入する。
 */
export interface ViralPlaybook {
  updated: string;
  playbook: string[]; // バズる投稿の型・原則（一度の詳細調査で作る）
  viralAngles: string[]; // 蒲田×美容で使える普遍的なバズ切り口
}

/**
 * 毎日更新する学習知見。改善ルーチン（improve）が
 * 「自店の過去実績の分析」と「その日のインプが狙える話題（全国/大田区/蒲田）」から作る。
 * 各投稿の生成時にプロンプトへ注入して投稿を日々改善する。
 */
export interface Learnings {
  updated: string;
  doMore: string[]; // 自店の実績で伸びた投稿の共通点・もっとやるべきこと
  avoid: string[]; // 伸びなかった投稿の共通点・避けるべきこと
  topExamples: string[]; // 自店の実際に伸びた投稿（お手本として提示）
  todayTopics: string[]; // その日のインプが狙える話題（全国/大田区/蒲田）＋美容や共感への絡め方
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

/** 毎日の学習知見（自店実績の分析＋その日の話題）を読み込む */
export function loadLearnings(): Learnings | null {
  const l = readJson<any>(learningsFile, null);
  if (!l || typeof l !== "object") return null;
  const arr = (x: any): string[] => (Array.isArray(x) ? x.map(String) : []);
  return {
    updated: String(l.updated ?? ""),
    doMore: arr(l.doMore),
    avoid: arr(l.avoid),
    topExamples: arr(l.topExamples),
    todayTopics: arr(l.todayTopics),
  };
}

export function saveLearnings(l: Learnings): void {
  writeJson(learningsFile, l);
}

/** バズる投稿の型（プレイブック・静的）を読み込む */
export function loadViralPlaybook(): ViralPlaybook | null {
  const p = readJson<any>(playbookFile, null);
  if (!p || typeof p !== "object") return null;
  const arr = (x: any): string[] => (Array.isArray(x) ? x.map(String) : []);
  return {
    updated: String(p.updated ?? ""),
    playbook: arr(p.playbook),
    viralAngles: arr(p.viralAngles),
  };
}

export function saveViralPlaybook(p: ViralPlaybook): void {
  writeJson(playbookFile, p);
}
