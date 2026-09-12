/**
 * dsh-tidecost 峰谷数学自检（纯 Node，无依赖）。
 * 运行：node test/tide.mjs（先构建 host 生成 lib/shared/tide.js）
 */
import assert from 'node:assert/strict'
import {
  FLASH_REPRICE_MS,
  LEGACY_BOUNDARY_MS,
  beijingScheduleSegments,
  costCny,
  currentBeijingSegmentIndex,
  isHoliday,
  isPeakAt,
  isUtcWeekend,
  phaseAt,
  priceCny,
  priceEntryFor,
  tierAt,
} from '../lib/shared/tide.js'

const iso = (s) => Date.parse(s)
let n = 0
function check(name, fn) {
  fn()
  n += 1
  console.log('✓', name)
}

// 2026-08-17 = 周一；2026-08-22 = 周六；2026-08-23 = 周日（UTC）
check('官方峰窗（UTC 半开区间）', () => {
  const mon = '2026-08-17T'
  assert.equal(isPeakAt(iso(mon + '00:30:00Z')), false, '00:30 valley')
  assert.equal(isPeakAt(iso(mon + '01:00:00Z')), true, '01:00 peak 起')
  assert.equal(isPeakAt(iso(mon + '03:59:59Z')), true, '03:59 peak')
  assert.equal(isPeakAt(iso(mon + '04:00:00Z')), false, '04:00 peak 止')
  assert.equal(isPeakAt(iso(mon + '05:00:00Z')), false, '05:00 valley')
  assert.equal(isPeakAt(iso(mon + '06:00:00Z')), true, '06:00 peak 起')
  assert.equal(isPeakAt(iso(mon + '09:59:59Z')), true, '09:59 peak')
  assert.equal(isPeakAt(iso(mon + '10:00:00Z')), false, '10:00 peak 止')
})

check('北京时段与 UTC 等价', () => {
  // 09:00 北京 = 01:00 UTC；14:00 北京 = 06:00 UTC
  assert.equal(isPeakAt(iso('2026-08-17T01:00:00Z')), true)
  assert.equal(isPeakAt(iso('2026-08-17T04:00:00Z')), false) // 12:00 北京
  assert.equal(isPeakAt(iso('2026-08-17T06:00:00Z')), true) // 14:00 北京
  assert.equal(isPeakAt(iso('2026-08-17T10:00:00Z')), false) // 18:00 北京
})

check('周末全天谷价', () => {
  assert.equal(isUtcWeekend(iso('2026-08-22T03:00:00Z')), true)
  assert.equal(isPeakAt(iso('2026-08-22T03:00:00Z')), false)
  assert.equal(isUtcWeekend(iso('2026-08-23T09:00:00Z')), true)
  assert.equal(isPeakAt(iso('2026-08-23T09:00:00Z')), false)
  assert.equal(tierAt(iso('2026-08-22T03:00:00Z')), 'valley')
})

check('legacy 分界', () => {
  assert.equal(LEGACY_BOUNDARY_MS, iso('2026-08-16T16:00:00Z'))
  assert.equal(tierAt(LEGACY_BOUNDARY_MS - 1), 'legacy')
  // 周日 16:01Z → 谷；周一峰时段 → peak
  assert.equal(tierAt(iso('2026-08-16T16:01:00Z')), 'valley')
  assert.equal(tierAt(iso('2026-08-17T01:30:00Z')), 'peak')
})

check('峰:谷 = 2:1（人民币价表）', () => {
  const usage = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 0 }
  const peak = costCny(usage, 'deepseek-v4-flash', iso('2026-08-17T01:30:00Z'))
  const valley = costCny(usage, 'deepseek-v4-flash', iso('2026-08-17T05:00:00Z'))
  assert.ok(Math.abs(peak / valley - 2) < 1e-9, `peak/valley=${peak / valley}`)
  // 与手算一致：输入 1000×3 + 输出 500×9 + 缓存 2000×0.1 = 3000+4500+200 = 7700 /1e6
  assert.ok(Math.abs(peak - 0.0077) < 1e-9)
  assert.ok(Math.abs(valley - 0.00385) < 1e-9)
})

check('reasoning 不单计（output 已含）', () => {
  // reasoningTokens 额外传入不影响成本
  const a = costCny({ inputTokens: 1, outputTokens: 10 }, 'deepseek-v4-pro', iso('2026-08-17T01:30:00Z'))
  const b = costCny({ inputTokens: 1, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 999 }, 'deepseek-v4-pro', iso('2026-08-17T01:30:00Z'))
  assert.equal(a, b)
})

check('模型兜底/子串匹配', () => {
  const unknown = priceEntryFor('totally-unknown-model')
  const flash = priceEntryFor('deepseek-v4-flash')
  assert.equal(unknown, flash)
  const pro = priceEntryFor('deepseek-v4-pro')
  assert.equal(priceCny('deepseek-v4-flash', iso('2026-08-17T01:30:00Z')).cacheMiss, 3.0)
  assert.equal(priceCny('deepseek-v4-pro', iso('2026-08-17T01:30:00Z')).output, 27.0)
  assert.equal(pro.epochs[pro.epochs.length - 1].valley.output, 13.5)
})

