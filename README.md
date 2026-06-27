# Threads 自動投稿・AI返信システム（Claude API）

KATEstageLASH 蒲田西口店向けの、**Threadsの集客投稿とコメントへのAI返信を Claude API で自動化**するシステムです。
Claude（Opus 4.8）が **Web検索で今の季節・流行・話題を調べ**、その時期に最も集客効果が高い投稿を毎回自動生成します。
**GitHub Actions のスケジュール実行**で動くため、サーバー不要・追加費用なし（GitHub無料枠＋API利用料のみ）で運用できます。

> このシステムは、現在 Google Apps Script（GAS）で動いている旧システムを置き換えるものです。
> 切り替え後は **必ず旧GASを停止**してください → [docs/MIGRATION.md](docs/MIGRATION.md)

---

## できること

| 機能 | 内容 | 実行頻度（デフォルト） |
| --- | --- | --- |
| 自動投稿 | 季節・流行を踏まえた集客投稿を生成し公開 | 1日2回（10:00 / 18:00 JST） |
| AI返信 | 投稿へのコメントに広報担当として自然に返信 | 30分ごと |
| トークン更新 | Threadsの長期トークンを自動更新 | 毎週月曜 |

- AIエンジンは **Gemini → Claude（Opus 4.8）** に変更。投稿・返信ともに Claude が担当します。
- 投稿内容は **完全自動生成**（過去投稿も参照し、言い回しの繰り返しを回避）。
- 店舗情報・トーン・ハッシュタグなどは [`config/brand.json`](config/brand.json) を編集するだけでカスタマイズできます。

---

## セットアップ

### 1. 必要なもの

- **Anthropic（Claude）APIキー** … <https://console.anthropic.com>
- **Threads（Meta）API のアクセス情報**
  - `THREADS_USER_ID`（ThreadsユーザーID）
  - `THREADS_ACCESS_TOKEN`（長期アクセストークン）
  - 取得方法: Meta for Developers で Threads API アプリを作成 → <https://developers.facebook.com/docs/threads>
- **自分のThreadsユーザーネーム**（`@`なし）… 自分のコメントにAIが返信しないために使用

### 2. GitHub Secrets を設定

リポジトリの **Settings → Secrets and variables → Actions → New repository secret** で以下を登録します。

| Secret 名 | 内容 | 必須 |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Claude APIキー | ✅ |
| `THREADS_USER_ID` | ThreadsユーザーID | ✅ |
| `THREADS_ACCESS_TOKEN` | Threads長期アクセストークン | ✅ |
| `THREADS_USERNAME` | 自分のユーザーネーム（@なし） | ✅ |
| `GH_PAT` | トークン自動更新用のPAT（任意。下記参照） | 任意 |

### 3. スケジュール実行を有効化

- GitHub の **スケジュール（cron）トリガーはデフォルトブランチでのみ動作**します。
  このコードを `main`（デフォルトブランチ）にマージしてください。
- リポジトリの **Actions** タブで Workflow を有効化します。
- すぐ試したい場合は各 Workflow の **「Run workflow」（手動実行）** から動作確認できます。

これで自動投稿・AI返信が定期的に動き始めます。

### 4. （重要）旧GASを停止

切り替えが確認できたら、二重投稿を防ぐため旧GASを停止します。
手順は [docs/MIGRATION.md](docs/MIGRATION.md) を参照してください。

---

## カスタマイズ

### 投稿内容・トーン

[`config/brand.json`](config/brand.json) を編集します（店舗名・エリア・ターゲット・メニュー・CTA・文字数・絵文字・ハッシュタグなど）。
コードを触らずに、生成される投稿のスタイルを調整できます。

### 投稿頻度・時間

`.github/workflows/post.yml` と `reply.yml` の `cron` を変更します（**UTC基準**。JST = UTC+9）。

```yaml
# 例: 12:00 JST に1回だけ投稿 → 03:00 UTC
- cron: "0 3 * * *"
```

### トークンの自動更新（任意・推奨）

Threadsの長期トークンは約60日で失効します。`refresh-token` Workflow が毎週更新しますが、
**更新後の新トークンをSecretへ自動反映**するには、`secrets` 書き込み権限を持つ
[Fine-grained Personal Access Token](https://github.com/settings/tokens?type=beta)（権限: *Secrets: Read and write*）を
`GH_PAT` という名前のSecretに登録してください。
未設定の場合、トークンの更新自体は行われますが、Secretへの反映は手動になります（新トークンは安全のためログに出力しません）。

---

## ローカルでの動作確認

```bash
npm install
cp .env.example .env   # .env に各値を設定
npm run post           # 1回投稿（実際にThreadsへ投稿されます）
npm run reply          # コメントへ返信
npm run typecheck      # 型チェック
```

`.env` の `THREADS_ACCESS_TOKEN` 等を空にしておくと、実投稿せず環境変数エラーで止まります（安全確認用）。

---

## 構成

```
config/brand.json            店舗・投稿スタイルの設定（ここを編集）
src/
  config.ts                  環境変数・brand.json の読み込み
  anthropic.ts               Claude 連携（トレンド調査・投稿生成・返信生成）
  threads.ts                 Threads Graph API クライアント
  state.ts                   投稿履歴・返信済みIDの永続化
  post.ts                    自動投稿エントリ
  reply.ts                   AI返信エントリ
  refresh-token.ts           トークン更新エントリ
state/                       実行状態（自動コミットされる）
.github/workflows/           スケジュール実行の定義
docs/MIGRATION.md            旧GASの停止手順
```

### 仕組み

1. **投稿** … Claude が Web検索で季節・流行を調査 → 過去投稿を踏まえて集客投稿を生成 → Threadsへ公開 → 履歴を保存。
2. **返信** … 自分の最近の投稿の会話を取得 → 新着コメントを抽出（自分・空・処理済みは除外）→ Claude が返信を生成 → コメントへ返信。
3. 実行状態（`state/`）は Actions が自動でコミットし、次回以降に引き継ぎます。

---

## 補足・注意

- 画像投稿は `src/threads.ts` の `createPost({ imageUrl })` で対応可能ですが、デフォルトはテキスト投稿です（画像URLのホスティングが別途必要）。
- **GitHub Actions の実行時間**: パブリックリポジトリは無料無制限です。プライベートリポジトリの場合は無料枠（月2,000分）に注意し、必要に応じて `reply.yml` の頻度（デフォルト30分ごと）を下げてください。
- AI生成投稿・返信は内容を完全には保証できません。重要なキャンペーン等は内容を確認のうえ運用してください。
- 景品表示法・医療広告ガイドラインに配慮するようプロンプトで指示しています（`config/brand.json` の `compliance`）。
