/**
 * dsh-tidecost — DeepSeek 官方峰谷分时定价（纯函数，host/client 共用同一份）。
 *
 * 官方策略（北京时间）：
 *   - 高峰时段 = 周一至周五 09:00–12:00、14:00–18:00；其余（含周末与节假日）为空闲/谷时段。
 *   - 等价 UTC 判定：工作日 UTC 01:00–04:00、06:00–10:00 为峰；周末与节假日全天谷价。
 *   - 谷价 = 峰价 × 0.5。
 *   - 节假日：由 host Config `holidays` / $DSH_HOME/dsh-tidecost/holidays.json 提供北京日期
 *     （YYYY-MM-DD），本模块只接受名单，不内置法定节假日表。
 *
 * 价格纪年（人民币 ¥/百万 tokens，官方公告）：
 *   - 2026-08-16 16:00Z 之前：峰谷时代前基础价（legacy，近似值，仅历史行使用）。
 *   - 2026-08-16 16:00Z 起：峰谷分时定价（Flash 0.05/1.5/4.5 ↔ 峰 0.10/3.0/9.0；
 *     Pro 0.15/4.5/13.5 ↔ 峰 0.30/9.0/27.0）。
 *   - 2026-09-10 12:00 北京（04:00Z）起：Flash 系列降价（V4.1 Flash 新模型同步上线）——
 *     谷 缓存命中 0.02 / 未命中 1 / 输出 4；峰为谷价 2 倍（0.04 / 2 / 8）。
 *     Pro 本次未调整。
 *   ⚠️ 官方再次调价时，只需在本文件追加/修改对应 PriceEpoch（按生效时刻），
 *      历史调用会自动按“调用发生时刻”的价格纪年计价。
 */

/** 峰时段 UTC 小时窗口（半开区间 [start, end)，仅工作日生效）。 */
export const PEAK_WINDOWS_UTC = [
  { start: 1, end: 4 },
  { start: 6, end: 10 },
]

/** 峰谷时代分界（此前按当时基础价计费，历史正确性）。 */
export const LEGACY_BOUNDARY_MS = Date.UTC(2026, 7, 16, 16, 0, 0)

/** Flash 系列降价生效点：北京时间 2026-09-10 12:00（= 04:00Z）。 */
export const FLASH_REPRICE_MS = Date.UTC(2026, 8, 10, 4, 0, 0)

export interface TierPrices {
  cacheHit: number
  cacheMiss: number
  output: number
}

/** 一个价格纪年区间：`[fromMs, untilMs)` 内适用 valley/peak 两档。 */
export interface PriceEpoch {
  fromMs: number
  untilMs: number
  valley: TierPrices
  peak: TierPrices
}

export interface ModelPriceEntry {
  /** 按时间升序的价格纪年（首尾用 ±Infinity 兜底）。 */
  epochs: PriceEpoch[]
}

/** 档位：DeepSeek = legacy/peak/valley；其他 provider 按量计费 = flat。 */
export type TideTier = 'legacy' | 'peak' | 'valley' | 'flat'

// ── 价格纪年常量（官方公告口径）───────────────────────────────────────────
const FLASH_LEGACY: TierPrices = { cacheHit: 0.019, cacheMiss: 0.95, output: 1.91 }
const FLASH_ERA1_VALLEY: TierPrices = { cacheHit: 0.05, cacheMiss: 1.5, output: 4.5 }
const FLASH_ERA1_PEAK: TierPrices = { cacheHit: 0.10, cacheMiss: 3.0, output: 9.0 }
/** 2026-09-10 12:00 北京起：Flash 系列新价。 */
const FLASH_ERA2_VALLEY: TierPrices = { cacheHit: 0.02, cacheMiss: 1, output: 4 }
const FLASH_ERA2_PEAK: TierPrices = { cacheHit: 0.04, cacheMiss: 2, output: 8 }
const PRO_LEGACY: TierPrices = { cacheHit: 0.02, cacheMiss: 2.97, output: 5.93 }
const PRO_VALLEY: TierPrices = { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 }
const PRO_PEAK: TierPrices = { cacheHit: 0.30, cacheMiss: 9.0, output: 27.0 }

/** Flash 系列（deepseek-flash / v4-flash / vision-exp 同价）。 */
const FLASH_ENTRY: ModelPriceEntry = {
  epochs: [
    { fromMs: Number.NEGATIVE_INFINITY, untilMs: LEGACY_BOUNDARY_MS, valley: FLASH_LEGACY, peak: FLASH_LEGACY },
    { fromMs: LEGACY_BOUNDARY_MS, untilMs: FLASH_REPRICE_MS, valley: FLASH_ERA1_VALLEY, peak: FLASH_ERA1_PEAK },
    { fromMs: FLASH_REPRICE_MS, untilMs: Number.POSITIVE_INFINITY, valley: FLASH_ERA2_VALLEY, peak: FLASH_ERA2_PEAK },
  ],
}

