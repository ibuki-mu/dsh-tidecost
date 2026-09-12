# AGENTS.md — 仓库约定（供 AI/协作者）

## 铁律：每一步都提交（commit）

**每一次完成一个可描述的改动步骤后，必须立即 `git commit`**，不要攒大批改动一次性提交。

- 提交信息用**中文 Conventional Commits**：`feat` / `fix` / `docs` / `chore` / `build` / `test` / `refactor` / `perf`。
- 一次提交只做一件事；标题 ≤ 50 字，正文列要点（`- ` 列表）。
- 改动构建产物时必须与源码**同一步**提交（见下）。

## 提交前检查清单

1. `npm run typecheck`（host）通过。
2. 客户端类型检查通过：
   ```sh
   npx tsc --noEmit --jsx react-jsx --module esnext --moduleResolution bundler \
     --target ES2023 --lib ES2023,DOM --skipLibCheck --strict --types node,react src/client/index.tsx
   ```
3. 单测全绿：`node test/tide.mjs && node test/peakgate.mjs && node test/budget.mjs && node test/budget-input.mjs`
4. 改了 `src/` 后必须重建产物：`bash scripts/build.sh && npm run build:client`，并把 `lib/` 一起提交。

## 仓库结构约定（DSH 生态）

- 包名 `dsh-<name>`；`main` 指向 `lib/index.js`，`exports["./client"]` 指向 `lib/client.js`。
- `lib/` 为**预构建产物且随仓库提交**：DSH 从 GitHub 装配时不执行构建。
- `peerDependencies` 一律**范围声明**（如 `>=0.0.1-rc <2`），不硬编码 DSH 版本。
- client 侧不要引用已移除的包（如 `@deepseek-ai/dsh-client-runtime`）：bundle 运行时只依赖 `react`，
  槽位注册用运行时结构形态（`ctx.slots.inject/register` 双参签名）。
- host 插件自包含打包（除 `node:` 外全部打进 `lib/index.js`），任意装配路径都能加载。

## 禁止提交

- `node_modules/`、`*.tgz`、日志、`*.tsbuildinfo`。
- 任何密钥：`DEEPSEEK_API_KEY`、GitHub Token、`~/.dsh/.credentials.yaml` 内容。
- 本机绝对路径写死到源码（`scripts/build.sh` 的探测逻辑除外）。

## 发布（GitHub）

```sh
bash scripts/publish-github.sh          # 需要 gh 已登录，或 ~/.dsh/github-token / GH_TOKEN
git push origin --tags                  # 发布版本 tag（如 v0.1.0）
```

**仓库话题（必须）**：仓库需带 `dsh-plugin` 话题（DSH 生态检索约定），
默认还会加 `deepseek-harness`、`deepseek`。

- `scripts/publish-github.sh` 会尝试自动设置（`TOPICS=...` 可覆盖）；
- 自动设置需要 token 具备 **Administration = Read and write**；若权限不足，
  脚本只告警不失败，请在仓库 **About → Topics** 手动添加 `dsh-plugin`。
