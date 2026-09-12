/**
 * dsh-tidecost 峰价·每日首次对话前确认 门控自检。
 * 运行：node test/peakgate.mjs（先构建 host 生成 lib/shared/peakgate.js）
 */
import assert from 'node:assert/strict'
import { beijingDateKey, peakDoneKey, peakDoneKeyLegacy, peakEnabledKey, peakEnabledKeyLegacy, shouldArmPeakConfirm } from '../lib/shared/peakgate.js'

const iso = (s) => Date.parse(s)
let n = 0
function check(name, fn) { fn(); n += 1; console.log('✓', name) }

// 2026-08-17 = 周一；2026-08-22 = 周六
check('beijingDateKey（UTC+8）', () => {
  assert.equal(beijingDateKey(iso('2026-08-17T00:00:00Z')), '2026-08-17')
  assert.equal(beijingDateKey(iso('2026-08-17T01:30:00Z')), '2026-08-17') // 北京 09:30
  assert.equal(beijingDateKey(iso('2026-08-17T16:30:00Z')), '2026-08-18') // 北京次日 00:30
  assert.equal(beijingDateKey(iso('2026-08-16T16:00:00Z')), '2026-08-17') // 北京零点整
})

check('shouldArmPeakConfirm 判定矩阵', () => {
  const monPeak = iso('2026-08-17T01:30:00Z') // 周一北京 09:30 峰价
  const monValley = iso('2026-08-17T05:00:00Z') // 周一北京 13:00 谷价
  const sat = iso('2026-08-22T03:00:00Z') // 周六（周末谷价）
  const base = { enabled: true, hasSession: true, confirmedDate: null }
  // 峰价+未确认+有会话+开启 → 弹
  assert.equal(shouldArmPeakConfirm({ ...base, now: monPeak }), true)
  // 当日已确认 → 不弹
  assert.equal(shouldArmPeakConfirm({ ...base, now: monPeak, confirmedDate: '2026-08-17' }), false)
  // 前一日确认不碍事（跨日后重置）
  assert.equal(shouldArmPeakConfirm({ ...base, now: monPeak, confirmedDate: '2026-08-16' }), true)
  // 无会话 → 不弹
  assert.equal(shouldArmPeakConfirm({ ...base, now: monPeak, hasSession: false }), false)
  // 关闭开关 → 不弹
  assert.equal(shouldArmPeakConfirm({ ...base, now: monPeak, enabled: false }), false)
  // 谷价/周末 → 不弹
  assert.equal(shouldArmPeakConfirm({ ...base, now: monValley }), false)
  assert.equal(shouldArmPeakConfirm({ ...base, now: sat }), false)
  // 节假日（工作日但列入名单）→ 不弹；非当日名单不影响
  assert.equal(shouldArmPeakConfirm({ ...base, now: monPeak, holidays: ['2026-08-17'] }), false)
  assert.equal(shouldArmPeakConfirm({ ...base, now: monPeak, holidays: ['2026-08-18'] }), true)
})

check('存储键（新包名）', () => {
  assert.equal(peakEnabledKey(), 'dsh-tidecost.peakConfirm.enabled')
  assert.equal(peakDoneKey('2026-08-17'), 'dsh-tidecost.peakConfirm.done.2026-08-17')
})

check('旧包名遗留键（一次性迁移读取用）', () => {
  assert.equal(peakEnabledKeyLegacy(), 'dsh-balance.peakConfirm.enabled')
  assert.equal(peakDoneKeyLegacy('2026-08-17'), 'dsh-balance.peakConfirm.done.2026-08-17')
})

console.log(`\nPASS ${n} 项`)
