window.__ModuleLoader__.load({
	id: "dsh-tidecost",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/shared/tide.ts
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
		const PEAK_WINDOWS_UTC = [{
			start: 1,
			end: 4
		}, {
			start: 6,
			end: 10
		}];
		/** 峰谷时代分界（此前按当时基础价计费，历史正确性）。 */
		const LEGACY_BOUNDARY_MS = Date.UTC(2026, 7, 16, 16, 0, 0);
		Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY;
		Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY;
		/** 以 UTC+8 求该时刻的北京自然日 `YYYY-MM-DD`。 */
		function beijingDateKey(atMs) {
			const shifted = new Date(atMs + 288e5);
			return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
		}
		/** 是否为周末（UTC 自然日周六/周日）。 */
		function isUtcWeekend(atMs) {
			const day = new Date(atMs).getUTCDay();
			return day === 0 || day === 6;
		}
		/** 是否为配置的节假日（北京日期名单）。 */
		function isHoliday(atMs, holidays = []) {
			return holidays.length > 0 && holidays.includes(beijingDateKey(atMs));
		}
		/**
		* 某一时刻是否为峰时段。
		* 周末与节假日全天谷价 → false；工作日按 UTC 小时窗口判定。
		* @param holidays - 北京日期名单（YYYY-MM-DD），来自 host 配置。
		*/
		function isPeakAt(atMs, holidays = []) {
			if (isUtcWeekend(atMs)) return false;
			if (isHoliday(atMs, holidays)) return false;
			const hour = new Date(atMs).getUTCHours();
			return PEAK_WINDOWS_UTC.some((w) => {
				const start = Number(w.start);
				const end = Number(w.end);
				if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
				if (start < end) return hour >= start && hour < end;
				return hour >= start || hour < end;
			});
		}
		/** 档位：峰谷生效前 → legacy；峰 → peak；否则 valley。 */
		function tierAt(atMs, holidays = []) {
			if (Number.isFinite(atMs) && atMs < LEGACY_BOUNDARY_MS) return "legacy";
			return isPeakAt(atMs, holidays) ? "peak" : "valley";
		}
		/**
		* 当前相位 + 相邻切换点（供倒计时/周末/节假日提示）。
		* 周末与节假日无切换点：prev 落在上一工作日最后一次出峰，next 落在下一工作日首次入峰。
		*/
		function phaseAt(atMs, holidays = []) {
			if (!Number.isFinite(atMs)) return null;
			const hourAt = (dayOffset, hour) => {
				const d = new Date(atMs);
				d.setUTCDate(d.getUTCDate() + dayOffset);
				d.setUTCHours(hour, 0, 0, 0);
				return d.getTime();
			};
			const collectable = (t) => !isUtcWeekend(t) && !isHoliday(t, holidays);
			const points = [];
			for (let day = -2; day <= 3; day += 1) {
				if (!collectable(hourAt(day, 0))) continue;
				for (const w of PEAK_WINDOWS_UTC) {
					const start = Number(w.start);
					const end = Number(w.end);
					if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
					points.push({
						at: hourAt(day, start),
						intoPeak: true
					});
					points.push({
						at: hourAt(end <= start ? day + 1 : day, end),
						intoPeak: false
					});
				}
			}
			let prev = null;
			let next = null;
			for (const p of points) {
				if (p.at <= atMs && (prev === null || p.at > prev.at)) prev = p;
				if (p.at > atMs && (next === null || p.at < next.at)) next = p;
			}
			return {
				tier: tierAt(atMs, holidays),
				inPeak: isPeakAt(atMs, holidays),
				isWeekend: isUtcWeekend(atMs),
				isHoliday: isHoliday(atMs, holidays),
				at: atMs,
				prevAtMs: prev?.at ?? null,
				nextAtMs: next?.at ?? null,
				nextIntoPeak: next?.intoPeak ?? false
			};
		}
		/** 官方时段表（北京时间展示用，由 UTC 窗口 +8h 推导）。 */
		function beijingScheduleSegments() {
			return [
				{
					start: "09:00",
					end: "12:00",
					tier: "peak",
					fromBeijingHour: 9,
					toBeijingHour: 12
				},
				{
					start: "12:00",
					end: "14:00",
					tier: "valley",
					fromBeijingHour: 12,
					toBeijingHour: 14
				},
				{
					start: "14:00",
					end: "18:00",
					tier: "peak",
					fromBeijingHour: 14,
					toBeijingHour: 18
				},
				{
					start: "18:00",
					end: "次日 09:00",
					tier: "valley",
					fromBeijingHour: 18,
					toBeijingHour: 33
				}
			];
		}
		/**
		* 当前时刻落在时段表第几段（北京时间；00:00–09:00 归属上一段 18:00–次日09:00）。
		* 周末/节假日全天谷价时返回 null（UI 单独展示提示）。
		*/
		function currentBeijingSegmentIndex(atMs, holidays = []) {
			if (isUtcWeekend(atMs) || isHoliday(atMs, holidays)) return null;
			const bjHour = (new Date(atMs).getUTCHours() + 8) % 24;
			const segs = beijingScheduleSegments();
			for (let i = 0; i < segs.length; i += 1) {
				const s = segs[i];
				if (s.toBeijingHour > 24) {
					if (bjHour >= s.fromBeijingHour || bjHour < s.toBeijingHour - 24) return i;
				} else if (s.fromBeijingHour <= bjHour && bjHour < s.toBeijingHour) return i;
			}
			return 3;
		}
		//#endregion
		//#region src/shared/peakgate.ts
		/**
		* dsh-tidecost — 峰价·每日首次对话前确认的门控纯逻辑（host/client 无关，可单测）。
		*
		* 判定口径（与 shared/tide.ts 一致，官方口径）：
		*  - 峰价 = 北京时间周一至周五 09:00–12:00、14:00–18:00（周末与节假日全天谷价）。
		*  - 「每日」= 北京时间自然日（UTC+8）。
		*  - 每个北京日仅当：开启 && 有当前会话 && 处于峰价 && 该日尚未确认 → 弹窗一次。
		*
		* 存取（localStorage / 内存）由调用方注入，本模块保持纯函数。
		*/
		/** 是否应弹「峰价对话确认」。 */
		function shouldArmPeakConfirm(input) {
			if (!input.enabled) return false;
			if (!input.hasSession) return false;
			if (!isPeakAt(input.now, input.holidays ?? [])) return false;
			if (input.confirmedDate === beijingDateKey(input.now)) return false;
			return true;
		}
		const PEAK_ENABLED_KEY = "dsh-tidecost.peakConfirm.enabled";
		function peakEnabledKey() {
			return PEAK_ENABLED_KEY;
		}
		function peakDoneKey(dateKey) {
			return `dsh-tidecost.peakConfirm.done.${dateKey}`;
		}
		function peakEnabledKeyLegacy() {
			return "dsh-balance.peakConfirm.enabled";
		}
		function peakDoneKeyLegacy(dateKey) {
			return `dsh-balance.peakConfirm.done.${dateKey}`;
		}
		//#endregion
		//#region src/shared/budget-input.ts
		/**
		* 归一化数字输入文本：
		*  - 仅保留数字与小数点，且最多一个小数点；
		*  - 去掉多余前导零（"05" → "5"、"000" → "0"），但保留 "0.5" / ".5"；
		*  - 允许空串（清空时不再被强制补 0）。
		*/
		function sanitizeNumText(raw) {
			let v = raw.replace(/[^\d.]/g, "");
			const dot = v.indexOf(".");
			if (dot >= 0) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, "");
			v = v.replace(/^0+(?=\d)/, "");
			return v;
		}
		/** 提交/展示用：空串或非法值按 0 处理。 */
		function toNum(text) {
			const n = Number.parseFloat(String(text ?? ""));
			return Number.isFinite(n) && n >= 0 ? n : 0;
		}
		/** 服务端预算 → 编辑态字符串。 */
		function budgetToDraft(b) {
			return {
				sessionBudgetCny: String(b.sessionBudgetCny),
				monthlyBudgetCny: String(b.monthlyBudgetCny),
				balanceWarnCny: String(b.balanceWarnCny),
				warnThresholdPct: String(Math.round(b.warnThreshold * 100))
			};
		}
		/** 编辑态 → 提交载荷（百分比 0–100 折回 0–1，越界钳制）。 */
		function draftToBudget(d) {
			return {
				sessionBudgetCny: toNum(d.sessionBudgetCny),
				monthlyBudgetCny: toNum(d.monthlyBudgetCny),
				balanceWarnCny: toNum(d.balanceWarnCny),
				warnThreshold: Math.max(0, Math.min(1, toNum(d.warnThresholdPct) / 100))
			};
		}
		//#endregion
		//#region src/client/styles.ts
		/** dsh-tidecost 面板与触发器样式（跟随 DSH 主题变量）。 */
		const styles = `
.dshb-trigger{
  display:flex;align-items:center;gap:5px;width:100%;
  padding:6px 8px;border:1px solid var(--theme-border,#333);border-radius:8px;
  background:transparent;color:var(--theme-text,#ddd);cursor:pointer;font-size:12px;
  white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
}
.dshb-trigger:hover{background:rgba(74,158,255,.08);border-color:var(--theme-accent,#4a9eff)}
.dshb-trigger .dshb-label{overflow:hidden;text-overflow:ellipsis;flex:1;text-align:left;min-width:0}
.dshb-trigger.rail{width:auto;min-width:34px;height:36px;justify-content:center;padding:0 4px;border-radius:10px}
.dshb-dot{width:8px;height:8px;border-radius:50%;flex:none}
.dshb-dot.ok{background:#2ecc71}
.dshb-dot.warn{background:#f1c40f}
.dshb-dot.danger{background:#e74c3c}

/* 峰谷价徽标 */
.dshb-chip{font-size:10px;line-height:1.4;padding:1px 5px;border-radius:8px;white-space:nowrap;flex:none}
.dshb-chip.peak{background:rgba(231,76,60,.15);color:#e67e22}
.dshb-chip.valley{background:rgba(46,204,113,.14);color:#2ecc71}

.dshb-panel{
  position:fixed;left:10px;bottom:58px;z-index:1200;width:min(400px,calc(100vw - 20px));
  max-height:min(72vh,720px);overflow:auto;
  background:var(--theme-panel-bg,#1c1c1e);border:1px solid var(--theme-border,#444);
  border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.45);
  color:var(--theme-text,#ddd);font-size:12px;line-height:1.5;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
}
.dshb-panel::-webkit-scrollbar{width:6px}
.dshb-panel::-webkit-scrollbar-thumb{background:var(--theme-border,#444);border-radius:3px}
.dshb-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--theme-border,#333);position:sticky;top:0;background:inherit;z-index:1}
.dshb-title{font-size:13px;font-weight:600;flex:1}
.dshb-close{background:none;border:none;color:var(--theme-text-secondary,#999);cursor:pointer;font-size:14px;line-height:1;flex:none}
.dshb-close:hover{color:var(--theme-text,#fff)}
.dshb-body{padding:10px 12px;display:grid;gap:10px}
.dshb-card{border:1px solid var(--theme-border,#333);border-radius:8px;padding:8px 10px}
.dshb-card h4{margin:0 0 6px;font-size:11px;color:var(--theme-text-secondary,#888);text-transform:uppercase;letter-spacing:.04em}
.dshb-balance-main{display:flex;align-items:baseline;gap:6px;font-size:20px;font-weight:700}
.dshb-muted{color:var(--theme-text-secondary,#888);font-size:11px}
.dshb-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:4px 10px;margin-top:6px;font-size:11px}
.dshb-grid .k{color:var(--theme-text-secondary,#888)}
.dshb-row{display:flex;gap:6px;align-items:center}
.dshb-btn{background:var(--theme-accent,#4a9eff);color:#fff;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:11px}
.dshb-btn.ghost{background:transparent;border:1px solid var(--theme-border,#555);color:var(--theme-text,#ccc)}
.dshb-btn:disabled{opacity:.5;cursor:not-allowed}
.dshb-error{color:#e74c3c;font-size:11px;white-space:pre-wrap}
.dshb-hint{color:var(--theme-text-secondary,#888);font-size:11px}

/* 峰谷时段卡 */
.dshb-tide-main{display:flex;align-items:baseline;gap:10px;margin-bottom:6px;flex-wrap:wrap}
.dshb-tide-badge{font-size:18px;font-weight:700}
.dshb-tide-badge.peak{color:#e67e22}
.dshb-tide-badge.valley{color:#2ecc71}
.dshb-sched{width:100%;border-collapse:collapse;font-size:11px;margin:2px 0 6px}
.dshb-sched td{padding:2px 8px;border-bottom:1px solid var(--theme-border,#2a2a2a)}
.dshb-sched tr.now{background:rgba(74,158,255,.12)}
.dshb-sched td.pk{color:#e67e22;font-weight:600;text-align:right}
.dshb-sched td.vl{color:#2ecc71;font-weight:600;text-align:right}

.dshb-steps{display:grid;gap:4px;max-height:180px;overflow:auto;font-size:11px}
.dshb-step{display:grid;grid-template-columns:54px 1fr auto;gap:6px;align-items:center;padding:4px 6px;border:1px solid var(--theme-border,#2a2a2a);border-radius:6px}
.dshb-step .m{color:var(--theme-text-secondary,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:4px;min-width:0}
.dshb-step .c{text-align:right;white-space:nowrap}
.dshb-tier{font-size:9px;line-height:1.3;padding:0 3px;border-radius:4px;flex:none}
.dshb-tier.peak{color:#e67e22;background:rgba(231,76,60,.12)}
.dshb-tier.valley{color:#2ecc71;background:rgba(46,204,113,.12)}
.dshb-total{display:flex;justify-content:space-between;gap:8px;border-top:1px solid var(--theme-border,#333);padding-top:6px;margin-top:6px;font-weight:600}
.dshb-budget-form{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.dshb-budget-form label{display:grid;gap:2px;font-size:10px;color:var(--theme-text-secondary,#888)}
.dshb-budget-form input{background:var(--theme-input-bg,#111);color:var(--theme-text,#ddd);border:1px solid var(--theme-border,#444);border-radius:6px;padding:5px 7px;font-size:12px;font-family:inherit}
.dshb-bar{height:6px;background:var(--theme-border,#333);border-radius:3px;overflow:hidden;margin-top:6px}
.dshb-bar > i{display:block;height:100%;background:var(--theme-accent,#4a9eff)}
.dshb-bar.danger > i{background:#e74c3c}
.dshb-bar.warn > i{background:#f1c40f}
.dshb-alerts{display:grid;gap:4px}
.dshb-alert{border-radius:6px;padding:5px 8px;font-size:11px;display:flex;align-items:center;gap:6px}
.dshb-alert.warn{background:rgba(241,196,15,.12);border:1px solid rgba(241,196,15,.35);color:#f1c40f}
.dshb-alert.danger{background:rgba(231,76,60,.12);border:1px solid rgba(231,76,60,.4);color:#e74c3c}
.dshb-alert.ok{background:rgba(46,204,113,.12);border:1px solid rgba(46,204,113,.35);color:#2ecc71}
.dshb-notice-text{flex:1}

/* 峰价·每日首次对话前确认弹窗 */
.dshb-mask{position:fixed;inset:0;z-index:1500;background:rgba(0,0,0,.55);
  display:flex;align-items:center;justify-content:center;padding:20px}
.dshb-modal{width:min(400px,100%);background:var(--theme-panel-bg,#1c1c1e);
  border:1px solid var(--theme-border,#444);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.5);
  color:var(--theme-text,#ddd);overflow:hidden;font-family:inherit}
.dshb-modal-head{display:flex;align-items:center;gap:8px;padding:12px 14px;
  border-bottom:1px solid var(--theme-border,#333)}
.dshb-modal-body{padding:14px;font-size:12.5px;line-height:1.7}
.dshb-modal-body p{margin:0 0 8px}
.dshb-pk{color:#e67e22}
.dshb-modal-actions{display:flex;flex-wrap:wrap;gap:8px;padding:12px 14px;
  border-top:1px solid var(--theme-border,#333)}
.dshb-switch{display:inline-flex;align-items:center;gap:4px;color:var(--theme-text-secondary,#888);
  font-size:11px;cursor:pointer;margin-left:auto}
.dshb-switch input{cursor:pointer}
`;
		//#endregion
		//#region src/client/index.tsx
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
		const inject = ["slots"];
		const API = "/dsh-tidecost/api";
		const POLL_OPEN_MS = 15e3;
		const POLL_CLOSED_MS = 6e4;
		const NOTICE_TTL_MS = 45e3;
		/** 峰价对话确认的常驻判定间隔（面板关闭时也生效）。 */
		const PEAK_CHECK_MS = 3e4;
		function readLocal(key, fallback) {
			try {
				if (typeof window === "undefined" || !window.localStorage) return fallback;
				const v = window.localStorage.getItem(key);
				return v == null ? fallback : v;
			} catch {
				return fallback;
			}
		}
		function writeLocal(key, value) {
			try {
				if (typeof window === "undefined" || !window.localStorage) return;
				window.localStorage.setItem(key, value);
			} catch {}
		}
		function removeLocal(key) {
			try {
				if (typeof window === "undefined" || !window.localStorage) return;
				window.localStorage.removeItem(key);
			} catch {}
		}
		function readPeakEnabled(defaultOn = true) {
			const v = readLocal(peakEnabledKey(), null) ?? readLocal(peakEnabledKeyLegacy(), null);
			return v == null ? defaultOn : v === "1";
		}
		function readPeakDone(dateKey) {
			return readLocal(peakDoneKey(dateKey), null) ?? readLocal(peakDoneKeyLegacy(dateKey), null);
		}
		function writePeakEnabled(on) {
			writeLocal(peakEnabledKey(), on ? "1" : "0");
			removeLocal(peakEnabledKeyLegacy());
		}
		function writePeakDone(dateKey) {
			writeLocal(peakDoneKey(dateKey), "1");
			removeLocal(peakDoneKeyLegacy(dateKey));
		}
		async function fetchJson(path, init) {
			return (await fetch(path, {
				headers: { "content-type": "application/json" },
				...init
			})).json();
		}
		function fmt(n, digits = 2) {
			if (n == null || !Number.isFinite(n)) return "—";
			return n.toFixed(digits);
		}
		function fmtTime(ms) {
			if (!ms) return "—";
			const d = new Date(ms);
			const p = (x) => String(x).padStart(2, "0");
			return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
		}
		function fmtCountdown(seconds) {
			if (seconds == null || !Number.isFinite(seconds)) return "—";
			const s = Math.max(0, Math.floor(seconds));
			const p = (x) => String(x).padStart(2, "0");
			const h = Math.floor(s / 3600);
			const m = Math.floor(s % 3600 / 60);
			const sec = s % 60;
			return `${p(h)}:${p(m)}:${p(sec)}`;
		}
		function tierLabel(tier, weekend = false, holiday = false) {
			if (weekend) return {
				text: "周末·谷价",
				cls: "valley"
			};
			if (holiday) return {
				text: "节假日·谷价",
				cls: "valley"
			};
			if (tier === "peak") return {
				text: "峰价",
				cls: "peak"
			};
			if (tier === "legacy") return {
				text: "历史价",
				cls: "valley"
			};
			return {
				text: "谷价",
				cls: "valley"
			};
		}
		/**
		* 预算输入框的编辑态（字符串）：允许清空、不强制补 0，
		* 并去掉多余前导零（"05" → "5"，但 "0.5" 保持不变）。
		* 纯逻辑见 shared/budget-input.ts（含单测）。
		*/
		function StepRow({ step }) {
			const model = step.model || "unknown";
			const tokens = step.hasUsage ? `${step.inputTokens + (step.cacheReadTokens ?? 0) + (step.cacheWriteTokens ?? 0)}→${step.outputTokens}` : "—";
			const t = tierLabel(step.tier);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dshb-step",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						title: `seq ${step.seq}`,
						children: [
							step.turn,
							".",
							step.step,
							" ",
							fmtTime(step.time)
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "m",
						title: model,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: `dshb-tier ${t.cls}`,
								children: t.text
							}),
							" ",
							model
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "c",
						children: [
							tokens,
							" · ¥",
							fmt(step.costCny)
						]
					})
				]
			});
		}
		function apply(ctx) {
			ctx.effect(() => ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "dsh-tidecost-trigger",
				order: 90,
				label: () => "余额"
			}, BalanceTrigger)), "dsh-tidecost: sidebar trigger");
		}
		function BalanceTrigger({ wide, useSessions }) {
			const current = useSessions ? useSessions((s) => s?.current) : void 0;
			const [open, setOpen] = (0, react.useState)(false);
			const [now, setNow] = (0, react.useState)(() => Date.now());
			const [overview, setOverview] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [draft, setDraft] = (0, react.useState)(null);
			const [saving, setSaving] = (0, react.useState)(false);
			const [tideNotice, setTideNotice] = (0, react.useState)(null);
			const [peakEnabled, setPeakEnabled] = (0, react.useState)(() => readPeakEnabled(true));
			const [confirmedDate, setConfirmedDate] = (0, react.useState)(() => readPeakDone(beijingDateKey(Date.now())));
			const [peakConfirmOpen, setPeakConfirmOpen] = (0, react.useState)(false);
			const shownTodayRef = (0, react.useRef)(false);
			const holidaysRef = (0, react.useRef)([]);
			const lastTierRef = (0, react.useRef)(null);
			const rootRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				let cancelled = false;
				const load = async () => {
					try {
						const data = await fetchJson(`${API}/overview?session=${encodeURIComponent(current ?? "")}`);
						if (cancelled) return;
						setOverview(data);
						setError(data.balanceError ? `余额：${data.balanceError}` : null);
						const prev = lastTierRef.current;
						const tier = data.tide?.tier;
						if (prev && tier && prev !== tier) setTideNotice(tier === "peak" ? "⏰ 已进入峰价时段（成本 ×2）" : "⏰ 已进入谷价时段（半价）");
						if (tier) lastTierRef.current = tier;
					} catch (e) {
						if (!cancelled) setError("加载失败: " + String(e));
					}
				};
				load();
				const timer = window.setInterval(() => void load(), open ? POLL_OPEN_MS : POLL_CLOSED_MS);
				return () => {
					cancelled = true;
					window.clearInterval(timer);
				};
			}, [open, current]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const timer = window.setInterval(() => setNow(Date.now()), 1e3);
				return () => window.clearInterval(timer);
			}, [open]);
			(0, react.useEffect)(() => {
				if (!tideNotice) return;
				const timer = window.setTimeout(() => setTideNotice(null), NOTICE_TTL_MS);
				return () => window.clearTimeout(timer);
			}, [tideNotice]);
			const dismissPeakConfirm = (disableToo = false) => {
				const today = beijingDateKey(Date.now());
				writePeakDone(today);
				setConfirmedDate(today);
				setPeakConfirmOpen(false);
				if (disableToo) {
					writePeakEnabled(false);
					setPeakEnabled(false);
				}
			};
			(0, react.useEffect)(() => {
				const check = () => {
					setNow(Date.now());
					const done = readPeakDone(beijingDateKey(Date.now()));
					if (done !== confirmedDate && done !== null) setConfirmedDate(done);
					if (shownTodayRef.current || peakConfirmOpen) return;
					if (shouldArmPeakConfirm({
						now: Date.now(),
						enabled: peakEnabled,
						confirmedDate: done,
						hasSession: !!current,
						holidays: holidaysRef.current
					})) {
						shownTodayRef.current = true;
						setPeakConfirmOpen(true);
					}
				};
				check();
				const timer = window.setInterval(check, PEAK_CHECK_MS);
				return () => window.clearInterval(timer);
			}, [peakEnabled, current]);
			(0, react.useEffect)(() => {
				if (!peakConfirmOpen) return;
				const onKey = (e) => {
					if (e.key === "Escape") dismissPeakConfirm();
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [peakConfirmOpen]);
			(0, react.useEffect)(() => {
				if (overview) setDraft(budgetToDraft(overview.budget));
			}, [
				current,
				overview?.budget?.sessionBudgetCny,
				overview?.budget?.defaultSessionBudgetCny,
				overview?.budget?.monthlyBudgetCny,
				overview?.budget?.balanceWarnCny,
				overview?.budget?.warnThreshold
			]);
			(0, react.useEffect)(() => {
				holidaysRef.current = overview?.holidays ?? [];
			}, [overview]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const onDown = (e) => {
					if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
				};
				const onKey = (e) => {
					if (e.key === "Escape") setOpen(false);
				};
				document.addEventListener("mousedown", onDown);
				document.addEventListener("keydown", onKey);
				return () => {
					document.removeEventListener("mousedown", onDown);
					document.removeEventListener("keydown", onKey);
				};
			}, [open]);
			const refreshBalance = async () => {
				setError(null);
				try {
					const data = await fetchJson(`${API}/overview?session=${encodeURIComponent(current ?? "")}`);
					setOverview(data);
					setError(data.balanceError ? `余额：${data.balanceError}` : null);
				} catch (e) {
					setError("刷新失败: " + String(e));
				}
			};
			const saveBudget = async (resetSession = false) => {
				if (!draft && !resetSession) return;
				setSaving(true);
				try {
					const numeric = draft ? draftToBudget(draft) : {};
					const body = resetSession ? {
						...numeric,
						resetSession: true
					} : numeric;
					const data = await fetchJson(`${API}/budget?session=${encodeURIComponent(current ?? "")}`, {
						method: "POST",
						body: JSON.stringify(body)
					});
					if (!data.ok) {
						setError(data.error || "保存预算失败");
						return;
					}
					setDraft(budgetToDraft(data.budget));
					await refreshBalance();
				} catch (e) {
					setError("保存失败: " + String(e));
				} finally {
					setSaving(false);
				}
			};
			const level = overview?.level ?? "ok";
			const balance = overview?.balance ?? null;
			const session = overview?.session ?? null;
			const budget = overview?.budget ?? null;
			const monthCost = overview?.monthCostCny ?? 0;
			const holidays = overview?.holidays ?? [];
			const phase = phaseAt(now, holidays);
			const serverTide = overview?.tide;
			const tideTier = phase?.tier ?? serverTide?.tier ?? "valley";
			const isWeekend = phase?.isWeekend ?? serverTide?.isWeekend ?? false;
			const isHolidayToday = phase?.isHoliday ?? false;
			const nextAtMs = phase?.nextAtMs ?? serverTide?.nextAtMs;
			const nextIntoPeak = phase?.nextIntoPeak ?? serverTide?.nextIntoPeak ?? false;
			const secondsUntilNext = nextAtMs != null ? Math.max(0, Math.floor((nextAtMs - now) / 1e3)) : null;
			const tide = tierLabel(tideTier, isWeekend, isHolidayToday);
			const segs = beijingScheduleSegments();
			const nowSeg = currentBeijingSegmentIndex(now, holidays);
			const nextTierText = isWeekend ? "下周一峰价" : nextIntoPeak ? "峰价" : "谷价";
			const steps = session ? [...session.steps].reverse().slice(0, 50) : [];
			const sessionBudgetPct = budget && budget.sessionBudgetCny > 0 && session ? Math.min(100, session.totalCostCny / budget.sessionBudgetCny * 100) : 0;
			const barClass = sessionBudgetPct >= 100 ? "danger" : sessionBudgetPct >= (budget?.warnThreshold ?? .8) * 100 ? "warn" : "";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: rootRef,
				style: { position: "relative" },
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: styles }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						className: `dshb-trigger${wide ? "" : " rail"}`,
						onClick: () => setOpen((o) => !o),
						title: "DeepSeek 余额与峰谷价",
						children: wide ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dshb-label",
								children: balance ? `余额 ¥${fmt(balance.total)}` : "余额 —"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: `dshb-chip ${tide.cls}`,
								title: isWeekend ? "周末全天谷价" : isHolidayToday ? "节假日全天谷价" : tide.text,
								children: isWeekend ? "周末" : isHolidayToday ? "假日" : tide.text
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: `dshb-dot ${level}` })
						] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: 12,
									fontWeight: 700
								},
								children: "¥"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: `dshb-chip ${tide.cls}`,
								style: {
									fontSize: 9,
									padding: "1px 3px"
								},
								children: isWeekend ? "谷" : tideTier === "peak" ? "峰" : "谷"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: `dshb-dot ${level}` })
						] })
					}),
					open && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dshb-panel",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dshb-head",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dshb-title",
								children: "DeepSeek 余额 / 峰谷价 / 用量 / 预算"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "dshb-close",
								onClick: () => setOpen(false),
								"aria-label": "关闭",
								children: "×"
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dshb-body",
							children: [
								error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dshb-error",
									children: error
								}),
								tideNotice && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: `dshb-alert ${tideNotice.includes("峰") ? "warn" : "ok"}`,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dshb-notice-text",
										children: tideNotice
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										className: "dshb-close",
										onClick: () => setTideNotice(null),
										"aria-label": "关闭提醒",
										children: "×"
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dshb-card",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: "当前时段 · 官方峰谷价" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dshb-tide-main",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: `dshb-tide-badge ${tide.cls}`,
												children: [tide.text, tideTier === "peak" ? " ×2" : tideTier === "valley" ? " ×0.5" : ""]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: "dshb-muted",
												children: [
													"距",
													nextTierText,
													" ",
													fmtCountdown(secondsUntilNext)
												]
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dshb-sched-wrap",
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("table", {
													className: "dshb-sched",
													children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: segs.map((s, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
														className: nowSeg === i && !isWeekend ? "now" : "",
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: [
															s.start,
															" – ",
															s.end
														] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
															className: s.tier === "peak" ? "pk" : "vl",
															children: s.tier === "peak" ? "峰" : "谷"
														})]
													}, i)) })
												}),
												isWeekend && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													className: "dshb-hint",
													children: "周六/周日（UTC 自然日）全天谷价，无峰谷切换"
												}),
												!isWeekend && isHolidayToday && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													className: "dshb-hint",
													children: "节假日全天谷价（按 host 节假日名单）"
												})
											]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "dshb-hint",
											children: "谷价 = 峰价一半 · 按调用发生时刻计价（官方人民币价）"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dshb-row",
											style: { marginTop: 6 },
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dshb-muted",
													children: "峰价对话确认："
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dshb-muted",
													children: confirmedDate === beijingDateKey(now) ? "今日已确认" : "今日待确认"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
													className: "dshb-switch",
													title: "启用/停用「峰价每日首次对话前确认」",
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
														type: "checkbox",
														checked: peakEnabled,
														onChange: (e) => {
															const v = e.target.checked;
															writePeakEnabled(v);
															setPeakEnabled(v);
														}
													}), "启用"]
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													className: "dshb-btn ghost",
													onClick: () => setPeakConfirmOpen(true),
													children: "预览弹窗"
												})
											]
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dshb-card",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: "账户余额" }), balance ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dshb-balance-main",
										children: [
											"¥",
											fmt(balance.total),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: "dshb-muted",
												children: [
													balance.currency,
													" · ",
													balance.isAvailable ? "可用" : "不可用"
												]
											})
										]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dshb-grid",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "k",
													children: "充值"
												}),
												" ¥",
												fmt(balance.toppedUp)
											] }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "k",
													children: "赠送"
												}),
												" ¥",
												fmt(balance.granted)
											] }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "k",
													children: "更新"
												}),
												" ",
												fmtTime(balance.fetchedAt)
											] }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dshb-row",
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													className: "dshb-btn ghost",
													onClick: () => void refreshBalance(),
													children: "刷新"
												})
											})
										]
									})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dshb-hint",
										children: overview?.balanceError === "no_api_key" ? "未配置 DEEPSEEK_API_KEY（可在 ~/.dsh/.credentials.yaml 设置）" : "余额暂不可用（" + (overview?.balanceError ?? "加载中…") + "）"
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dshb-card",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: "本会话用量（峰谷计价）" }), session ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dshb-grid",
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "k",
														children: "步数"
													}),
													" ",
													session.stepCount,
													"（有 usage ",
													session.usedStepCount,
													"）"
												] }),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "k",
														children: "总 token"
													}),
													" ",
													session.totalTokens.toLocaleString()
												] }),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "k",
														children: "总花费"
													}),
													" ¥",
													fmt(session.totalCostCny)
												] }),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "k",
														children: "模型"
													}),
													" ",
													session.lastModel ?? "—"
												] }),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "k",
														children: "缓存命中"
													}),
													" ",
													session.cacheHitRate != null ? (session.cacheHitRate * 100).toFixed(1) + "%" : "—"
												] }),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "k",
														children: "会话"
													}),
													" ",
													session.sessionId
												] })
											]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "dshb-steps",
											children: steps.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												className: "dshb-hint",
												children: "暂无已上报 usage 的步骤"
											}) : steps.map((s) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StepRow, { step: s }, s.seq))
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dshb-total",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
												"输入 ",
												session.totalInput.toLocaleString(),
												" / 输出 ",
												session.totalOutput.toLocaleString(),
												" / 缓存读 ",
												session.totalCacheRead.toLocaleString()
											] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["¥", fmt(session.totalCostCny)] })]
										})
									] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dshb-hint",
										children: "打开一个会话后显示每步 token 用量与花费"
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dshb-card",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: "预算与预警" }), budget && draft ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dshb-budget-form",
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [current ? "会话预算 ¥（本会话）" : "会话预算 ¥（默认）", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													type: "text",
													inputMode: "decimal",
													autoComplete: "off",
													placeholder: "0",
													value: draft.sessionBudgetCny,
													onChange: (e) => setDraft({
														...draft,
														sessionBudgetCny: sanitizeNumText(e.target.value)
													})
												})] }),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: ["月度预算 ¥（全局）", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													type: "text",
													inputMode: "decimal",
													autoComplete: "off",
													placeholder: "0",
													value: draft.monthlyBudgetCny,
													onChange: (e) => setDraft({
														...draft,
														monthlyBudgetCny: sanitizeNumText(e.target.value)
													})
												})] }),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: ["余额预警线 ¥（全局）", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													type: "text",
													inputMode: "decimal",
													autoComplete: "off",
													placeholder: "0",
													value: draft.balanceWarnCny,
													onChange: (e) => setDraft({
														...draft,
														balanceWarnCny: sanitizeNumText(e.target.value)
													})
												})] }),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: ["预警比例 %（全局）", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													type: "text",
													inputMode: "numeric",
													autoComplete: "off",
													placeholder: "80",
													value: draft.warnThresholdPct,
													onChange: (e) => setDraft({
														...draft,
														warnThresholdPct: sanitizeNumText(e.target.value)
													})
												})] })
											]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "dshb-hint",
											children: current ? budget.sessionBudgetCustom ? `本会话已单独设置（默认 ¥${fmt(budget.defaultSessionBudgetCny)}）；保存仅影响本会话` : `本会话未单独设置，使用默认 ¥${fmt(budget.defaultSessionBudgetCny)}；保存后仅本会话生效` : `当前无会话：此项为默认会话预算 ¥${fmt(toNum(draft.sessionBudgetCny))}，对之后新建的会话生效`
										}),
										budget.sessionBudgetCny > 0 && session && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: `dshb-bar ${barClass}`,
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", { style: { width: `${sessionBudgetPct}%` } })
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dshb-grid",
											style: { marginTop: 6 },
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "k",
													children: "本会话"
												}),
												" ¥",
												fmt(session?.totalCostCny)
											] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "k",
													children: "本月"
												}),
												" ¥",
												fmt(monthCost)
											] })]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dshb-row",
											style: { marginTop: 8 },
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												className: "dshb-btn",
												onClick: () => void saveBudget(),
												disabled: saving,
												children: saving ? "保存中…" : "保存预算"
											}), current && budget.sessionBudgetCustom && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												className: "dshb-btn ghost",
												onClick: () => void saveBudget(true),
												disabled: saving,
												title: "删除本会话的自定义会话预算，回落到默认值",
												children: "恢复默认"
											})]
										})
									] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dshb-hint",
										children: "预算配置加载中…"
									})]
								}),
								overview && overview.alerts.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dshb-card",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: "预警" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dshb-alerts",
										children: overview.alerts.map((a, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: `dshb-alert ${a.level}`,
											children: a.message
										}, i))
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dshb-hint",
									style: { marginTop: 2 },
									children: "⚠️ 仅支持 DeepSeek API（deepseek-official）：余额取 DeepSeek 账户， 峰谷价与单价均为官方口径；其他 provider 的费用为 Flash 兜底估算，仅供参考。"
								})
							]
						})]
					}),
					peakConfirmOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dshb-mask",
						onClick: () => dismissPeakConfirm(),
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dshb-modal",
							role: "dialog",
							"aria-modal": "true",
							onClick: (e) => e.stopPropagation(),
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dshb-modal-head",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dshb-chip peak",
										children: "峰价时段"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dshb-title",
										children: "对话确认"
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dshb-modal-body",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
										"当前处于 DeepSeek API ",
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", {
											className: "dshb-pk",
											children: "峰价时段"
										}),
										"（北京时间 09:00–12:00 / 14:00–18:00）， 价格约为谷价的 ",
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "2 倍" }),
										"。"
									] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
										"这是",
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "今日首次" }),
										"在峰价下开始对话。非紧急任务建议等谷价（半价）再运行。"
									] })]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dshb-modal-actions",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											className: "dshb-btn",
											onClick: () => dismissPeakConfirm(),
											children: "知道了，继续（今日不再提醒）"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											className: "dshb-btn ghost",
											onClick: () => dismissPeakConfirm(),
											children: "关闭"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											className: "dshb-btn ghost",
											onClick: () => dismissPeakConfirm(true),
											children: "以后都别提醒"
										})
									]
								})
							]
						})
					})
				]
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map