/**
 * dsh-balance — 峰价·每日首次对话前确认的门控纯逻辑（host/client 无关，可单测）。
 *
 * 判定口径（与 shared/tide.ts 一致，官方口径）：
 *  - 峰价 = 北京时间周一至周五 09:00–12:00、14:00–18:00（周末与节假日全天谷价）。
 *  - 「每日」= 北京时间自然日（UTC+8）。
 *  - 每个北京日仅当：开启 && 有当前会话 && 处于峰价 && 该日尚未确认 → 弹窗一次。
 *
 * 存取（localStorage / 内存）由调用方注入，本模块保持纯函数。
 */
import { beijingDateKey, isPeakAt } from './tide.js';
export { beijingDateKey };
/** 是否应弹「峰价对话确认」。 */
export function shouldArmPeakConfirm(input) {
    if (!input.enabled)
        return false;
    if (!input.hasSession)
        return false;
    if (!isPeakAt(input.now, input.holidays ?? []))
        return false;
    if (input.confirmedDate === beijingDateKey(input.now))
        return false;
    return true;
}
export const PEAK_ENABLED_KEY = 'dsh-balance.peakConfirm.enabled';
export function peakEnabledKey() {
    return PEAK_ENABLED_KEY;
}
export function peakDoneKey(dateKey) {
    return `dsh-balance.peakConfirm.done.${dateKey}`;
}
//# sourceMappingURL=peakgate.js.map