/**
 * dsh-tidecost — 侧边栏余额 / 峰谷价 / 用量 / 预算模块（client 侧）。
 *
 * 注册进 `sidebar.footer.action`（list/root）：宽侧边栏显示余额行，
 * rail 模式显示图标；点击弹出悬浮面板（position:fixed，不动摇其它槽位）。
 *
 * 兼容性说明（DSH 0.1.2-rc.1）：
 *  - 不再引用已移除的 `@deepseek-ai/dsh-client-runtime`；client bundle 运行时
 *    只依赖 react（react/jsx-runtime），槽位注册用运行时结构形态（ctx.slots
 *    的 inject/register 双参签名与旧版一致）。
 *  - 会话列表钩子（useSessions）仍由渲染器 GlobalStandardProps 注入，缺省优雅降级。
 *
 * 峰谷价：档位判定/倒计时由共享纯函数 src/shared/tide.ts 本地实时计算；
 * overview 轮询提供账户余额、会话用量与预算，并在档位翻转时自动提醒。
 */

import { useEffect, useRef, useState } from 'react'
import type { BudgetConfig, Overview, StepUsage } from '../shared/types'
import { beijingScheduleSegments, currentBeijingSegmentIndex, phaseAt } from '../shared/tide'
import { beijingDateKey, peakDoneKey, peakDoneKeyLegacy, peakEnabledKey, peakEnabledKeyLegacy, shouldArmPeakConfirm } from '../shared/peakgate'
import { budgetToDraft, draftToBudget, sanitizeNumText, toNum, type BudgetDraft } from '../shared/budget-input'
import { styles } from './styles'

export const inject = ['slots']

const API = '/dsh-tidecost/api'
const POLL_OPEN_MS = 15_000
const POLL_CLOSED_MS = 60_000
const NOTICE_TTL_MS = 45_000
/** 峰价对话确认的常驻判定间隔（面板关闭时也生效）。 */
const PEAK_CHECK_MS = 30_000

// ── localStorage 存取（不可用时降级为空/默认）────────────────────────────
function readLocal(key: string, fallback: string | null): string | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return fallback
    const v = window.localStorage.getItem(key)
    return v == null ? fallback : v
  } catch {
    return fallback
  }
}
function writeLocal(key: string, value: string): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(key, value)
  } catch { /* 隐私模式等：忽略 */ }
}
function removeLocal(key: string): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.removeItem(key)
  } catch { /* 忽略 */ }
}

// 峰价确认状态：读新键 → 回退旧包名键（一次性迁移），写新键并清理旧键
function readPeakEnabled(defaultOn = true): boolean {
  const v = readLocal(peakEnabledKey(), null) ?? readLocal(peakEnabledKeyLegacy(), null)
  return v == null ? defaultOn : v === '1'
}
function readPeakDone(dateKey: string): string | null {
  return readLocal(peakDoneKey(dateKey), null) ?? readLocal(peakDoneKeyLegacy(dateKey), null)
}
function writePeakEnabled(on: boolean): void {
  writeLocal(peakEnabledKey(), on ? '1' : '0')
  removeLocal(peakEnabledKeyLegacy())
}
function writePeakDone(dateKey: string): void {
  writeLocal(peakDoneKey(dateKey), '1')
  removeLocal(peakDoneKeyLegacy(dateKey))
}

// ── 运行时结构类型（避免依赖具体 @deepseek-ai/* client 类型包）──────────────
type SlotRegisterOptions = {
  name: string
  id: string
  order?: number
  label?: string | (() => string)
}
type SlotsLike = {
  inject(key: string, make: () => unknown): unknown
  register(options: SlotRegisterOptions, component: unknown): unknown
}
type ApplyCtx = {
  effect(fn: () => unknown, label?: string): unknown
  slots: SlotsLike
}

interface BalanceTriggerProps {
  wide?: boolean
  /** GlobalStandardProps：会话列表与当前选中（root 作用域 slot 组件由渲染器注入）。 */
  useSessions?: <S>(sel: (s: unknown) => S, eq?: (a: S, b: S) => boolean) => S
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  return res.json() as Promise<T>
}

