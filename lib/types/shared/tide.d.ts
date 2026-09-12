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
export declare const PEAK_WINDOWS_UTC: {
    start: number;
    end: number;
}[];
/** 峰谷时代分界（此前按当时基础价计费，历史正确性）。 */
export declare const LEGACY_BOUNDARY_MS: number;
/** Flash 系列降价生效点：北京时间 2026-09-10 12:00（= 04:00Z）。 */
export declare const FLASH_REPRICE_MS: number;
export interface TierPrices {
    cacheHit: number;
    cacheMiss: number;
    output: number;
}
/** 一个价格纪年区间：`[fromMs, untilMs)` 内适用 valley/peak 两档。 */
export interface PriceEpoch {
    fromMs: number;
    untilMs: number;
    valley: TierPrices;
    peak: TierPrices;
}
export interface ModelPriceEntry {
    /** 按时间升序的价格纪年（首尾用 ±Infinity 兜底）。 */
    epochs: PriceEpoch[];
}
export type TideTier = 'legacy' | 'peak' | 'valley';
export declare const PRICE_TABLE_CNY: Record<string, ModelPriceEntry>;
/** 模型名归一化匹配（精确 → 互相包含 → flash/pro 关键字），未命中返回 Flash 兜底。 */
export declare function priceEntryFor(model: string | undefined): ModelPriceEntry;
/** 以 UTC+8 求该时刻的北京自然日 `YYYY-MM-DD`。 */
export declare function beijingDateKey(atMs: number): string;
/** 是否为周末（UTC 自然日周六/周日）。 */
export declare function isUtcWeekend(atMs: number): boolean;
/** 是否为配置的节假日（北京日期名单）。 */
export declare function isHoliday(atMs: number, holidays?: readonly string[]): boolean;
/**
 * 某一时刻是否为峰时段。
 * 周末与节假日全天谷价 → false；工作日按 UTC 小时窗口判定。
 * @param holidays - 北京日期名单（YYYY-MM-DD），来自 host 配置。
 */
export declare function isPeakAt(atMs: number, holidays?: readonly string[]): boolean;
/** 档位：峰谷生效前 → legacy；峰 → peak；否则 valley。 */
export declare function tierAt(atMs: number, holidays?: readonly string[]): TideTier;
export interface TidePhase {
    tier: TideTier;
    inPeak: boolean;
    isWeekend: boolean;
    isHoliday: boolean;
    at: number;
    prevAtMs: number | null;
    nextAtMs: number | null;
    nextIntoPeak: boolean;
}
/**
 * 当前相位 + 相邻切换点（供倒计时/周末/节假日提示）。
 * 周末与节假日无切换点：prev 落在上一工作日最后一次出峰，next 落在下一工作日首次入峰。
 */
export declare function phaseAt(atMs: number, holidays?: readonly string[]): TidePhase | null;
/** 某一时刻适用的档位价格（按价格纪年 + 当时档位）。 */
export declare function priceCny(model: string | undefined, atMs: number, holidays?: readonly string[]): TierPrices;
/**
 * 一次调用的官方人民币成本。
 * @param tokens - { inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens? }
 *   注意：harness 的 outputTokens = DeepSeek completion_tokens，已含推理 token，
 *   因此 reasoningTokens 不单独计费（与官方仅列 输入命中/未命中/输出 一致）。
 * @param holidays - 节假日北京日期名单（决定节假日走谷价）。
 */
export declare function costCny(tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}, model: string | undefined, atMs: number, holidays?: readonly string[]): number;
export interface BeijingScheduleSegment {
    /** 展示用起止（北京时间，含“次日”表述）。 */
    start: string;
    end: string;
    tier: 'peak' | 'valley';
    /** 数字范围（北京小时），用于高亮判定。 */
    fromBeijingHour: number;
    toBeijingHour: number;
}
/** 官方时段表（北京时间展示用，由 UTC 窗口 +8h 推导）。 */
export declare function beijingScheduleSegments(): BeijingScheduleSegment[];
/**
 * 当前时刻落在时段表第几段（北京时间；00:00–09:00 归属上一段 18:00–次日09:00）。
 * 周末/节假日全天谷价时返回 null（UI 单独展示提示）。
 */
export declare function currentBeijingSegmentIndex(atMs: number, holidays?: readonly string[]): number | null;
