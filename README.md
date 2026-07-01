# Threads 自動投稿・AI返信システム（Claude API）

KATEstageLASH 蒲田西口店向けの、**Threadsの集客投稿とコメントへのAI返信を Claude API で自動化**するシステムです。
Claude（Sonnet 5）が **Web検索で今の季節・流行・話題を調べ**、その時期に最も集客効果が高い投稿を毎回自動生成します。
**GitHub Actions のスケジュール実行**で動くため、サーバー不要・追加費用なし（GitHub無料枠＋API利用料のみ）で運用できます。

> このシステムは、現在 Google Apps Script（GAS）で動いている旧システムを置き換えるものです。
> 切り替え後は **必ず旧GASを停止**してください → [docs/MIGRATION.md](docs/MIGRATION.md)

---

## できること

| 機能 | 内容 | 実行頻度（デフォルト） |
| --- | --- | --- |
| リサーチ＆素材更新 | Web検索で公式情報・クーポン・季節を調べ、投稿素材を作成 | 約2週に1回（毎月1日・15日） |
| 自動投稿 | 素材から集客投稿を生成し公開 | 1日30回・朝昼夜のピーク重視・投稿時刻は毎日変動 |
| AI返信 | 投稿へのコメントに広報担当として自然に返信 | 約2時間ごと |
| トークン更新 | Threadsの長期トークンを自動更新 | 毎週月曜 |

### コストを抑えた2段構成

API費用を抑えるため、重い処理（Web検索リサーチ）と軽い処理（投稿生成）を分けています。

- **リサーチは2週に1回だけ**（`research`）。Web検索＋しっかり思考（effort高）で、公式情報・クーポン（上位5件）・季節の切り口を調べ、**投稿素材**（`state/content-plan.json`）を作成します。
- **各投稿は素材から本文だけを安価に生成**（Web検索なし・思考オフ・effort低）。1投稿あたり数秒・低コストです。
- 自動投稿は「10分ごとに起動して、その日の投稿予定時刻になったら1件投稿」。予定時刻は日付から決まるため**毎日少しずつ変わり**、昼12時台・夜20〜22時台などエンゲージメントの高い時間帯に多く配分されます。
- 投稿スタイル: 本文は **20〜80文字程度**（短く簡潔に／問いかけ・予約導線を含めて80字程度・最大85字、途中で切れない）／**冒頭で手を止めさせ、末尾は返信したくなる問いかけで締める**（会話が続くと拡散されやすい）／抜け感のあるトーンで句点（。）は省き、絵文字1〜2個で宣伝感を抑える／**括弧・引用符（「」『』""）は使わない**／**約6割の投稿に蒲田・大田区への言及**を入れる。
- 予約導線（プロフィールから）は**1日1回だけ**。
- クーポンの内容・価格は**確認できたもののみ**使用し、創作しません（景品表示法に配慮）。正確なクーポンは `config/coupons.json` に手入力でき、こちらが最優先されます。

- AIエンジンは **Gemini → Claude（Sonnet 5）** に変更。投稿・返信ともに Claude が担当します。
- 投稿内容は **完全自動生成**（過去投稿も参照し、言い回しの繰り返しを回避）。
- 店舗情報・トーン・文字数などは [`config/brand.json`](config/brand.json) を編集するだけでカスタマイズできます。

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
- 最初に **「Threads リサーチ＆素材更新」を1回手動実行**すると最新の素材になります（未実行でも初期素材で動きます）。
- すぐ試したい場合は各 Workflow の **「Run workflow」（手動実行）** から動作確認できます（自動投稿は `force` 入力で即時投稿）。

これで自動投稿・AI返信が定期的に動き始めます。

### 4. （重要）旧GASを停止

切り替えが確認できたら、二重投稿を防ぐため旧GASを停止します。
手順は [docs/MIGRATION.md](docs/MIGRATION.md) を参照してください。

---

## カスタマイズ

### 投稿内容・トーン

[`config/brand.json`](config/brand.json) を編集します（店舗名・エリア・ターゲット・メニュー・CTA・目的・内容配分・文字数・絵文字など）。
コードを触らずに、生成される投稿のスタイルや方針を調整できます。

### クーポン（内容・価格に言及させる）

クーポンは **2週に1回のリサーチ（`research`）が自動で調査**し、取得できたものを `state/content-plan.json` に反映します。手入力は不要です。
取得できている間は、約4投稿に1回クーポンの内容・価格に自然に触れます（価格・内容は確認できたものだけを使い、対象や初回限定などの条件も明記。創作はしません）。

