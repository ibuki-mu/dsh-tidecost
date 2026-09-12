/**
 * dsh-balance 会话预算隔离自检（直接驱动打包后的 host 插件，无需运行中的 dsh）。
 * 运行：node test/budget.mjs（先构建 host 生成 lib/index.js）
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../lib/index.js'

let n = 0
function check(name, fn) { fn(); n += 1; console.log('✓', name) }

// ── 伪 cordis 环境：捕获 webServer 路由，其余依赖最小桩 ────────────────────
let route = null
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  credentials: { resolve: async () => undefined }, // 未配置 key：余额返回 no_api_key，不联网
  sessions: { get: () => undefined, list: () => [] },
  webServer: { register: (r) => { route = r; return () => {} } },
  tools: { register: () => () => {} },
  effect: (fn) => fn(),
  on: () => () => {},
}

const dataDir = mkdtempSync(join(tmpdir(), 'dshb-budget-'))
plugin.apply(ctx, { apiBaseUrl: 'https://api.deepseek.com', balanceCacheMs: 60000, dataDir, holidays: [] })
assert.ok(route && route.path === '/dsh-balance/api', 'api route registered')

function call(method, url, body) {
  return new Promise((resolve, reject) => {
    const req = {
      method,
      url,
      on(ev, cb) {
        if (ev === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)))
        if (ev === 'end') cb()
        return req
      },
    }
    const res = {
      status: 0,
      writeHead(s) { this.status = s },
      end(t) {
        try { resolve({ status: this.status, json: JSON.parse(t) }) }
        catch { resolve({ status: this.status, text: t }) }
      },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
}

const get = (sid) => call('GET', `/dsh-balance/api/budget${sid ? `?session=${sid}` : ''}`)
const post = (sid, body) => call('POST', `/dsh-balance/api/budget${sid ? `?session=${sid}` : ''}`, body)

const r1 = await get('session-A')
check('默认：新会话用全局默认会话预算', () => {
  assert.equal(r1.status, 200)
  assert.equal(r1.json.budget.sessionBudgetCny, 10)
  assert.equal(r1.json.budget.defaultSessionBudgetCny, 10)
  assert.equal(r1.json.budget.sessionBudgetCustom, false)
  assert.equal(r1.json.budget.monthlyBudgetCny, 200)
})

const r2 = await post('session-A', { sessionBudgetCny: 3, monthlyBudgetCny: 111, balanceWarnCny: 7, warnThreshold: 0.5 })
check('设置会话 A：仅 A 自定义，全局项更新', () => {
  assert.equal(r2.status, 200)
  assert.equal(r2.json.budget.sessionBudgetCny, 3)
  assert.equal(r2.json.budget.sessionBudgetCustom, true)
  assert.equal(r2.json.budget.monthlyBudgetCny, 111)
  assert.equal(r2.json.budget.balanceWarnCny, 7)
  assert.equal(r2.json.budget.warnThreshold, 0.5)
})

const r3 = await get('session-B')
check('会话 B 隔离：仍是默认值（不受 A 影响）', () => {
  assert.equal(r3.json.budget.sessionBudgetCny, 10)
  assert.equal(r3.json.budget.sessionBudgetCustom, false)
  // 全局项对所有会话一致
  assert.equal(r3.json.budget.monthlyBudgetCny, 111)
})

const r4 = await get('session-A')
check('会话 A 回读保持自定义', () => {
  assert.equal(r4.json.budget.sessionBudgetCny, 3)
  assert.equal(r4.json.budget.sessionBudgetCustom, true)
})

const r5 = await post('session-A', { resetSession: true, sessionBudgetCny: 0, monthlyBudgetCny: 111, balanceWarnCny: 7, warnThreshold: 0.5 })
check('恢复默认：删除 A 的自定义，回落默认', () => {
  assert.equal(r5.json.budget.sessionBudgetCny, 10)
  assert.equal(r5.json.budget.sessionBudgetCustom, false)
})

const r6 = await get()
check('无会话：展示默认会话预算', () => {
  assert.equal(r6.json.budget.sessionBudgetCny, 10)
})
const r7 = await post('', { sessionBudgetCny: 25, monthlyBudgetCny: 111, balanceWarnCny: 7, warnThreshold: 0.5 })
check('无会话保存 = 更新默认，供新会话使用', () => {
  assert.equal(r7.json.budget.defaultSessionBudgetCny, 25)
  assert.equal(r7.json.budget.sessionBudgetCustom, false)
})

const r8 = await get('session-C')
check('新会话继承新默认值', () => {
  assert.equal(r8.json.budget.sessionBudgetCny, 25)
})

check('落盘结构：budget.json 无旧 sessionBudgetCny，隔离表独立', () => {
  const globalBudget = JSON.parse(readFileSync(join(dataDir, 'budget.json'), 'utf8'))
  assert.equal(globalBudget.defaultSessionBudgetCny, 25)
  assert.equal(Object.prototype.hasOwnProperty.call(globalBudget, 'sessionBudgetCny'), false)
  const perSession = JSON.parse(readFileSync(join(dataDir, 'session-budgets.json'), 'utf8'))
  assert.deepEqual(perSession, {}) // A 已被恢复默认删除
})

console.log(`\nPASS ${n} 项`)
