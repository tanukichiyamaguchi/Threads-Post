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
const repliedUsersFile = path.join(paths.state, "replied-users.json");
const historyFile = path.join(paths.state, "post-history.json");
const scheduleFile = path.join(paths.state, "post-schedule.json");
const learningsFile = path.join(paths.state, "learnings.json");
const playbookFile = path.join(paths.state, "viral-playbook.json");
const metricsFile = path.join(paths.state, "metrics.json");
const accountStatsFile = path.join(paths.state, "account-stats.json");
const modelFile = path.join(paths.state, "model.json");
const hourWeightsFile = path.join(paths.state, "hour-weights.json");
const volumeModelFile = path.join(paths.state, "volume-model.json");
const reportFile = path.join(paths.state, "report.md");

/**
 * 投稿生成時に選んだ「型」（バンディットのアーム）。
 * 学習の入力になる。length/ending は生成後の実文から実測して上書きする。
 */
export interface PostFeatures {
  hook: string; // 問題提起/数字/逆説/共感/あるある/リスト/意見募集/自己開示
  length: string; // S(20〜60)/M(61〜140)/L(141〜220)。詳細は bandit.ts の LENGTH_RANGES
  ending: string; // 二択質問/共感確認/開いた質問/言い切り
  kamata: boolean; // 蒲田・大田区への言及
  newsRiding: boolean; // 今日の話題に乗ったか
  slotHour: number; // 投稿時刻（JSTの時）
  weekend: boolean; // 土日か
  explore?: boolean; // 強制探索スロットだったか
}

export interface PostHistoryItem {
  date: string;
  topic: string;
  text: string;
  postId?: string;
  features?: PostFeatures; // 学習用の型タグ（生成時に記録）
}

/**
 * 「バズる投稿の型」を一度詳しく調査した静的な参照（プレイブック）。
 * playbook ルーチンで作成し、頻繁には更新しない。各投稿の生成時に注入する。
 */
export interface ViralPlaybook {
  updated: string;
  playbook: string[]; // バズる投稿の型・原則（一度の詳細調査で作る）
  viralAngles: string[]; // 蒲田×美容で使える普遍的なバズ切り口
  environmentTrends?: string[]; // 今の環境で伸びている型（週次の環境センシングで更新）
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

/**
 * 返信済みの「投稿×ユーザー」キー（`${postId}:${username}`）。
 * 同じ投稿の会話では一人につき1回までしか返信しないために使う。
 */
export function loadRepliedUsers(): Set<string> {
  return new Set(readJson<string[]>(repliedUsersFile, []));
}

export function saveRepliedUsers(keys: Set<string>): void {
  // 直近5000件だけ保持して肥大化を防ぐ
  writeJson(repliedUsersFile, [...keys].slice(-5000));
}

/** 過去投稿の履歴（繰り返し回避のプロンプト参照＋学習の特徴量ソース） */
export function loadPostHistory(): PostHistoryItem[] {
  return readJson<PostHistoryItem[]>(historyFile, []);
}

export function savePostHistory(items: PostHistoryItem[]): void {
  // 学習は投稿後72時間のスナップショットと突き合わせるため、約10日分（40件/日）を保持する
  writeJson(historyFile, items.slice(-400));
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
    environmentTrends: arr(p.environmentTrends),
  };
}

export function saveViralPlaybook(p: ViralPlaybook): void {
  writeJson(playbookFile, p);
}

// ==========================================
// 学習システムの状態（計測スナップショット・モデル・スケジュール重み）
// ==========================================

/** 投稿単位のインサイト値（threads.ts の MediaMetrics と同形。循環importを避けるため再定義） */
export interface MetricsValues {
  views: number;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  shares: number;
}

/**
 * 固定齢スナップショット。lifetime累積値を投稿齢24h/72h付近で記録し、
 * 投稿同士を比較可能にする（報酬の土台）。
 * post-history.json とファイルを分けることで、投稿ジョブとのgitコミット競合を避ける。
 */
export interface MetricsEntry {
  postedAt: string; // 投稿日時（ISO）
  s24?: MetricsValues & { fetchedAt: string }; // 投稿齢22〜30hで取得
  s72?: MetricsValues & { fetchedAt: string }; // 投稿齢66〜78hで取得
  dead?: { reason: string; at: string }; // 取得不可（削除済み・非対応など）→以後スキップ
}