check('phaseAt 工作日前后切换点', () => {
  const p = phaseAt(iso('2026-08-17T05:00:00Z')) // 周一谷段
  assert.equal(p.tier, 'valley')
  assert.equal(p.inPeak, false)
  assert.equal(p.prevAtMs, iso('2026-08-17T04:00:00Z'))
  assert.equal(p.nextAtMs, iso('2026-08-17T06:00:00Z'))
  assert.equal(p.nextIntoPeak, true)
})

check('phaseAt 周末 next = 下周一首次入峰', () => {
  const p = phaseAt(iso('2026-08-22T12:00:00Z')) // 周六
  assert.equal(p.isWeekend, true)
  assert.equal(p.nextAtMs, iso('2026-08-24T01:00:00Z'))
  assert.equal(p.nextIntoPeak, true)
})

check('北京时段表 4 段且与官方一致', () => {
  const segs = beijingScheduleSegments()
  assert.equal(segs.length, 4)
  assert.deepEqual(segs.map((s) => [s.start, s.end, s.tier]), [
    ['09:00', '12:00', 'peak'],
    ['12:00', '14:00', 'valley'],
    ['14:00', '18:00', 'peak'],
    ['18:00', '次日 09:00', 'valley'],
  ])
  // 高亮：周一 01:30Z = 北京 09:30 → 第 0 段；05:00Z = 13:00 → 第 1 段
  assert.equal(currentBeijingSegmentIndex(iso('2026-08-17T01:30:00Z')), 0)
  assert.equal(currentBeijingSegmentIndex(iso('2026-08-17T05:00:00Z')), 1)
  assert.equal(currentBeijingSegmentIndex(iso('2026-08-17T07:00:00Z')), 2) // 15:00 北京
  assert.equal(currentBeijingSegmentIndex(iso('2026-08-17T12:00:00Z')), 3) // 20:00 北京
  assert.equal(currentBeijingSegmentIndex(iso('2026-08-18T00:30:00Z')), 3) // 08:30 北京 → 尾段谷
  assert.equal(currentBeijingSegmentIndex(iso('2026-08-22T12:00:00Z')), null) // 周末
})

check('Flash 系列 2026-09-10 12:00 北京降价（价格纪年）', () => {
  // 边界：北京 2026-09-10 11:59:59 = 03:59:59Z（旧价·峰段）；12:00:00 = 04:00Z（新价·转入午间谷段）
  assert.equal(FLASH_REPRICE_MS, iso('2026-09-10T04:00:00Z'))
  const before = priceCny('deepseek-v4-flash', iso('2026-09-10T03:59:59Z'))
  const after = priceCny('deepseek-v4-flash', iso('2026-09-10T04:00:00Z'))
  assert.deepEqual(before, { cacheHit: 0.10, cacheMiss: 3.0, output: 9.0 })
  assert.deepEqual(after, { cacheHit: 0.02, cacheMiss: 1, output: 4 })
  // 峰段（北京 14:00 = 06:00Z）为新价 2 倍
  assert.deepEqual(priceCny('deepseek-v4-flash', iso('2026-09-10T06:00:00Z')), { cacheHit: 0.04, cacheMiss: 2, output: 8 })
  // 新模型 deepseek-flash（V4.1 Flash）与 Flash 系列同价
  assert.deepEqual(priceCny('deepseek-flash', iso('2026-09-10T06:00:00Z')), { cacheHit: 0.04, cacheMiss: 2, output: 8 })
  assert.deepEqual(priceCny('deepseek-flash', iso('2026-09-10T04:00:00Z')), { cacheHit: 0.02, cacheMiss: 1, output: 4 })
  // Pro 未调整
  assert.deepEqual(priceCny('deepseek-v4-pro', iso('2026-09-10T04:00:00Z')), { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 })
  assert.deepEqual(priceCny('deepseek-v4-pro', iso('2026-09-10T06:00:00Z')), { cacheHit: 0.30, cacheMiss: 9, output: 27 })
  // 成本：峰/谷仍为 2:1，且新价生效
  const usage = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 0 }
  const peak = costCny(usage, 'deepseek-flash', iso('2026-09-10T06:00:00Z'))
  const valley = costCny(usage, 'deepseek-flash', iso('2026-09-10T04:30:00Z'))
  assert.ok(Math.abs(peak / valley - 2) < 1e-9)
  assert.ok(Math.abs(peak - (1000 * 2 + 500 * 8 + 2000 * 0.04) / 1e6) < 1e-12)
})

check('节假日全天谷价（host 名单）', () => {
  const fri = iso('2026-09-11T01:30:00Z') // 周五 北京 09:30（本应峰价）
  assert.equal(isPeakAt(fri), true)
  assert.equal(isPeakAt(fri, ['2026-09-11']), false)
  assert.equal(tierAt(fri, ['2026-09-11']), 'valley')
  assert.equal(isHoliday(fri, ['2026-09-11']), true)
  // 节假日价格走谷价
  assert.deepEqual(priceCny('deepseek-flash', fri, ['2026-09-11']), priceCny('deepseek-flash', iso('2026-09-11T04:30:00Z'), ['2026-09-11']))
  // 相位：节假日无切换点，next 指向下一工作日首次入峰
  const p = phaseAt(fri, ['2026-09-11'])
  assert.equal(p.isHoliday, true)
  assert.equal(p.nextAtMs, iso('2026-09-14T01:00:00Z')) // 周一 09:00 北京
  assert.equal(currentBeijingSegmentIndex(fri, ['2026-09-11']), null)
})

console.log(`\nPASS ${n} 项`)