> HotPepperはbotアクセスをブロックする場合があり、自動調査でクーポンを取得できないことがあります。その場合は投稿でクーポンに言及しません（誤った価格は出しません）。
> どうしても確実に出したい場合のみ、[`config/coupons.json`](config/coupons.json) に手動で5件まで入れられます（入れると自動取得より優先）。

### リサーチ・投稿アングル

投稿のネタ（アングル集）と店舗情報は `state/content-plan.json` に入っています。`research` ワークフローが2週に1回自動更新しますが、手で編集することもできます。
HotPepperはbotアクセスをブロックする場合があり、リサーチでクーポンを取得できないことがあります。その場合はクーポンを `config/coupons.json` に手入力してください。

### 投稿回数・時間帯

投稿の「回数」と「時間帯の重み付け」は `src/schedule.ts` で調整します。

- `POSTS_PER_DAY` … 1日の投稿件数（デフォルト 30）
- `WEIGHTED_HOURS` … `[JSTの時, 重み]` のリスト。重みが大きい時間帯ほど投稿数が増えます（昼12時台・夜20〜22時台を最重視）

`.github/workflows/post.yml` の `cron`（デフォルト `*/10 ...` = 10分ごと）は「どのくらいの頻度で予定時刻をチェックするか」を決めます。投稿時刻そのものは `schedule.ts` が日付ごとに自動で割り振ります。

返信の間隔は `.github/workflows/reply.yml` の `cron` を変更します（**UTC基準**。JST = UTC+9）。

```yaml
# 例: 返信を1時間ごと
- cron: "0 * * * *"
# 例: 返信を30分ごと
- cron: "*/30 * * * *"
```

本文の文字数の振れ幅（デフォルト20〜80文字）は `src/schedule.ts` の `pickTargetChars` で調整できます。

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
npm run research       # リサーチして投稿素材を更新（2週に1回でOK）
npm run post           # 1回投稿（実際にThreadsへ投稿されます）
npm run reply          # コメントへ返信
npm run typecheck      # 型チェック
```

`.env` の `THREADS_ACCESS_TOKEN` 等を空にしておくと、実投稿せず環境変数エラーで止まります（安全確認用）。

---

## 構成

```
config/brand.json            店舗・投稿スタイルの設定（ここを編集）
config/coupons.json          クーポン上位5件の手入力（最優先で使用）
src/
  config.ts                  環境変数・設定の読み込み
  content.ts                 投稿素材の読み込み・アングル/クーポン選択
  schedule.ts                1日30件の投稿時刻・本文字数の決定（毎日変動）
  anthropic.ts               Claude 連携（リサーチ・投稿生成・返信生成）
  threads.ts                 Threads Graph API クライアント
  state.ts                   投稿履歴・返信済みID・スケジュールの永続化
  research.ts                リサーチ＆素材更新エントリ（2週に1回）
  post.ts                    自動投稿エントリ
  reply.ts                   AI返信エントリ
  refresh-token.ts           トークン更新エントリ
state/content-plan.json      リサーチで生成される投稿素材（アングル集＋店舗情報）
state/                       実行状態（自動コミットされる）
.github/workflows/           スケジュール実行の定義
docs/MIGRATION.md            旧GASの停止手順
```

### 仕組み

1. **リサーチ（2週に1回）** … Claude が Web検索で公式情報・クーポン・季節を調査 → 投稿素材（クーポン情報＋アングル集）を `state/content-plan.json` に保存。
2. **投稿（10分ごと）** … 予定時刻なら素材からアングル（と必要に応じてクーポン）を選び、本文だけを安価に生成 → Threadsへ公開 → 履歴を保存。
3. **返信（2時間ごと）** … 自分の最近の投稿の会話を取得 → 新着コメントを抽出（自分・空・処理済みは除外）→ Claude が返信を生成 → コメントへ返信。
4. 実行状態（`state/`）は Actions が自動でコミットし、次回以降に引き継ぎます。

---

## 補足・注意

- 画像投稿は `src/threads.ts` の `createPost({ imageUrl })` で対応可能ですが、デフォルトはテキスト投稿です（画像URLのホスティングが別途必要）。
- **GitHub Actions の実行時間**: パブリックリポジトリは無料無制限です。プライベートリポジトリの場合は無料枠（月2,000分）に注意し、必要に応じて `post.yml`（10分ごと起動）や `reply.yml`（返信2時間ごと）の頻度を下げてください。
- AI生成投稿・返信は内容を完全には保証できません。重要なキャンペーン等は内容を確認のうえ運用してください。
- 景品表示法・医療広告ガイドラインに配慮するようプロンプトで指示しています（`config/brand.json` の `compliance`）。
