/**
 * dsh-tidecost — 侧边栏余额 / 会话逐步 token 用量与花费 / 预算预警（host 侧）。
 *
 * 数据源：
 *  - 余额：ctx.credentials 解析 DEEPSEEK_API_KEY → GET /user/balance
 *  - 逐步用量：ctx.sessions 的 live Session.events（assistant/message.usage +
 *    request/context.model），当前会话必为 live，无需读磁盘 JSONL
 *  - 月度累计：监听 session/event 把带 usage 的 assistant/message 追加到
 *    $DSH_HOME/dsh-tidecost/usage-log.jsonl（仅用于月度预算预警）
 *
 * 规范：所有资源注册挂 ctx.effect（热重载/卸载自动清理）；budget.json 原子写。
 */

import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { Session, SessionEvent, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type ToolRegistry from '@deepseek-ai/dsh-tools'
import z from 'schemastery'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import type {
  Alert,
  BalanceData,
  BudgetConfig,
  Overview,
  SessionUsage,
  StepUsage,
  StatusLevel,
  TideStatus,
} from './shared/types.js'
import { costCny as tideCostCny, isPeakAt, phaseAt, stepTier, tierAt, USD_CNY_DEFAULT } from './shared/tide.js'

type AppContext = Context & {
  credentials: CredentialProvider
  sessions: SessionStore
  webServer: WebServer
  tools: ToolRegistry
}

export const name = 'dsh-tidecost'
export const inject = ['credentials', 'sessions', 'webServer', 'tools']

export interface Config {
  apiBaseUrl: string
  balanceCacheMs: number
  /** 数据目录（缺省 $DSH_HOME/dsh-tidecost）。 */
  dataDir: string
  /** 节假日北京日期名单（YYYY-MM-DD）；节假日全天谷价。可被 dataDir/holidays.json 覆盖。 */
  holidays: string[]
  /** USD→CNY 汇率：把 Z.ai 等美元按量计费 provider 折合进 ¥ 预算/预警（缺省 7.1）。 */
  usdCny: number
}

export const Config = z.object({
  apiBaseUrl: z.string().default('https://api.deepseek.com'),
  balanceCacheMs: z.number().min(1000).default(60000),
  dataDir: z.string().default(''),
  holidays: z.array(z.string()).default([]),
  usdCny: z.number().min(0.1).default(USD_CNY_DEFAULT),
}) as unknown as Config

/** 经典 DeepSeek 官方单价（¥/百万 token）已废弃——改由 src/shared/tide.ts 的官方峰谷价计。 */

/** 全局预算默认值（会话预算默认值 + 月度/余额/预警比例）。 */
const DEFAULT_GLOBAL_BUDGET = {
  defaultSessionBudgetCny: 10,
  monthlyBudgetCny: 200,
  balanceWarnCny: 5,
  warnThreshold: 0.8,
}

/** 全局预算（budget.json）；旧版 sessionBudgetCny 自动迁移为 defaultSessionBudgetCny。 */
interface GlobalBudget {
  defaultSessionBudgetCny: number
  monthlyBudgetCny: number
  balanceWarnCny: number
  warnThreshold: number
}

const MAX_LOG_BYTES = 5 * 1024 * 1024

interface BalanceResponseInfo {
  currency?: string
  total_balance?: string | number
  granted_balance?: string | number
  topped_up_balance?: string | number
}

interface BalanceResponse {
  is_available?: boolean
  balance_infos?: BalanceResponseInfo[]
}

interface UsageLogRecord {
  time: number
  sessionId: string
  model?: string
  /** 路由 provider（旧记录可能缺失，缺省按模型名推断）。 */
  provider?: string
  usage: TokenUsage
  tier?: ReturnType<typeof stepTier>
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

function num(v: string | number | undefined): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = Number.parseFloat(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

export function apply(ctx: AppContext, config: Config): void {
  const logger = ctx.logger
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')

  // ── 数据目录（含旧包名 dsh-balance → dsh-tidecost 的一次性迁移）──────────
  // 仅在未显式配置 dataDir 时迁移；迁移失败则沿用旧目录继续读，避免丢数据。
  let dataDir = config.dataDir || join(dshHome, 'dsh-tidecost')
  if (!config.dataDir) {
    const legacyDir = join(dshHome, 'dsh-balance')
    try {
      if (!existsSync(dataDir) && existsSync(legacyDir)) {
        try {
          renameSync(legacyDir, dataDir)
          logger?.info?.('[dsh-tidecost] 已迁移旧数据目录 %s → %s', legacyDir, dataDir)
        } catch {
          dataDir = legacyDir // 迁移失败：沿用旧目录，保证预算/节假日等数据仍可用
          logger?.warn?.('[dsh-tidecost] 旧数据目录迁移失败，继续使用 %s', legacyDir)
        }
      }
    } catch { /* 探测失败按新目录处理 */ }
  }

  const budgetFile = join(dataDir, 'budget.json')
  const sessionBudgetFile = join(dataDir, 'session-budgets.json')
  const logFile = join(dataDir, 'usage-log.jsonl')
  const holidaysFile = join(dataDir, 'holidays.json')
  mkdirSync(dataDir, { recursive: true })

  const apiBaseUrl = config.apiBaseUrl || 'https://api.deepseek.com'
  const balanceCacheMs = config.balanceCacheMs ?? 60000
  const usdCny = Number.isFinite(config.usdCny) && config.usdCny > 0 ? config.usdCny : USD_CNY_DEFAULT

  // ── 节假日名单（热更：dataDir/holidays.json 优先于 Config.holidays）─────────
  function loadHolidays(): string[] {
    const fromFile = readJson<unknown>(holidaysFile, null)
    if (Array.isArray(fromFile)) {
      const list = fromFile.filter((x): x is string => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x))
      if (list.length > 0) return list
    }
    return Array.isArray(config.holidays) ? config.holidays : []
  }

  // ── 计价与成本（DeepSeek 峰谷价格纪年 + Z.ai 等按量计费，见 shared/tide.ts）──
  function costOf(
    usage: TokenUsage,
    model: string | undefined,
    atMs: number,
    holidays: readonly string[],
    provider?: string,
  ): number {
    return tideCostCny(usage, model, atMs, holidays, provider, usdCny)
  }

  function tideStatus(holidays: readonly string[]): TideStatus {
    const now = Date.now()
    const phase = phaseAt(now, holidays)
    return {
      tier: tierAt(now, holidays),
      inPeak: isPeakAt(now, holidays),
      isWeekend: phase?.isWeekend ?? false,
      at: now,
      nextAtMs: phase?.nextAtMs ?? null,
      nextIntoPeak: phase?.nextIntoPeak ?? false,
      secondsUntilNext: phase?.nextAtMs != null ? Math.max(0, Math.round((phase.nextAtMs - now) / 1000)) : null,
    }
  }

  // ── 预算持久化（会话预算按会话隔离）────────────────────────────────────
  //  budget.json            → 全局：defaultSessionBudgetCny / monthly / balanceWarn / warnThreshold
  //  session-budgets.json   → { [sessionId]: 会话预算 }（仅显式设置过的会话）
  function readGlobalBudget(): GlobalBudget {
    const raw = readJson<Record<string, unknown>>(budgetFile, {})
    const n = (v: unknown, def: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : def)
    // 旧版把会话预算写在全局：迁移为默认会话预算。
    const legacySession = typeof raw.sessionBudgetCny === 'number' && Number.isFinite(raw.sessionBudgetCny)
      ? raw.sessionBudgetCny
      : undefined
    return {
      defaultSessionBudgetCny: n(raw.defaultSessionBudgetCny, legacySession ?? DEFAULT_GLOBAL_BUDGET.defaultSessionBudgetCny),
      monthlyBudgetCny: n(raw.monthlyBudgetCny, DEFAULT_GLOBAL_BUDGET.monthlyBudgetCny),
      balanceWarnCny: n(raw.balanceWarnCny, DEFAULT_GLOBAL_BUDGET.balanceWarnCny),
      warnThreshold: n(raw.warnThreshold, DEFAULT_GLOBAL_BUDGET.warnThreshold),
    }
  }

  function readSessionBudgets(): Record<string, number> {
    const raw = readJson<Record<string, unknown>>(sessionBudgetFile, {})
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v
    }
    return out
  }

  /** 当前会话生效预算（无会话 → 全局默认）。 */
  function loadBudget(sessionId?: string): BudgetConfig {
    const g = readGlobalBudget()
    const map = readSessionBudgets()
    const custom = !!(sessionId && Object.prototype.hasOwnProperty.call(map, sessionId))
    return {
      sessionBudgetCny: custom && sessionId ? map[sessionId]! : g.defaultSessionBudgetCny,
      defaultSessionBudgetCny: g.defaultSessionBudgetCny,
      sessionBudgetCustom: custom,
      monthlyBudgetCny: g.monthlyBudgetCny,
      balanceWarnCny: g.balanceWarnCny,
      warnThreshold: g.warnThreshold,
    }
  }

  /**
   * 保存预算：全局三项始终更新；`sessionId` 存在时写该会话的会话预算
   * （resetSession=true 则删除自定义、回落到默认）。
   */
  function saveBudget(next: BudgetConfig, sessionId?: string, resetSession = false): BudgetConfig {
    const g = readGlobalBudget()
    writeJsonAtomic(budgetFile, {
      // 有会话时的保存不改默认；无会话时该输入即“默认会话预算”。
      defaultSessionBudgetCny: sessionId ? g.defaultSessionBudgetCny : next.sessionBudgetCny,
      monthlyBudgetCny: next.monthlyBudgetCny,
      balanceWarnCny: next.balanceWarnCny,
      warnThreshold: next.warnThreshold,
    } satisfies GlobalBudget)
    if (sessionId) {
      const map = readSessionBudgets()
      if (resetSession) delete map[sessionId]
      else map[sessionId] = next.sessionBudgetCny
      writeJsonAtomic(sessionBudgetFile, map)
    }
    return loadBudget(sessionId)
  }

  // ── 月度日志 ───────────────────────────────────────────────────────────
  function appendUsageLog(record: UsageLogRecord): void {
    try {
      appendFileSync(logFile, JSON.stringify(record) + '\n', 'utf8')
      try {
        const st = statSync(logFile)
        if (st.size > MAX_LOG_BYTES) {
          try { renameSync(logFile + '.1', logFile + '.1.bak') } catch { /* 忽略 */ }
          try { renameSync(logFile, logFile + '.1') } catch { /* 忽略 */ }
        }
      } catch { /* 忽略 */ }
    } catch { /* 日志失败静默，不阻塞会话 */ }
  }

  function monthCostCny(holidays: readonly string[]): number {
    try {
      if (!existsSync(logFile)) return 0
      const now = new Date()
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
      let total = 0
      for (const line of readFileSync(logFile, 'utf8').split('\n')) {
        if (!line) continue
        try {
          const rec = JSON.parse(line) as UsageLogRecord
          if (typeof rec.time === 'number' && rec.time >= monthStart && rec.usage) {
            // 历史行可能由旧单价写入；月结一律按“调用发生时刻”的官方价格纪年重算。
            total += costOf(rec.usage, rec.model, rec.time, holidays, rec.provider)
          }
        } catch { /* 跳过损坏行 */ }
      }
      return total
    } catch {
      return 0
    }
  }

  // 实时追加：会话每产生一条带 usage 的 assistant/message 就落一行（月结时按新口径重算）
  ctx.effect(() => ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type !== 'assistant/message' || !event.data.usage) return
    const route = session.requestContext()
    const model = route?.model
    const provider = route?.provider
    appendUsageLog({
      time: event.time,
      sessionId: session.id,
      model,
      provider,
      usage: event.data.usage,
      tier: stepTier(provider, model, event.time, loadHolidays()),
    })
  }), 'dsh-tidecost: usage log')

  // ── 余额 ───────────────────────────────────────────────────────────────
  let balanceCache: { at: number; data: BalanceData } | null = null

  async function fetchBalance(force: boolean): Promise<{ ok: true; data: BalanceData } | { ok: false; error: string }> {
    if (!force && balanceCache && Date.now() - balanceCache.at < balanceCacheMs) {
      return { ok: true, data: balanceCache.data }
    }
    let cred
    try {
      cred = await ctx.credentials.resolve(credentialRef('DEEPSEEK_API_KEY'))
    } catch (e) {
      return { ok: false, error: 'credentials_error:' + String(e).slice(0, 80) }
    }
    if (!cred) {
      return { ok: false, error: 'no_api_key' }
    }
    try {
      const res = await fetch(`${apiBaseUrl}/user/balance`, {
        headers: {
          Authorization: `Bearer ${cred.value}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        return { ok: false, error: `http_${res.status}` }
      }
      const json = (await res.json()) as BalanceResponse
      const info = json.balance_infos?.[0]
      const data: BalanceData = {
        isAvailable: json.is_available !== false,
        currency: info?.currency || 'CNY',
        total: num(info?.total_balance),
        granted: num(info?.granted_balance),
        toppedUp: num(info?.topped_up_balance),
        fetchedAt: Date.now(),
      }
      balanceCache = { at: Date.now(), data }
      return { ok: true, data }
    } catch (e) {
      return { ok: false, error: 'network_error:' + String(e).slice(0, 80) }
    }
  }

  // ── 会话逐步用量 ───────────────────────────────────────────────────────
  // 兼容说明：DSH 0.1.2-rc.1 移除了 Session.events getter，改 snapshotEvents()
  // 取不可变事件快照（语义等价于旧版整表遍历）。
  function computeSessionUsage(sessionId: string, holidays: readonly string[]): SessionUsage | null {
    const session = ctx.sessions.get(sessionId as SessionId)
    if (!session) return null
    const events = session.snapshotEvents()
    let currentModel: string | undefined
    let currentProvider: string | undefined
    const steps: StepUsage[] = []
    for (const ev of events) {
      if (ev.type === 'request/context') {
        currentModel = ev.data.model
        currentProvider = ev.data.provider
      } else if (ev.type === 'assistant/message') {
        const u = ev.data.usage
        const hasUsage = !!u
        steps.push({
          seq: ev.seq,
          turn: ev.data.turn,
          step: ev.data.step,
          time: ev.time,
          model: currentModel,
          provider: currentProvider,
          tier: stepTier(currentProvider, currentModel, ev.time, holidays),
          inputTokens: u?.inputTokens ?? 0,
          outputTokens: u?.outputTokens ?? 0,
          cacheReadTokens: u?.cacheReadTokens,
          cacheWriteTokens: u?.cacheWriteTokens,
          reasoningTokens: u?.reasoningTokens,
          costCny: hasUsage ? costOf(u!, currentModel, ev.time, holidays, currentProvider) : 0,
          hasUsage,
        })
      }
    }
    const used = steps.filter((s) => s.hasUsage)
    const sum = (f: (s: StepUsage) => number) => used.reduce((a, s) => a + f(s), 0)
    const totalInput = sum((s) => s.inputTokens)
    const totalOutput = sum((s) => s.outputTokens)
    const totalCacheRead = sum((s) => s.cacheReadTokens ?? 0)
    const totalCacheWrite = sum((s) => s.cacheWriteTokens ?? 0)
    const totalReasoning = sum((s) => s.reasoningTokens ?? 0)
    const billed = totalInput + totalCacheRead + totalCacheWrite
    const cacheHitRate = billed > 0 ? totalCacheRead / billed : null
    const first = events[0]
    const last = events[events.length - 1]
    const lastUsed = used[used.length - 1]
    return {
      sessionId,
      steps,
      stepCount: steps.length,
      usedStepCount: used.length,
      totalInput,
      totalOutput,
      totalCacheRead,
      totalCacheWrite,
      totalReasoning,
      totalTokens: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
      totalCostCny: sum((s) => s.costCny),
      cacheHitRate,
      startAt: first?.time ?? null,
      lastAt: last?.time ?? null,
      lastModel: lastUsed?.model ?? currentModel,
      lastProvider: lastUsed?.provider ?? currentProvider,
    }
  }

  // ── 预警 ───────────────────────────────────────────────────────────────
  function computeAlerts(balance: BalanceData | null, session: SessionUsage | null, monthCost: number, budget: BudgetConfig): { alerts: Alert[]; level: StatusLevel } {
    const alerts: Alert[] = []
    if (budget.sessionBudgetCny > 0 && session) {
      if (session.totalCostCny >= budget.sessionBudgetCny) {
        alerts.push({ level: 'danger', message: `本会话已超预算：¥${session.totalCostCny.toFixed(2)} / ¥${budget.sessionBudgetCny.toFixed(2)}` })
      } else if (session.totalCostCny >= budget.sessionBudgetCny * budget.warnThreshold) {
        alerts.push({ level: 'warn', message: `本会话接近预算上限：¥${session.totalCostCny.toFixed(2)} / ¥${budget.sessionBudgetCny.toFixed(2)}` })
      }
    }
    if (budget.monthlyBudgetCny > 0 && monthCost > 0) {
      if (monthCost >= budget.monthlyBudgetCny) {
        alerts.push({ level: 'danger', message: `本月已超预算：¥${monthCost.toFixed(2)} / ¥${budget.monthlyBudgetCny.toFixed(2)}` })
      } else if (monthCost >= budget.monthlyBudgetCny * budget.warnThreshold) {
        alerts.push({ level: 'warn', message: `本月接近预算上限：¥${monthCost.toFixed(2)} / ¥${budget.monthlyBudgetCny.toFixed(2)}` })
      }
    }
    if (budget.balanceWarnCny > 0 && balance) {
      if (balance.total <= budget.balanceWarnCny) {
        alerts.push({ level: 'danger', message: `账户余额不足：¥${balance.total.toFixed(2)} ≤ ¥${budget.balanceWarnCny.toFixed(2)}` })
      }
    }
    const level: StatusLevel = alerts.some((a) => a.level === 'danger') ? 'danger' : alerts.length > 0 ? 'warn' : 'ok'
    return { alerts, level }
  }

  // ── HTTP ───────────────────────────────────────────────────────────────
  function readBody(req: import('node:http').IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(text)
  }

  async function handleApi(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const method = req.method ?? 'GET'

    try {
      if (path === '/dsh-tidecost/api/overview' && method === 'GET') {
        const sessionId = url.searchParams.get('session') || ''
        const holidays = loadHolidays()
        const [balanceRes, session, budget] = await Promise.all([
          fetchBalance(false),
          sessionId ? computeSessionUsage(sessionId, holidays) : Promise.resolve(null),
          Promise.resolve(loadBudget(sessionId || undefined)),
        ])
        const monthCost = monthCostCny(holidays)
        const balance = balanceRes.ok ? balanceRes.data : null
        const { alerts, level } = computeAlerts(balance, session, monthCost, budget)
        const overview: Overview = {
          ok: true,
          balance,
          balanceError: balanceRes.ok ? undefined : balanceRes.error,
          session,
          budget,
          monthCostCny: monthCost,
          tide: tideStatus(holidays),
          holidays,
          alerts,
          level,
          now: Date.now(),
        }
        sendJson(res, 200, overview)
        return
      }

      if (path === '/dsh-tidecost/api/balance' && method === 'GET') {
        const force = url.searchParams.get('refresh') === '1'
        const result = await fetchBalance(force)
        sendJson(res, result.ok ? 200 : 200, result)
        return
      }

      if (path === '/dsh-tidecost/api/budget') {
        const sidParam = url.searchParams.get('session') || undefined
        if (method === 'GET') {
          const holidays = loadHolidays()
          sendJson(res, 200, { ok: true, budget: loadBudget(sidParam), monthCostCny: monthCostCny(holidays), holidays })
          return
        }
        if (method === 'POST') {
          const holidays = loadHolidays()
          const raw = JSON.parse(await readBody(req)) as Partial<BudgetConfig> & { resetSession?: boolean }
          const resetSession = raw.resetSession === true
          const prev = loadBudget(sidParam)
          const budget: BudgetConfig = {
            sessionBudgetCny: resetSession
              ? prev.defaultSessionBudgetCny
              : Number(raw.sessionBudgetCny ?? 0),
            defaultSessionBudgetCny: prev.defaultSessionBudgetCny,
            sessionBudgetCustom: prev.sessionBudgetCustom,
            monthlyBudgetCny: Number(raw.monthlyBudgetCny ?? 0),
            balanceWarnCny: Number(raw.balanceWarnCny ?? 0),
            warnThreshold: Number(raw.warnThreshold ?? 0.8),
          }
          if (![budget.sessionBudgetCny, budget.monthlyBudgetCny, budget.balanceWarnCny].every((n) => Number.isFinite(n) && n >= 0)
            || !Number.isFinite(budget.warnThreshold) || budget.warnThreshold < 0 || budget.warnThreshold > 1) {
            sendJson(res, 400, { ok: false, error: 'invalid_budget' })
            return
          }
          const saved = saveBudget(budget, sidParam, resetSession)
          const balanceRes = await fetchBalance(false)
          const balance = balanceRes.ok ? balanceRes.data : null
          const monthCost = monthCostCny(holidays)
          const { alerts, level } = computeAlerts(balance, sidParam ? computeSessionUsage(sidParam, holidays) : null, monthCost, saved)
          sendJson(res, 200, { ok: true, budget: saved, monthCostCny: monthCost, alerts, level, holidays })
          return
        }
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
        return
      }

      const usageMatch = /^\/dsh-tidecost\/api\/session\/([^/]+)\/usage$/.exec(path)
      if (usageMatch && method === 'GET') {
        const sessionId = decodeURIComponent(usageMatch[1])
        const usage = computeSessionUsage(sessionId, loadHolidays())
        sendJson(res, 200, { ok: true, usage })
        return
      }

      sendJson(res, 404, { ok: false, error: 'not_found' })
    } catch (e) {
      sendJson(res, 400, { ok: false, error: String(e).slice(0, 200) })
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-tidecost/api',
    handler: handleApi,
  }), 'dsh-tidecost: api')

  // ── 工具（可选，给 agent 一个快速查询入口）────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'dsh_balance',
    description: '查询 DeepSeek 余额、当前会话 token 用量与花费、预算预警',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      const sessions = ctx.sessions.list()
      const session = sessions[sessions.length - 1]
      const sessionId = session?.id ?? ''
      const holidays = loadHolidays()
      const [balanceRes, usage, budget] = await Promise.all([
        fetchBalance(false),
        sessionId ? computeSessionUsage(sessionId, holidays) : Promise.resolve(null),
        Promise.resolve(loadBudget(sessionId || undefined)),
      ])
      const monthCost = monthCostCny(holidays)
      const balance = balanceRes.ok ? balanceRes.data : null
      const { alerts, level } = computeAlerts(balance, usage, monthCost, budget)
      return JSON.stringify({
        level,
        tide: tideStatus(holidays),
        holidays,
        balance,
        session: usage ? {
          sessionId: usage.sessionId,
          stepCount: usage.stepCount,
          usedStepCount: usage.usedStepCount,
          totalTokens: usage.totalTokens,
          totalCostCny: usage.totalCostCny,
          lastModel: usage.lastModel,
          lastProvider: usage.lastProvider,
        } : null,
        monthCostCny: monthCost,
        budget,
        alerts,
      }, null, 2)
    },
  })), 'dsh-tidecost: tool')

  logger?.info?.('[dsh-tidecost] 已启动（dataDir=%s）', dataDir)
}
