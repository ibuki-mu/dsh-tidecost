/**
 * dsh-balance 预算输入框转换自检（清空前导零/空串处理回归）。
 * 运行：node test/budget-input.mjs（先构建 host 生成 lib/shared/budget-input.js）
 */
import assert from 'node:assert/strict'
import { budgetToDraft, draftToBudget, sanitizeNumText, toNum } from '../lib/shared/budget-input.js'

let n = 0
function check(name, fn) { fn(); n += 1; console.log('✓', name) }

check('清空不再是前导零的起点', () => {
  assert.equal(sanitizeNumText(''), '')
  assert.equal(sanitizeNumText('0'), '0')
  // 旧 bug：清空→"0"，再输入 5 → "05"。现在前导零被清除。
  assert.equal(sanitizeNumText('05'), '5')
  assert.equal(sanitizeNumText('000'), '0')
  assert.equal(sanitizeNumText('007'), '7')
})

check('保留小数与合法中间态', () => {
  assert.equal(sanitizeNumText('0.5'), '0.5')
  assert.equal(sanitizeNumText('00.5'), '0.5')
  assert.equal(sanitizeNumText('.5'), '.5')
  assert.equal(sanitizeNumText('5.'), '5.')
  assert.equal(sanitizeNumText('10'), '10')
  assert.equal(sanitizeNumText('1.2.3'), '1.23')
  assert.equal(sanitizeNumText('a1b2'), '12')
  assert.equal(sanitizeNumText('abc'), '')
  assert.equal(sanitizeNumText('-5'), '5')
})

check('toNum：空串/非法/负数按 0', () => {
  assert.equal(toNum(''), 0)
  assert.equal(toNum(undefined), 0)
  assert.equal(toNum('abc'), 0)
  assert.equal(toNum('-1'), 0)
  assert.equal(toNum('3.5'), 3.5)
  assert.equal(toNum('.5'), 0.5)
})

check('draft ↔ budget 往返', () => {
  const b = { sessionBudgetCny: 10, defaultSessionBudgetCny: 10, sessionBudgetCustom: false, monthlyBudgetCny: 200, balanceWarnCny: 5, warnThreshold: 0.8 }
  const d = budgetToDraft(b)
  assert.deepEqual(d, { sessionBudgetCny: '10', monthlyBudgetCny: '200', balanceWarnCny: '5', warnThresholdPct: '80' })
  assert.deepEqual(draftToBudget(d), { sessionBudgetCny: 10, monthlyBudgetCny: 200, balanceWarnCny: 5, warnThreshold: 0.8 })
})

check('提交载荷：空串=0，比例越界钳制', () => {
  assert.deepEqual(
    draftToBudget({ sessionBudgetCny: '', monthlyBudgetCny: '', balanceWarnCny: '', warnThresholdPct: '' }),
    { sessionBudgetCny: 0, monthlyBudgetCny: 0, balanceWarnCny: 0, warnThreshold: 0 },
  )
  assert.equal(draftToBudget({ sessionBudgetCny: '5', monthlyBudgetCny: '1', balanceWarnCny: '1', warnThresholdPct: '150' }).warnThreshold, 1)
})

console.log(`\nPASS ${n} 项`)
