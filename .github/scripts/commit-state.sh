#!/usr/bin/env bash
# state/ 配下の更新（投稿履歴・返信履歴）をリポジトリにコミット＆プッシュする。
# 失敗しても本処理は成功扱いのままにするため、常に exit 0 で終了する。
set -u

MESSAGE="${1:-chore: 状態を更新 [skip ci]}"
BRANCH="${GITHUB_REF_NAME:-main}"

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

git add state/ 2>/dev/null || true

if git diff --staged --quiet; then
  echo "状態に変更はありません。"
  exit 0
fi

git commit -m "${MESSAGE}" || { echo "コミットなし"; exit 0; }

for i in 1 2 3; do
  git pull --rebase --autostash origin "${BRANCH}" || true
  if git push origin "HEAD:${BRANCH}"; then
    echo "状態をプッシュしました。"
    exit 0
  fi
  echo "プッシュに失敗。再試行 ${i}/3"
  sleep $((i * 3))
done

echo "状態のプッシュに失敗しました（投稿/返信処理自体は成功しています）。"
exit 0
