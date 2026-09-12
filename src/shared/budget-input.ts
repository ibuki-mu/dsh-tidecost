/**
 * dsh-tidecost — 预算输入框的纯文本/数值转换（客户端表单编辑态）。
 *
 * 背景：直接用 `value={number}` 的受控数字输入会在清空时被强制变回 0，
 * 再次输入就出现前导零（"0" + "5" → "05"）。这里把编辑态保持为字符串：
 * 允许空串、手动清除多余前导零，并在提交时统一转数值。
 */

import type { BudgetConfig } from './types.js'

/** 预算输入框编辑态（字符串）。 */
export interface BudgetDraft {
  sessionBudgetCny: string
  monthlyBudgetCny: string
  balanceWarnCny: string
  warnThresholdPct: string
}

/**
 * 归一化数字输入文本：
 *  - 仅保留数字与小数点，且最多一个小数点；
 *  - 去掉多余前导零（"05" → "5"、"000" → "0"），但保留 "0.5" / ".5"；
 *  - 允许空串（清空时不再被强制补 0）。
 */
export function sanitizeNumText(raw: string): string {
  let v = raw.replace(/[^\d.]/g, '')
  const dot = v.indexOf('.')
  if (dot >= 0) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '')
  v = v.replace(/^0+(?=\d)/, '')
  return v
}

/** 提交/展示用：空串或非法值按 0 处理。 */
export function toNum(text: string | undefined): number {
  const n = Number.parseFloat(String(text ?? ''))
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/** 服务端预算 → 编辑态字符串。 */
export function budgetToDraft(b: BudgetConfig): BudgetDraft {
  return {
    sessionBudgetCny: String(b.sessionBudgetCny),
    monthlyBudgetCny: String(b.monthlyBudgetCny),
    balanceWarnCny: String(b.balanceWarnCny),
    warnThresholdPct: String(Math.round(b.warnThreshold * 100)),
  }
}

/** 编辑态 → 提交载荷（百分比 0–100 折回 0–1，越界钳制）。 */
export function draftToBudget(
  d: BudgetDraft,
): Pick<BudgetConfig, 'sessionBudgetCny' | 'monthlyBudgetCny' | 'balanceWarnCny' | 'warnThreshold'> {
  return {
    sessionBudgetCny: toNum(d.sessionBudgetCny),
    monthlyBudgetCny: toNum(d.monthlyBudgetCny),
    balanceWarnCny: toNum(d.balanceWarnCny),
    warnThreshold: Math.max(0, Math.min(1, toNum(d.warnThresholdPct) / 100)),
  }
}