function fmt(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return n.toFixed(digits)
}

function fmtTime(ms: number | null | undefined): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fmtCountdown(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—'
  const s = Math.max(0, Math.floor(seconds))
  const p = (x: number) => String(x).padStart(2, '0')
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${p(h)}:${p(m)}:${p(sec)}`
}

function tierLabel(tier: string | undefined, weekend = false, holiday = false): { text: string; cls: string } {
  if (weekend) return { text: '周末·谷价', cls: 'valley' }
  if (holiday) return { text: '节假日·谷价', cls: 'valley' }
  if (tier === 'peak') return { text: '峰价', cls: 'peak' }
  if (tier === 'legacy') return { text: '历史价', cls: 'valley' }
  return { text: '谷价', cls: 'valley' }
}

/**
 * 预算输入框的编辑态（字符串）：允许清空、不强制补 0，
 * 并去掉多余前导零（"05" → "5"，但 "0.5" 保持不变）。
 * 纯逻辑见 shared/budget-input.ts（含单测）。
 */

function StepRow({ step }: { step: StepUsage }) {
  const model = step.model || 'unknown'
  const tokens = step.hasUsage
    ? `${step.inputTokens + (step.cacheReadTokens ?? 0) + (step.cacheWriteTokens ?? 0)}→${step.outputTokens}`
    : '—'
  const t = tierLabel(step.tier)
  return (
    <div className="dshb-step">
      <span title={`seq ${step.seq}`}>{step.turn}.{step.step} {fmtTime(step.time)}</span>
      <span className="m" title={model}>
        <span className={`dshb-tier ${t.cls}`}>{t.text}</span> {model}
      </span>
      <span className="c">{tokens} · ¥{fmt(step.costCny)}</span>
    </div>
  )
}

export function apply(ctx: ApplyCtx): void {
  ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'dsh-tidecost-trigger',
      order: 90,
      label: () => '余额',
    }, BalanceTrigger),
  ), 'dsh-tidecost: sidebar trigger')
}

function BalanceTrigger({ wide, useSessions }: BalanceTriggerProps) {
  // GlobalStandardProps.useSessions 由渲染器注入；缺省（未注入/被移除）时降级为无会话视角。
  const current = useSessions ? useSessions((s: unknown) => (s as { current?: string } | null | undefined)?.current) : undefined
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [overview, setOverview] = useState<Overview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<BudgetDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [tideNotice, setTideNotice] = useState<string | null>(null)
  // ── 峰价·每日首次对话前确认 ──
  const [peakEnabled, setPeakEnabled] = useState<boolean>(() => readPeakEnabled(true))
  const [confirmedDate, setConfirmedDate] = useState<string | null>(() => readPeakDone(beijingDateKey(Date.now())))
  const [peakConfirmOpen, setPeakConfirmOpen] = useState(false)
  const shownTodayRef = useRef(false)
  const holidaysRef = useRef<string[]>([])
  const lastTierRef = useRef<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // 常驻轮询：面板关闭 60s / 打开 15s；首次与切换会话立即拉取；翻转自动提醒
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const data = await fetchJson<Overview>(`${API}/overview?session=${encodeURIComponent(current ?? '')}`)
        if (cancelled) return
        setOverview(data)
        setError(data.balanceError ? `余额：${data.balanceError}` : null)
        const prev = lastTierRef.current
        const tier = data.tide?.tier
        if (prev && tier && prev !== tier) {
          setTideNotice(tier === 'peak' ? '⏰ 已进入峰价时段（成本 ×2）' : '⏰ 已进入谷价时段（半价）')
        }
        if (tier) lastTierRef.current = tier
      } catch (e) {
        if (!cancelled) setError('加载失败: ' + String(e))
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), open ? POLL_OPEN_MS : POLL_CLOSED_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [open, current])

  // 打开时秒级 ticker，驱动倒计时
  useEffect(() => {
    if (!open) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [open])

  // 提醒横幅自动消失
  useEffect(() => {
    if (!tideNotice) return
    const timer = window.setTimeout(() => setTideNotice(null), NOTICE_TTL_MS)
    return () => window.clearTimeout(timer)
  }, [tideNotice])

  // 峰价·每日首次对话前确认：关闭即视为当日已确认
  const dismissPeakConfirm = (disableToo = false) => {
    const today = beijingDateKey(Date.now())
    writePeakDone(today)
    setConfirmedDate(today)
    setPeakConfirmOpen(false)
    if (disableToo) {
      writePeakEnabled(false)
      setPeakEnabled(false)
    }
  }

  // 常驻判定（不依赖面板开关）：每 30s 检查一次，命中则当日自动弹一次
  useEffect(() => {
    const check = () => {
      setNow(Date.now())
      const today = beijingDateKey(Date.now())
      const done = readPeakDone(today)
      if (done !== confirmedDate && done !== null) setConfirmedDate(done)
      if (shownTodayRef.current || peakConfirmOpen) return
      if (shouldArmPeakConfirm({ now: Date.now(), enabled: peakEnabled, confirmedDate: done, hasSession: !!current, holidays: holidaysRef.current })) {
        shownTodayRef.current = true
        setPeakConfirmOpen(true)
      }
    }
    check()
    const timer = window.setInterval(check, PEAK_CHECK_MS)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peakEnabled, current])

  // 弹窗打开时 ESC = 视为已读并关闭
  useEffect(() => {
    if (!peakConfirmOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismissPeakConfirm()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peakConfirmOpen])

  // 预算草稿跟随服务端值（切会话/默认值变化时刷新）
  useEffect(() => {
    if (overview) setDraft(budgetToDraft(overview.budget))
  }, [current, overview?.budget?.sessionBudgetCny, overview?.budget?.defaultSessionBudgetCny, overview?.budget?.monthlyBudgetCny, overview?.budget?.balanceWarnCny, overview?.budget?.warnThreshold])

  // 节假日名单跟随服务端（供常驻判定使用，避免每次轮询重置定时器）
  useEffect(() => {
    holidaysRef.current = overview?.holidays ?? []
  }, [overview])

  // 点击外部 / ESC 关闭
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const refreshBalance = async () => {
    setError(null)
    try {
      const data = await fetchJson<Overview>(`${API}/overview?session=${encodeURIComponent(current ?? '')}`)
      setOverview(data)
      setError(data.balanceError ? `余额：${data.balanceError}` : null)
    } catch (e) {
      setError('刷新失败: ' + String(e))
    }
  }

  const saveBudget = async (resetSession = false) => {
    if (!draft && !resetSession) return
    setSaving(true)
    try {
      const numeric = draft ? draftToBudget(draft) : {}
      const body = resetSession ? { ...numeric, resetSession: true } : numeric
      const data = await fetchJson<{ ok: boolean; error?: string; budget: BudgetConfig }>(`${API}/budget?session=${encodeURIComponent(current ?? '')}`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      if (!data.ok) {
        setError(data.error || '保存预算失败')
        return
      }
      setDraft(budgetToDraft(data.budget))
      await refreshBalance()
    } catch (e) {
      setError('保存失败: ' + String(e))
    } finally {
      setSaving(false)
    }
  }

  const level = overview?.level ?? 'ok'
  const balance = overview?.balance ?? null
  const session = overview?.session ?? null
  const budget = overview?.budget ?? null
  const monthCost = overview?.monthCostCny ?? 0

  // 峰谷实时相位（本地与 server 同源 shared/tide；节假日名单来自 overview）
  const holidays = overview?.holidays ?? []
  const phase = phaseAt(now, holidays)
  const serverTide = overview?.tide
  const tideTier = phase?.tier ?? serverTide?.tier ?? 'valley'
  const isWeekend = phase?.isWeekend ?? serverTide?.isWeekend ?? false
  const isHolidayToday = phase?.isHoliday ?? false
  const nextAtMs = phase?.nextAtMs ?? serverTide?.nextAtMs
  const nextIntoPeak = phase?.nextIntoPeak ?? serverTide?.nextIntoPeak ?? false
  const secondsUntilNext = nextAtMs != null ? Math.max(0, Math.floor((nextAtMs - now) / 1000)) : null
  const tide = tierLabel(tideTier, isWeekend, isHolidayToday)
  const segs = beijingScheduleSegments()
  const nowSeg = currentBeijingSegmentIndex(now, holidays)
  const nextTierText = isWeekend ? '下周一峰价' : nextIntoPeak ? '峰价' : '谷价'

  const steps = session ? [...session.steps].reverse().slice(0, 50) : []
  const sessionBudgetPct = budget && budget.sessionBudgetCny > 0 && session
    ? Math.min(100, (session.totalCostCny / budget.sessionBudgetCny) * 100)
    : 0
  const barClass = sessionBudgetPct >= 100 ? 'danger' : sessionBudgetPct >= (budget?.warnThreshold ?? 0.8) * 100 ? 'warn' : ''

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <style>{styles}</style>
      <button
        className={`dshb-trigger${wide ? '' : ' rail'}`}
        onClick={() => setOpen((o) => !o)}
        title="DeepSeek 余额与峰谷价"
      >
        {wide ? (
          <>
            <span className="dshb-label">{balance ? `余额 ¥${fmt(balance.total)}` : '余额 —'}</span>
            <span className={`dshb-chip ${tide.cls}`} title={isWeekend ? '周末全天谷价' : isHolidayToday ? '节假日全天谷价' : tide.text}>{isWeekend ? '周末' : isHolidayToday ? '假日' : tide.text}</span>
            <span className={`dshb-dot ${level}`} />
          </>
        ) : (
          <>
            <span style={{ fontSize: 12, fontWeight: 700 }}>¥</span>
            <span className={`dshb-chip ${tide.cls}`} style={{ fontSize: 9, padding: '1px 3px' }}>{isWeekend ? '谷' : tideTier === 'peak' ? '峰' : '谷'}</span>
            <span className={`dshb-dot ${level}`} />
          </>
        )}
      </button>

      {open && (
        <div className="dshb-panel">
          <div className="dshb-head">
            <span className="dshb-title">DeepSeek 余额 / 峰谷价 / 用量 / 预算</span>
            <button className="dshb-close" onClick={() => setOpen(false)} aria-label="关闭">×</button>
          </div>
          <div className="dshb-body">
            {error && <div className="dshb-error">{error}</div>}
            {tideNotice && (
              <div className={`dshb-alert ${tideNotice.includes('峰') ? 'warn' : 'ok'}`}>
                <span className="dshb-notice-text">{tideNotice}</span>
                <button className="dshb-close" onClick={() => setTideNotice(null)} aria-label="关闭提醒">×</button>
              </div>
            )}

            {/* 当前时段（峰谷价） */}
            <div className="dshb-card">
              <h4>当前时段 · 官方峰谷价</h4>
              <div className="dshb-tide-main">
                <span className={`dshb-tide-badge ${tide.cls}`}>{tide.text}{tideTier === 'peak' ? ' ×2' : tideTier === 'valley' ? ' ×0.5' : ''}</span>
                <span className="dshb-muted">距{nextTierText} {fmtCountdown(secondsUntilNext)}</span>
              </div>
              <div className="dshb-sched-wrap">
                <table className="dshb-sched">
                  <tbody>
                    {segs.map((s, i) => (
                      <tr key={i} className={nowSeg === i && !isWeekend ? 'now' : ''}>
                        <td>{s.start} – {s.end}</td>
                        <td className={s.tier === 'peak' ? 'pk' : 'vl'}>{s.tier === 'peak' ? '峰' : '谷'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {isWeekend && <div className="dshb-hint">周六/周日（UTC 自然日）全天谷价，无峰谷切换</div>}
                {!isWeekend && isHolidayToday && <div className="dshb-hint">节假日全天谷价（按 host 节假日名单）</div>}
              </div>
              <div className="dshb-hint">谷价 = 峰价一半 · 按调用发生时刻计价（官方人民币价）</div>
              <div className="dshb-row" style={{ marginTop: 6 }}>
                <span className="dshb-muted">峰价对话确认：</span>
                <span className="dshb-muted">{confirmedDate === beijingDateKey(now) ? '今日已确认' : '今日待确认'}</span>
                <label className="dshb-switch" title="启用/停用「峰价每日首次对话前确认」">
                  <input type="checkbox" checked={peakEnabled}
                    onChange={(e) => { const v = e.target.checked; writePeakEnabled(v); setPeakEnabled(v) }} />
                  启用
                </label>
                <button className="dshb-btn ghost" onClick={() => setPeakConfirmOpen(true)}>预览弹窗</button>
              </div>
            </div>

            {/* 余额卡 */}
            <div className="dshb-card">
              <h4>账户余额</h4>
              {balance ? (
                <>
                  <div className="dshb-balance-main">
                    ¥{fmt(balance.total)}
                    <span className="dshb-muted">{balance.currency} · {balance.isAvailable ? '可用' : '不可用'}</span>
                  </div>
                  <div className="dshb-grid">
                    <span><span className="k">充值</span> ¥{fmt(balance.toppedUp)}</span>
                    <span><span className="k">赠送</span> ¥{fmt(balance.granted)}</span>
                    <span><span className="k">更新</span> {fmtTime(balance.fetchedAt)}</span>
                    <span className="dshb-row"><button className="dshb-btn ghost" onClick={() => void refreshBalance()}>刷新</button></span>
                  </div>
                </>
              ) : (
                <div className="dshb-hint">
                  {overview?.balanceError === 'no_api_key'
                    ? '未配置 DEEPSEEK_API_KEY（可在 ~/.dsh/.credentials.yaml 设置）'
                    : '余额暂不可用（' + (overview?.balanceError ?? '加载中…') + '）'}
                </div>
              )}
            </div>

            {/* 本会话用量 */}
            <div className="dshb-card">
              <h4>本会话用量（峰谷计价）</h4>
              {session ? (
                <>
                  <div className="dshb-grid">
                    <span><span className="k">步数</span> {session.stepCount}（有 usage {session.usedStepCount}）</span>
                    <span><span className="k">总 token</span> {session.totalTokens.toLocaleString()}</span>
                    <span><span className="k">总花费</span> ¥{fmt(session.totalCostCny)}</span>
                    <span><span className="k">模型</span> {session.lastModel ?? '—'}</span>
                    <span><span className="k">缓存命中</span> {session.cacheHitRate != null ? (session.cacheHitRate * 100).toFixed(1) + '%' : '—'}</span>
                    <span><span className="k">会话</span> {session.sessionId}</span>
                  </div>
                  <div className="dshb-steps">
                    {steps.length === 0
                      ? <div className="dshb-hint">暂无已上报 usage 的步骤</div>
                      : steps.map((s) => <StepRow key={s.seq} step={s} />)}
                  </div>
                  <div className="dshb-total">
                    <span>输入 {session.totalInput.toLocaleString()} / 输出 {session.totalOutput.toLocaleString()} / 缓存读 {session.totalCacheRead.toLocaleString()}</span>
                    <span>¥{fmt(session.totalCostCny)}</span>
                  </div>
                </>
              ) : (
                <div className="dshb-hint">打开一个会话后显示每步 token 用量与花费</div>
              )}
            </div>

            {/* 预算 */}
            <div className="dshb-card">
              <h4>预算与预警</h4>
              {budget && draft ? (
                <>
                  <div className="dshb-budget-form">
                    <label>{current ? '会话预算 ¥（本会话）' : '会话预算 ¥（默认）'}
                      <input type="text" inputMode="decimal" autoComplete="off" placeholder="0"
                        value={draft.sessionBudgetCny}
                        onChange={(e) => setDraft({ ...draft, sessionBudgetCny: sanitizeNumText(e.target.value) })} />
                    </label>
                    <label>月度预算 ¥（全局）
                      <input type="text" inputMode="decimal" autoComplete="off" placeholder="0"
                        value={draft.monthlyBudgetCny}
                        onChange={(e) => setDraft({ ...draft, monthlyBudgetCny: sanitizeNumText(e.target.value) })} />
                    </label>
                    <label>余额预警线 ¥（全局）
                      <input type="text" inputMode="decimal" autoComplete="off" placeholder="0"
                        value={draft.balanceWarnCny}
                        onChange={(e) => setDraft({ ...draft, balanceWarnCny: sanitizeNumText(e.target.value) })} />
                    </label>
                    <label>预警比例 %（全局）
                      <input type="text" inputMode="numeric" autoComplete="off" placeholder="80"
                        value={draft.warnThresholdPct}
                        onChange={(e) => setDraft({ ...draft, warnThresholdPct: sanitizeNumText(e.target.value) })} />
                    </label>
                  </div>
                  <div className="dshb-hint">
                    {current
                      ? (budget.sessionBudgetCustom
                        ? `本会话已单独设置（默认 ¥${fmt(budget.defaultSessionBudgetCny)}）；保存仅影响本会话`
                        : `本会话未单独设置，使用默认 ¥${fmt(budget.defaultSessionBudgetCny)}；保存后仅本会话生效`)
                      : `当前无会话：此项为默认会话预算 ¥${fmt(toNum(draft.sessionBudgetCny))}，对之后新建的会话生效`}
                  </div>
                  {budget.sessionBudgetCny > 0 && session && (
                    <div className={`dshb-bar ${barClass}`}><i style={{ width: `${sessionBudgetPct}%` }} /></div>
                  )}
                  <div className="dshb-grid" style={{ marginTop: 6 }}>
                    <span><span className="k">本会话</span> ¥{fmt(session?.totalCostCny)}</span>
                    <span><span className="k">本月</span> ¥{fmt(monthCost)}</span>
                  </div>
                  <div className="dshb-row" style={{ marginTop: 8 }}>
                    <button className="dshb-btn" onClick={() => void saveBudget()} disabled={saving}>{saving ? '保存中…' : '保存预算'}</button>
                    {current && budget.sessionBudgetCustom && (
                      <button className="dshb-btn ghost" onClick={() => void saveBudget(true)} disabled={saving}
                        title="删除本会话的自定义会话预算，回落到默认值">恢复默认</button>
                    )}
                  </div>
                </>
              ) : (
                <div className="dshb-hint">预算配置加载中…</div>
              )}
            </div>

            {/* 预警 */}
            {overview && overview.alerts.length > 0 && (
              <div className="dshb-card">
                <h4>预警</h4>
                <div className="dshb-alerts">
                  {overview.alerts.map((a, i) => (
                    <div key={i} className={`dshb-alert ${a.level}`}>{a.message}</div>
                  ))}
                </div>
              </div>
            )}
            <div className="dshb-hint" style={{ marginTop: 2 }}>
              ⚠️ 仅支持 DeepSeek API（deepseek-official）：余额取 DeepSeek 账户，
              峰谷价与单价均为官方口径；其他 provider 的费用为 Flash 兜底估算，仅供参考。
            </div>
          </div>
        </div>
      )}

      {/* 峰价·每日首次对话前确认弹窗 */}
      {peakConfirmOpen && (
        <div className="dshb-mask" onClick={() => dismissPeakConfirm()}>
          <div className="dshb-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="dshb-modal-head">
              <span className="dshb-chip peak">峰价时段</span>
              <span className="dshb-title">对话确认</span>
            </div>
            <div className="dshb-modal-body">
              <p>当前处于 DeepSeek API <b className="dshb-pk">峰价时段</b>（北京时间 09:00–12:00 / 14:00–18:00），
                价格约为谷价的 <b>2 倍</b>。</p>
              <p>这是<b>今日首次</b>在峰价下开始对话。非紧急任务建议等谷价（半价）再运行。</p>
            </div>
            <div className="dshb-modal-actions">
              <button className="dshb-btn" onClick={() => dismissPeakConfirm()}>知道了，继续（今日不再提醒）</button>
              <button className="dshb-btn ghost" onClick={() => dismissPeakConfirm()}>关闭</button>
              <button className="dshb-btn ghost" onClick={() => dismissPeakConfirm(true)}>以后都别提醒</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
