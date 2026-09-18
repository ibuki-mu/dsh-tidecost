/**
 * dsh-tidecost — host/client 共享的数据契约。
 * 纯类型（无运行时导出），host 与 client bundle 各自独立打包。
 */

/** 官方峰谷档位：legacy=峰谷生效前基础价，peak=峰，valley=谷。 */
export type TideTier = 'legacy' | 'peak' | 'valley' | 'flat'

/** 归一化后的 DeepSeek 账户余额。 */
export interface BalanceData {
  isAvailable: boolean
  currency: string
  /** 总余额（充值 + 赠送，即可用余额）。 */
  total: number
  /** 赠送余额。 */
  granted: number
  /** 充值余额。 */
  toppedUp: number
  /** 本次抓取时间（epoch ms）。 */
  fetchedAt: number
}

/** 会话中一次模型调用（一步）的用量与花费。 */
export interface StepUsage {
  /** 会话日志 seq。 */
  seq: number
  turn: number
  step: number
  time: number
  model?: string
  /** 该步的路由 provider（如 deepseek-official / zai）。 */
  provider?: string
  /** 该步计价档位：DeepSeek 峰谷档位，或按量计费 provider 的 `flat`。 */
  tier?: TideTier
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  /** 该步费用（人民币口径；美元计费 provider 按固定汇率折合）。 */
  costCny: number
  /** adapter 是否上报了 usage（无则 tokens 为 0、成本 0）。 */
  hasUsage: boolean
}

/** 一个会话的逐步用量汇总。 */
export interface SessionUsage {
  sessionId: string
  steps: StepUsage[]
  /** 总步数（assistant/message 事件数）。 */
  stepCount: number
  /** 有 usage 上报的步数。 */
  usedStepCount: number
  totalInput: number
  totalOutput: number
  totalCacheRead: number
  totalCacheWrite: number
  totalReasoning: number
  totalTokens: number
  totalCostCny: number
  /** 缓存命中率（0..1），无可计算数据时为 null。 */
  cacheHitRate: number | null
  startAt: number | null
  lastAt: number | null
  lastModel?: string
  /** 最近一步的路由 provider。 */
  lastProvider?: string
}

/**
 * 预算设定。
 * 会话预算按**会话隔离**（session-budgets.json），未单独设置时用全局默认；
 * 月度预算 / 余额预警线 / 预警比例为全局（budget.json）。
 */
export interface BudgetConfig {
  /** 当前会话生效的会话预算（¥）；0 = 不启用。无会话时为全局默认值。 */
  sessionBudgetCny: number
  /** 未单独设置时，新会话使用的默认会话预算（¥）。 */
  defaultSessionBudgetCny: number
  /** 当前会话是否已单独自定义会话预算。 */
  sessionBudgetCustom: boolean
  /** 月度预算（¥）；0 = 不启用（全局）。 */
  monthlyBudgetCny: number
  /** 余额预警线（¥）；余额 <= 该值时 danger（全局）。 */
  balanceWarnCny: number
  /** 预警比例（0..1）；花费 >= 预算 × 该值时 warn（全局）。 */
  warnThreshold: number
}

/** 当前峰谷相位快照。 */
export interface TideStatus {
  tier: TideTier
  inPeak: boolean
  isWeekend: boolean
  at: number
  /** 下一档切换时刻（周末 = 下周一首次入峰）。 */
  nextAtMs: number | null
  nextIntoPeak: boolean
  secondsUntilNext: number | null
}

export type AlertLevel = 'warn' | 'danger'
export type StatusLevel = 'ok' | 'warn' | 'danger'

export interface Alert {
  level: AlertLevel
  message: string
}

/** `/api/overview` 返回的完整面板快照。 */
export interface Overview {
  ok: boolean
  error?: string
  balance: BalanceData | null
  balanceError?: string
  session: SessionUsage | null
  budget: BudgetConfig
  monthCostCny: number
  tide: TideStatus
  /** 生效的节假日北京日期名单（YYYY-MM-DD），客户端用于本地时段判定/展示。 */
  holidays: string[]
  alerts: Alert[]
  level: StatusLevel
  now: number
}
