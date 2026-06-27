# 旧GASシステムの停止手順

新しい GitHub Actions ベースのシステムに切り替えたら、**二重投稿・二重返信を防ぐため、必ず旧 Google Apps Script（GAS）を停止**してください。

GAS は「トリガー」によって定期実行されています。トリガーを削除すれば自動実行は止まります（コードを消す必要はありません）。

## 手順

### 1. 新システムの稼働を確認

先に、本リポジトリの Actions（`Threads 自動投稿` / `Threads AI返信`）を **手動実行（Run workflow）** し、
Threadsに正しく投稿・返信されることを確認します。

### 2. GASのトリガーをすべて削除（自動実行を停止）

1. 旧システムの Google スプレッドシートを開く
2. 上部メニュー **拡張機能 → Apps Script** をクリックして Apps Script エディタを開く
3. 左side メニューの **トリガー（時計アイコン ⏰）** をクリック
4. 登録されているトリガーを確認します。次の関数が対象です:
   - `mainPostRoutine`（自動投稿）
   - `autoReplyRoutine`（AI返信）
   - `generateDailyReservations`（定期予約）
   - `updateInsightsRoutine`（インサイト更新）
   - `refreshAccessToken`（トークン更新）
5. 各トリガー右側の **「︙」→ トリガーを削除** で、**すべて削除**します

> トリガーがゼロになれば、GASは自動実行されなくなります。

### 3. （任意）誤実行を防ぐ追加対策

- スプレッドシート自体は履歴として残しておいて問題ありません。
- 念のためコードを無効化したい場合は、Apps Script エディタで `mainPostRoutine` と `autoReplyRoutine` の
  先頭に `return;` を追加するか、プロジェクトをアーカイブしてください。
- GASに保存されているアクセストークン（スクリプトプロパティ `THREADS_ACCESS_TOKEN`）は、
  新システムへ移行後は不要です。セキュリティのため削除を推奨します
  （プロジェクトの設定 → スクリプト プロパティ）。

### 4. 確認

- しばらく運用し、投稿・返信が **新システムからのみ** 行われていることを確認してください。
- もし旧GASからも投稿されてしまう場合は、トリガーが残っていないか再確認してください。

## 旧システムとの対応表

| 旧GASの機能 | 新システムでの対応 |
| --- | --- |
| `mainPostRoutine`（スプレッドシートの予約投稿） | `npm run post` — Claudeが季節・流行を踏まえ毎回自動生成して投稿 |
| `autoReplyRoutine`（Geminiでコメント返信） | `npm run reply` — Claudeでコメント返信 |
| `generateDailyReservations`（定期予約の生成） | 不要（毎回の自動生成に統合） |
| `updateInsightsRoutine`（インサイト取得） | 今回の移行対象外（必要なら別途追加可能） |
| `refreshAccessToken`（トークン更新） | `refresh-token` Workflow（毎週自動） |
| Geminiでの生成 | Claude（Opus 4.8）に変更 |
