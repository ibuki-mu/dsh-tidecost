# dsh-tidecost

> DeepSeek Harness 侧边栏插件：**余额 / 峰谷价 / 逐步用量花费 / 预算预警** 一体化面板。
>
> 命名：**tide**（峰谷潮汐价）+ **cost**（花费/预算）。原名 `dsh-balance` 已更名；
> 旧数据目录与浏览器内的旧设置键会**自动迁移**（见下文）。

在 DSH Web 侧边栏脚部新增「余额」模块：实时显示账户余额、当前会话每一步的 token 用量与花费、DeepSeek 官方峰谷价档位与倒计时、预算设定与三级预警，并在峰价时段每日首次对话前弹窗确认。

## 功能

| 模块 | 说明 |
|---|---|
| 账户余额 | 官方 `GET /user/balance`（`ctx.credentials` 解析 `DEEPSEEK_API_KEY`），60s 缓存 + 手动刷新 |
| 逐步用量 | 当前会话每步（turn/step）的 input/output/cache 命中/缓存写入/reasoning token、模型、费用 |
| 峰谷价提醒 | 当前档位（峰价 ×2 / 谷价 ×0.5）、距下一档倒计时、北京时间时段表、档位翻转自动提醒 |
| 对话前确认 | **峰价时段每日首次**对话前弹窗确认（可开关、可当日不再提醒；周末/节假日不弹） |
| 预算 | 会话预算**按会话隔离**；月度预算 / 余额预警线 / 预警比例全局；超预算或接近上限时预警 |
| Agent 工具 | `dsh_balance`：快速查询余额、会话花费、峰谷档位与预警 |

## 官方峰谷价与价格纪年

按 DeepSeek 官方公告实现（**按调用发生时刻计价**，历史调用不会被新价格改写）：

| 生效时间（北京） | 规则 |
|---|---|
| 2026-08-16 16:00Z 之前 | 峰谷时代前基础价（legacy，仅历史行） |
| 2026-08-17 起 | 峰谷分时定价：峰 = 周一至周五 09:00–12:00、14:00–18:00；谷价 = 峰价一半 |
| 2026-08-23 起 | 周末全天谷价 |
| 2026-09-10 12:00 起 | Flash 系列降价（`deepseek-flash` / `deepseek-v4-flash` / `-vision-exp`）：谷 0.02 / 1 / 4，峰 0.04 / 2 / 8（元/百万 token）；Pro 未调整 |

- 计费口径：`input×未命中价 + output×输出价 + (cacheRead + cacheWrite)×命中价`（元/百万 token）。
- **节假日**：官方按谷价计费。在 `$DSH_HOME/dsh-tidecost/holidays.json` 写北京日期数组（如 `["2026-10-01"]`）即可**热更生效**（无需重启），也可用插件 Config 的 `holidays`。
- 官方调价只需更新 `src/shared/tide.ts` 的价格纪年常量（文件头有说明）。

## 安装

要求：DeepSeek Harness（`dsh` CLI）与 pnpm。

```sh
# 1) 官方装配（GitHub）
dsh plugin --profile web add github:ibuki-mu/dsh-tidecost

# 或本地开发目录
dsh plugin --profile web add link:/path/to/dsh-tidecost

# 2) 重启 dsh web 生效（bundle 插件无进程内热重载）
```

仓库按 DSH 生态约定：标准插件包格式（`package.json` + `lib/`）、`dsh.client.platform=web`、
`peerDependencies` 全范围声明（不硬编码 DSH 版本）、`lib/` 预构建随仓库提交（装配时无需构建）。

## 配置（插件 Config）

| 字段 | 默认 | 说明 |
|---|---|---|
| `apiBaseUrl` | `https://api.deepseek.com` | 余额接口基址（不用于模型调用） |
| `balanceCacheMs` | `60000` | 余额缓存时长 |
| `holidays` | `[]` | 节假日北京日期名单（YYYY-MM-DD）；`holidays.json` 优先 |
| `dataDir` | `$DSH_HOME/dsh-tidecost` | 数据目录（旧 dsh-balance 自动迁移） |

数据文件（均在 `dataDir`）：

| 文件 | 内容 |
|---|---|
| `budget.json` | 全局：`defaultSessionBudgetCny` / `monthlyBudgetCny` / `balanceWarnCny` / `warnThreshold` |
| `session-budgets.json` | `{ [sessionId]: 会话预算 }`（仅显式自定义过的会话） |
| `holidays.json` | 节假日名单（优先于 Config，热更） |
| `usage-log.jsonl` | 逐步用量流水（月结按调用时刻价格纪年重算） |

> 旧版把会话预算写在全局 `budget.json`：首次加载会自动迁移为「默认会话预算」，老数据不丢。

## HTTP API（同源，供面板使用）

| 端点 | 说明 |
|---|---|
| `GET /dsh-tidecost/api/overview?session=<id>` | 面板快照：余额、会话逐步用量、预算、峰谷相位、节假日、预警 |
| `GET /dsh-tidecost/api/balance?refresh=1` | 余额（强制刷新） |
| `GET /dsh-tidecost/api/budget?session=<id>` | 该会话生效预算 + 全局项 |
| `POST /dsh-tidecost/api/budget?session=<id>` | 保存：`sessionBudgetCny` 仅写该会话；`{resetSession:true}` 恢复默认；不带 `session` 则更新默认会话预算 |
| `GET /dsh-tidecost/api/session/<id>/usage` | 单会话逐步用量 |

## 隐私

- API Key 仅通过 `ctx.credentials` 在请求时解析，**不写入日志、不落盘、不经前端**。
- 插件仅在查询余额时访问 DeepSeek 官方接口；其余数据全部本地计算与存储。

## 开发

```sh
npm install                 # 安装 devDependencies（typescript / tsdown / @types/*）
bash scripts/build.sh       # 链接 DSH 类型依赖 + tsc 编译 host
npm run build:client        # tsdown 打包 host bundle + client bundle
npm run typecheck           # host 类型检查

node test/tide.mjs          # 峰谷数学 / 价格纪年
node test/peakgate.mjs      # 峰价确认门控
node test/budget.mjs        # 会话预算隔离（驱动打包后 host）
node test/budget-input.mjs  # 预算输入框回归
```

客户端类型检查（自包含、仅依赖 react 类型）：

```sh
npx tsc --noEmit --jsx react-jsx --module esnext --moduleResolution bundler \
  --target ES2023 --lib ES2023,DOM --skipLibCheck --strict --types node,react src/client/index.tsx
```

提交规范见 [`AGENTS.md`](./AGENTS.md)。

## 许可证

[BSD-3-Clause](./LICENSE) © 2026 ibuki_mu