export type MetricsStore = Record<string, MetricsEntry>; // key: postId

export function loadMetricsStore(): MetricsStore {
  return readJson<MetricsStore>(metricsFile, {});
}

export function saveMetricsStore(store: MetricsStore): void {
  // 21日より古いエントリは削除（学習済み・肥大化防止）
  const cutoff = Date.now() - 21 * 24 * 3600 * 1000;
  const pruned: MetricsStore = {};
  for (const [id, e] of Object.entries(store)) {
    const t = Date.parse(e.postedAt);
    if (!Number.isFinite(t) || t >= cutoff) pruned[id] = e;
  }
  writeJson(metricsFile, pruned);
}

/** アカウント全体の日次統計（フォロワー推移はAPIに履歴が無いため自前で記録） */
export interface AccountStatsEntry {
  date: string; // YYYY-MM-DD (JST)
  accountViews?: number; // User Insights の日次views
  followers?: number; // その日時点のフォロワー数
  postsPerDay?: number; // その日の設定投稿数（ボリューム実験の記録）
}

export function loadAccountStats(): AccountStatsEntry[] {
  return readJson<AccountStatsEntry[]>(accountStatsFile, []);
}

export function saveAccountStats(stats: AccountStatsEntry[]): void {
  // 直近180日分を保持
  writeJson(accountStatsFile, stats.slice(-180));
}

/** バンディットモデル（次元→アーム→ガウス統計）。構造の意味は src/bandit.ts を参照 */
export interface ArmStats {
  n: number; // 実効サンプル数（指数減衰する）
  mean: number; // 報酬平均
  m2: number; // 分散計算用の二乗偏差和（Welford）
}

export interface BanditModel {
  updated: string;
  decayAppliedOn: string; // 最後に減衰を適用した日（YYYY-MM-DD）
  dimensions: Record<string, Record<string, ArmStats>>; // dimensions.hook.問題提起 = {n, mean, m2}
  ingested: string[]; // 学習取り込み済みのpostId（二重学習防止・直近1000件）
}

export function loadBanditModel(): BanditModel | null {
  const m = readJson<any>(modelFile, null);
  if (!m || typeof m !== "object" || !m.dimensions) return null;
  return {
    updated: String(m.updated ?? ""),
    decayAppliedOn: String(m.decayAppliedOn ?? ""),
    dimensions: m.dimensions,
    ingested: Array.isArray(m.ingested) ? m.ingested.map(String) : [],
  };
}

export function saveBanditModel(m: BanditModel): void {
  writeJson(modelFile, { ...m, ingested: m.ingested.slice(-1000) });
}

/** 学習済みの時間帯重み（平日/週末別）。無ければ schedule.ts の静的重みを使う */
export interface HourWeights {
  updated: string;
  weekday: Array<[number, number]>; // [JSTの時, 重み]
  weekend: Array<[number, number]>;
}

export function loadHourWeights(): HourWeights | null {
  const h = readJson<any>(hourWeightsFile, null);
  if (!h || !Array.isArray(h.weekday) || !Array.isArray(h.weekend)) return null;
  return h as HourWeights;
}

export function saveHourWeights(h: HourWeights): void {
  writeJson(hourWeightsFile, h);
}

/** 投稿ボリュームの週次実験モデル */
export interface VolumeModel {
  weekStart: string; // 現在の週の開始日（YYYY-MM-DD・月曜）
  postsPerDay: number; // 今週の投稿数
  arms: Record<string, ArmStats>; // "30"/"40"/"50" → 週平均アカウントviewsの統計
  history: Array<{ week: string; postsPerDay: number; avgDailyViews: number }>;
}

export function loadVolumeModel(): VolumeModel | null {
  const v = readJson<any>(volumeModelFile, null);
  if (!v || typeof v !== "object" || !v.postsPerDay) return null;
  return v as VolumeModel;
}

export function saveVolumeModel(v: VolumeModel): void {
  writeJson(volumeModelFile, { ...v, history: (v.history ?? []).slice(-52) });
}

/** 週次の人間可読レポート */
export function saveReport(markdown: string): void {
  ensureDir();
  fs.writeFileSync(reportFile, markdown);
}
