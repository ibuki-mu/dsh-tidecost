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
import { beijingDateKey } from './tide.js';
export { beijingDateKey };
export interface PeakConfirmArmInput {
    now: number;
    /** 提醒开关（默认开）。 */
    enabled: boolean;
    /** 已确认的北京日（YYYY-MM-DD），无则 null。 */
    confirmedDate: string | null;
    /** 是否有当前会话（「对话前」语境）。 */
    hasSession: boolean;
    /** 节假日北京日期名单（节假日走谷价，不提醒）。 */
    holidays?: readonly string[];
}
/** 是否应弹「峰价对话确认」。 */
export declare function shouldArmPeakConfirm(input: PeakConfirmArmInput): boolean;
export declare const PEAK_ENABLED_KEY = "dsh-balance.peakConfirm.enabled";
export declare function peakEnabledKey(): string;
export declare function peakDoneKey(dateKey: string): string;