/** Pro 系列（本次未调整）。 */
const PRO_ENTRY: ModelPriceEntry = {
  epochs: [
    { fromMs: Number.NEGATIVE_INFINITY, untilMs: LEGACY_BOUNDARY_MS, valley: PRO_LEGACY, peak: PRO_LEGACY },
    { fromMs: LEGACY_BOUNDARY_MS, untilMs: Number.POSITIVE_INFINITY, valley: PRO_VALLEY, peak: PRO_PEAK },
  ],
}

export const PRICE_TABLE_CNY: Record<string, ModelPriceEntry> = {
  'deepseek-flash': FLASH_ENTRY,
  'deepseek-v4-flash': FLASH_ENTRY,
  'deepseek-v4-flash-vision-exp': FLASH_ENTRY,
  'deepseek-v4-pro': PRO_ENTRY,
}

/** 未知名/兜底模型按 Flash 价。 */
const DEFAULT_PRICE_ENTRY: ModelPriceEntry = FLASH_ENTRY

function normalizeModel(id: string | undefined): string {
  return String(id ?? '')
    .toLowerCase()
    .replace(/[\s\-_.()（）]/g, '')
}

/** 模型名归一化匹配（精确 → 互相包含 → flash/pro 关键字），未命中返回 Flash 兜底。 */
export function priceEntryFor(model: string | undefined): ModelPriceEntry {
  const id = normalizeModel(model)
  if (id.length > 0) {
    const keys = Object.keys(PRICE_TABLE_CNY)
    for (const key of keys) {
      if (id === normalizeModel(key)) return PRICE_TABLE_CNY[key]!
    }
    for (const key of keys) {
      const nk = normalizeModel(key)
      if (id.includes(nk) || nk.includes(id)) return PRICE_TABLE_CNY[key]!
    }
    if (id.includes('pro')) return PRICE_TABLE_CNY['deepseek-v4-pro']!
    if (id.includes('flash')) return FLASH_ENTRY
  }
  return DEFAULT_PRICE_ENTRY
}

// ── 其他 provider：按量计费（无峰谷）──────────────────────────────────────
/** USD→CNY 折算默认汇率：仅用于**美元计价**的 provider（当前 DeepSeek / Z.ai 均为官方人民币价，不换算）。 */
export const USD_CNY_DEFAULT = 7.1

export type PriceCurrency = 'CNY' | 'USD'

/** 按量计费单价（每百万 token，原币）。 */
export interface FlatPrices {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  currency: PriceCurrency
}

/**
 * 非 DeepSeek provider 的按量计费表（provider → model → 单价，`*` 为该 provider 兜底）。
 *
 * 来源：**官方人民币定价**（Z.ai「GLM-5.3-Flash」页面，元 / 1M tokens，按量计费）：
 *   输入 ¥0.8 / 输出 ¥2.8 / 缓存命中 ¥0.23 / 缓存存储限时免费（→ 0）
 * 说明：官方另有美元定价页（$0.15 / $0.50 / $0.03），两者并非按汇率换算关系；
 * 本插件优先采用**人民币官方价**，与账户人民币账单一致，无需汇率折算。
 * （pi-ai 内置目录里的 cost 字段与官方定价不一致，不作为依据。）
 */
export const FLAT_PRICES: Record<string, Record<string, FlatPrices>> = {
  zai: {
    'glm-5.3-flash': { input: 0.8, cacheRead: 0.23, cacheWrite: 0, output: 2.8, currency: 'CNY' },
    '*': { input: 0.8, cacheRead: 0.23, cacheWrite: 0, output: 2.8, currency: 'CNY' },
  },
}

/** 原币金额 → 人民币（USD 按 usdCny 折算；CNY 原样返回）。 */
export function toCny(amount: number, currency: PriceCurrency, usdCny: number = USD_CNY_DEFAULT): number {
  if (currency !== 'USD') return amount
  const rate = Number.isFinite(usdCny) && usdCny > 0 ? usdCny : USD_CNY_DEFAULT
  return amount * rate
}

