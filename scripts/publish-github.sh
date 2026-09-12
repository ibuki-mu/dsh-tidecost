#!/usr/bin/env bash
# 按 DeepSeek Harness 生态约定把本插件发布到 GitHub：
#   创建仓库（若不存在）→ 推送当前分支 → 推送标签 → 设置 `dsh-plugin` 等话题。
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
#   TOPICS=dsh-plugin,deepseek-harness bash scripts/publish-github.sh
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

# 格式预检：避免把占位符/半截内容当 token 去打 API（GitHub 只会回 401 Bad credentials）
if [ -n "$TOKEN" ]; then
  case "$TOKEN" in
    github_pat_*|ghp_*|gho_*|ghu_*|ghs_*|github_pat*|ghp*) ;;
    *)
      echo "publish: 凭据格式不像 GitHub token（应以 github_pat_ 或 ghp_ 开头，长度 40+）；请重新生成并写入" >&2
      echo "publish: 常见错误：把占位符 <your_token> 或 token 名称写进了 ~/.dsh/github-token" >&2
      exit 1
      ;;
  esac
  case "${#TOKEN}" in
    [0-3][0-9]) echo "publish: 凭据长度仅 ${#TOKEN} 字符，明显不是完整 token" >&2; exit 1 ;;
  esac
fi

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  OWNER="$(gh api user --jq .login)"
  echo "== 使用 gh 登录账号：$OWNER"
  gh repo create "$OWNER/$REPO_NAME" --"$VISIBILITY" --description "$DESCRIPTION" \
    --source "$ROOT" --remote origin --push
  git push origin --tags 2>/dev/null || true
  [ -n "${TAG:-}" ] && git push origin "$TAG" || true
  # DSH 生态约定：仓库带 dsh-plugin 话题
  gh repo edit "$OWNER/$REPO_NAME" --add-topic dsh-plugin --add-topic deepseek-harness 2>/dev/null || true
  echo "== 完成：https://github.com/$OWNER/$REPO_NAME"
  exit 0
fi

if [ -z "$TOKEN" ]; then
  cat >&2 <<'EOF'
publish: 缺少 GitHub 凭据。任选其一后重试：
  1) 安装并登录 gh CLI：  gh auth login
  2) 导出环境变量：       export GH_TOKEN=<PAT>
  3) 写入凭据文件：       umask 077; echo '<PAT>' > ~/.dsh/github-token
PAT 权限：Contents=write（推送）；Administration=write（建仓 + 设置话题，
不加也能推送，但话题需在 GitHub UI 手动添加）。
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

# 推送前同步远端：GitHub 网页上的改动会让本地推送被拒（non-fast-forward）。
# 这里先 fetch，若远端有我方缺失的提交则 rebase 到其上（保留双方提交）；冲突则中止。
if git -c credential.helper="$CRED_HELPER" fetch --quiet origin "$BRANCH" 2>/dev/null; then
  if ! git merge-base --is-ancestor "origin/$BRANCH" HEAD; then
    echo "== 远端 $BRANCH 有本地缺失的提交，先 rebase 到 origin/$BRANCH"
    if ! git rebase "origin/$BRANCH"; then
      git rebase --abort 2>/dev/null || true
      echo "publish: rebase 冲突，已中止（本地保持原状）；请手动处理后重试" >&2
      exit 1
    fi
  fi
fi

git -c credential.helper="$CRED_HELPER" push -u origin "$BRANCH"
git -c credential.helper="$CRED_HELPER" push origin --tags
if [ -n "${TAG:-}" ]; then
  git -c credential.helper="$CRED_HELPER" push origin "$TAG"
fi

# ── 仓库话题（DSH 生态约定：dsh-plugin）────────────────────────────────────
# 话题写入需要 Administration=write；失败只告警，不影响推送结果。
TOPICS="${TOPICS:-dsh-plugin,deepseek-harness,deepseek}"
TOPICS_JSON="$(printf '%s' "$TOPICS" | awk -F, '{printf "["; for (i=1;i<=NF;i++) printf "%s\"%s\"", (i>1?",":""), $i; printf "]"}')"
if curl -fsS -o /dev/null -X PUT \
     -H "Authorization: Bearer $TOKEN" \
     -H "Accept: application/vnd.github+json" \
     -H "X-GitHub-Api-Version: 2022-11-28" \
     "https://api.github.com/repos/$OWNER/$REPO_NAME/topics" \
     -d "{\"names\":$TOPICS_JSON}"; then
  echo "== 已设置话题：$TOPICS"
else
  echo "!! 设置话题失败（token 缺少 Administration=write）——请在仓库 About → Topics 手动添加：$TOPICS" >&2
fi

echo "== 完成：https://github.com/$OWNER/$REPO_NAME"
