#!/usr/bin/env bash
# 按 DeepSeek Harness 生态约定把本插件发布到 GitHub：
#   创建仓库（若不存在）→ 推送当前分支 → 推送标签（含 TAG 指定的版本）。
#
# 凭据来源（按优先级，凭据只用于进程环境/请求头，绝不写入 .git/config 或仓库）：
#   1) gh CLI 已登录
#   2) 环境变量 GH_TOKEN / GITHUB_TOKEN
#   3) 文件 ~/.dsh/github-token（建议 umask 077 创建，仅本人可读）
#
# 用法：
#   bash scripts/publish-github.sh                     # 公开仓库 dsh-tidecost
#   VISIBILITY=private bash scripts/publish-github.sh
#   TAG=v0.1.0 bash scripts/publish-github.sh
set -euo pipefail

REPO_NAME="${REPO_NAME:-dsh-tidecost}"
VISIBILITY="${VISIBILITY:-public}" # public | private
DESCRIPTION="${DESCRIPTION:-DeepSeek Harness 侧边栏：余额 / 峰谷价 / 逐步用量花费 / 预算预警}"

cd "$(dirname "$0")/.."
ROOT="$PWD"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if [ "$VISIBILITY" != "public" ] && [ "$VISIBILITY" != "private" ]; then
  echo "publish: VISIBILITY 只能是 public 或 private" >&2
  exit 1
fi

# ── 凭据解析 ───────────────────────────────────────────────────────────────
TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [ -z "$TOKEN" ] && [ -f "$HOME/.dsh/github-token" ]; then
  TOKEN="$(tr -d '\r\n' < "$HOME/.dsh/github-token")"
fi

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  OWNER="$(gh api user --jq .login)"
  echo "== 使用 gh 登录账号：$OWNER"
  gh repo create "$OWNER/$REPO_NAME" --"$VISIBILITY" --description "$DESCRIPTION" \
    --source "$ROOT" --remote origin --push
  git push origin --tags 2>/dev/null || true
  [ -n "${TAG:-}" ] && git push origin "$TAG" || true
  echo "== 完成：https://github.com/$OWNER/$REPO_NAME"
  exit 0
fi

if [ -z "$TOKEN" ]; then
  cat >&2 <<'EOF'
publish: 缺少 GitHub 凭据。任选其一后重试：
  1) 安装并登录 gh CLI：  gh auth login
  2) 导出环境变量：       export GH_TOKEN=<PAT>
  3) 写入凭据文件：       umask 077; echo '<PAT>' > ~/.dsh/github-token
PAT 需具备：Contents=write；首次建仓还需 Administration=write（或先在 GitHub 手动建空仓）。
EOF
  exit 1
fi

api() {
  curl -fsS -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" "$@"
}

OWNER="${OWNER:-$(api https://api.github.com/user | sed -n 's/.*"login"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)}"
if [ -z "$OWNER" ]; then
  echo "publish: 无法解析 GitHub 账号（token 无效或权限不足）" >&2
  exit 1
fi
echo "== token 账号：$OWNER，目标仓库：$OWNER/$REPO_NAME（$VISIBILITY）"

PRIVATE=false
[ "$VISIBILITY" = "private" ] && PRIVATE=true

if ! api -o /dev/null "https://api.github.com/repos/$OWNER/$REPO_NAME"; then
  api -X POST https://api.github.com/user/repos \
    -d "{\"name\":\"$REPO_NAME\",\"private\":$PRIVATE,\"description\":\"$DESCRIPTION\"}" >/dev/null
  echo "== 已创建仓库 $OWNER/$REPO_NAME"
else
  echo "== 仓库已存在，直接推送"
fi

# token 只经环境变量传给 credential helper，不出现在 argv / .git/config / 远程 URL
export DSH_BALANCE_GH_TOKEN="$TOKEN"
CRED_HELPER='!f() { echo "username=x-access-token"; echo "password=$DSH_BALANCE_GH_TOKEN"; }; f'

git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/$OWNER/$REPO_NAME.git"
git -c credential.helper="$CRED_HELPER" push -u origin "$BRANCH"
git -c credential.helper="$CRED_HELPER" push origin --tags
if [ -n "${TAG:-}" ]; then
  git -c credential.helper="$CRED_HELPER" push origin "$TAG"
fi

echo "== 完成：https://github.com/$OWNER/$REPO_NAME"