function normalizeProvider(provider: string | undefined): string {
  return String(provider ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** provider 归一化：显式给出优先；缺省时按模型名推断。 */
export function inferProvider(provider: string | undefined, model: string | undefined): string {
  const p = normalizeProvider(provider)
  if (p) {
    if (p.includes('deepseek')) return 'deepseek'
    if (p.includes('zai') || p.includes('zhipu') || p.includes('bigmodel')) return 'zai'
    return p
  }
  const m = normalizeModel(model)
  if (m.includes('deepseek')) return 'deepseek'
  if (m.includes('glm')) return 'zai'
  return ''
}

/**
 * 该 provider+model 是否走按量计费表。
 * @returns 单价条目；null 表示走 DeepSeek 峰谷价格纪年（含未知 provider 的兜底）。
 */
export function flatPricesFor(provider: string | undefined, model: string | undefined): FlatPrices | null {
  const p = inferProvider(provider, model)
  if (!p || p === 'deepseek') return null
  const table = FLAT_PRICES[p]
  if (!table) return null
  const m = normalizeModel(model)
  for (const [key, entry] of Object.entries(table)) {
    if (key !== '*' && (m === normalizeModel(key) || m.includes(normalizeModel(key)))) return entry
  }
  return table['*'] ?? null
}

/** 一步的档位标签：按量计费 provider → flat；否则走 DeepSeek 峰谷档位。 */
export function stepTier(
  provider: string | undefined,
  model: string | undefined,
  atMs: number,
  holidays: readonly string[] = [],
): TideTier {
  if (flatPricesFor(provider, model)) return 'flat'
  return tierAt(atMs, holidays)
}

/** 以 UTC+8 求该时刻的北京自然日 `YYYY-MM-DD`。 */
export function beijingDateKey(atMs: number): string {
  const shifted = new Date(atMs + 8 * 3600 * 1000)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 是否为周末（UTC 自然日周六/周日）。 */
export function isUtcWeekend(atMs: number): boolean {
  const day = new Date(atMs).getUTCDay()
  return day === 0 || day === 6
}

/** 是否为配置的节假日（北京日期名单）。 */
export function isHoliday(atMs: number, holidays: readonly string[] = []): boolean {
  return holidays.length > 0 && holidays.includes(beijingDateKey(atMs))
}

/**
 * 某一时刻是否为峰时段。
 * 周末与节假日全天谷价 → false；工作日按 UTC 小时窗口判定。
 * @param holidays - 北京日期名单（YYYY-MM-DD），来自 host 配置。
 */
export function isPeakAt(atMs: number, holidays: readonly string[] = []): boolean {
  if (isUtcWeekend(atMs)) return false
  if (isHoliday(atMs, holidays)) return false
  const hour = new Date(atMs).getUTCHours()
  return PEAK_WINDOWS_UTC.some((w) => {
    const start = Number(w.start)
    const end = Number(w.end)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false
    if (start < end) return hour >= start && hour < end
    // 跨午夜窗口兼容（当前官方窗口不会出现）。
    return hour >= start || hour < end
  })
}

/** 档位：峰谷生效前 → legacy；峰 → peak；否则 valley。 */
export function tierAt(atMs: number, holidays: readonly string[] = []): TideTier {
  if (Number.isFinite(atMs) && atMs < LEGACY_BOUNDARY_MS) return 'legacy'
  return isPeakAt(atMs, holidays) ? 'peak' : 'valley'
}

export interface TidePhase {
  tier: TideTier
  inPeak: boolean
  isWeekend: boolean
  isHoliday: boolean
  at: number
  prevAtMs: number | null
  nextAtMs: number | null
  nextIntoPeak: boolean
}

/**
 * 当前相位 + 相邻切换点（供倒计时/周末/节假日提示）。
 * 周末与节假日无切换点：prev 落在上一工作日最后一次出峰，next 落在下一工作日首次入峰。
 */
export function phaseAt(atMs: number, holidays: readonly string[] = []): TidePhase | null {
  if (!Number.isFinite(atMs)) return null
  const hourAt = (dayOffset: number, hour: number): number => {
    const d = new Date(atMs)
    d.setUTCDate(d.getUTCDate() + dayOffset)
    d.setUTCHours(hour, 0, 0, 0)
    return d.getTime()
  }
  const collectable = (t: number): boolean => !isUtcWeekend(t) && !isHoliday(t, holidays)
  const points: Array<{ at: number; intoPeak: boolean }> = []
  for (let day = -2; day <= 3; day += 1) {
    if (!collectable(hourAt(day, 0))) continue
    for (const w of PEAK_WINDOWS_UTC) {
      const start = Number(w.start)
      const end = Number(w.end)
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue
      points.push({ at: hourAt(day, start), intoPeak: true })
      points.push({ at: hourAt(end <= start ? day + 1 : day, end), intoPeak: false })
    }
  }
  let prev: { at: number; intoPeak: boolean } | null = null
  let next: { at: number; intoPeak: boolean } | null = null
  for (const p of points) {
    if (p.at <= atMs && (prev === null || p.at > prev.at)) prev = p
    if (p.at > atMs && (next === null || p.at < next.at)) next = p
  }
  return {
    tier: tierAt(atMs, holidays),
    inPeak: isPeakAt(atMs, holidays),
    isWeekend: isUtcWeekend(atMs),
    isHoliday: isHoliday(atMs, holidays),
    at: atMs,
    prevAtMs: prev?.at ?? null,
    nextAtMs: next?.at ?? null,
    nextIntoPeak: next?.intoPeak ?? false,
  }
}

/** 某一时刻适用的档位价格（按价格纪年 + 当时档位）。 */
export function priceCny(model: string | undefined, atMs: number, holidays: readonly string[] = []): TierPrices {
  const entry = priceEntryFor(model)
  const epochs = entry.epochs
  let epoch = epochs[epochs.length - 1]!
  for (const e of epochs) {
    if (atMs >= e.fromMs && atMs < e.untilMs) {
      epoch = e
      break
    }
  }
  if (atMs < LEGACY_BOUNDARY_MS) return epoch.valley // legacy 区间 valley === peak
  return isPeakAt(atMs, holidays) ? epoch.peak : epoch.valley
}

/**
 * 一次调用的成本（人民币口径）。
 *
 * - DeepSeek（provider=deepseek / 缺省且模型名含 deepseek）：按官方峰谷价格纪年，返回 ¥。
 * - 其他已登记 provider（如 zai）：按按量计费表计价（官方人民币价直接使用；
 *   若某 provider 标注为 USD 则按 `usdCny` 折合 ¥），使预算/预警同口径。
 * - 未知 provider/model：回落 DeepSeek Flash 兜底价（仅参照）。
 *
 * @param tokens - { inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens? }
 *   注意：harness 的 outputTokens = 供应商 completion_tokens，已含推理 token，
 *   因此 reasoningTokens 不单独计费。
 * @param holidays - 节假日北京日期名单（决定 DeepSeek 节假日走谷价）。
 * @param provider - 路由 provider（request/context.provider），如 deepseek-official / zai。
 * @param usdCny - USD→CNY 折算汇率（仅美元计价 provider 使用）。
 */
export function costCny(
  tokens: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  },
  model: string | undefined,
  atMs: number,
  holidays: readonly string[] = [],
  provider?: string,
  usdCny: number = USD_CNY_DEFAULT,
): number {
  const input = Math.max(0, Number(tokens.inputTokens) || 0)
  const output = Math.max(0, Number(tokens.outputTokens) || 0)
  const cacheRead = Math.max(0, Number(tokens.cacheReadTokens) || 0)
  const cacheWrite = Math.max(0, Number(tokens.cacheWriteTokens) || 0)

  const flat = flatPricesFor(provider, model)
  if (flat) {
    const amount = (input * flat.input + output * flat.output
      + cacheRead * flat.cacheRead + cacheWrite * flat.cacheWrite) / 1_000_000
    return toCny(amount, flat.currency, usdCny)
  }

  const p = priceCny(model, atMs, holidays)
  return (input * p.cacheMiss + output * p.output + (cacheRead + cacheWrite) * p.cacheHit) / 1_000_000
}

export interface BeijingScheduleSegment {
  /** 展示用起止（北京时间，含“次日”表述）。 */
  start: string
  end: string
  tier: 'peak' | 'valley'
  /** 数字范围（北京小时），用于高亮判定。 */
  fromBeijingHour: number
  toBeijingHour: number
}

/** 官方时段表（北京时间展示用，由 UTC 窗口 +8h 推导）。 */
export function beijingScheduleSegments(): BeijingScheduleSegment[] {
  return [
    { start: '09:00', end: '12:00', tier: 'peak', fromBeijingHour: 9, toBeijingHour: 12 },
    { start: '12:00', end: '14:00', tier: 'valley', fromBeijingHour: 12, toBeijingHour: 14 },
    { start: '14:00', end: '18:00', tier: 'peak', fromBeijingHour: 14, toBeijingHour: 18 },
    { start: '18:00', end: '次日 09:00', tier: 'valley', fromBeijingHour: 18, toBeijingHour: 33 }, // 18:00 – 次日 09:00
  ]
}

/**
 * 当前时刻落在时段表第几段（北京时间；00:00–09:00 归属上一段 18:00–次日09:00）。
 * 周末/节假日全天谷价时返回 null（UI 单独展示提示）。
 */
export function currentBeijingSegmentIndex(atMs: number, holidays: readonly string[] = []): number | null {
  if (isUtcWeekend(atMs) || isHoliday(atMs, holidays)) return null
  const bjHour = (new Date(atMs).getUTCHours() + 8) % 24
  const segs = beijingScheduleSegments()
  for (let i = 0; i < segs.length; i += 1) {
    const s = segs[i]!
    if (s.toBeijingHour > 24) {
      if (bjHour >= s.fromBeijingHour || bjHour < s.toBeijingHour - 24) return i
    } else if (s.fromBeijingHour <= bjHour && bjHour < s.toBeijingHour) {
      return i
    }
  }
  return 3 // 理论不可达：兜底到谷段
}
