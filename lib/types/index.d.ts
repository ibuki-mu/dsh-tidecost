/**
 * dsh-tidecost — 侧边栏余额 / 会话逐步 token 用量与花费 / 预算预警（host 侧）。
 *
 * 数据源：
 *  - 余额：ctx.credentials 解析 DEEPSEEK_API_KEY → GET /user/balance
 *  - 逐步用量：ctx.sessions 的 live Session.events（assistant/message.usage +
 *    request/context.model），当前会话必为 live，无需读磁盘 JSONL
 *  - 月度累计：监听 session/event 把带 usage 的 assistant/message 追加到
 *    $DSH_HOME/dsh-tidecost/usage-log.jsonl（仅用于月度预算预警）
 *
 * 规范：所有资源注册挂 ctx.effect（热重载/卸载自动清理）；budget.json 原子写。
 */
import { Context } from '@deepseek-ai/cordis';
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials';
import type { SessionStore } from '@deepseek-ai/dsh-session';
import type { WebServer } from '@deepseek-ai/dsh-host-webserver';
import type ToolRegistry from '@deepseek-ai/dsh-tools';
type AppContext = Context & {
    credentials: CredentialProvider;
    sessions: SessionStore;
    webServer: WebServer;
    tools: ToolRegistry;
};
export declare const name = "dsh-tidecost";
export declare const inject: string[];
export interface Config {
    apiBaseUrl: string;
    balanceCacheMs: number;
    /** 数据目录（缺省 $DSH_HOME/dsh-tidecost）。 */
    dataDir: string;
    /** 节假日北京日期名单（YYYY-MM-DD）；节假日全天谷价。可被 dataDir/holidays.json 覆盖。 */
    holidays: string[];
}
export declare const Config: Config;
export declare function apply(ctx: AppContext, config: Config): void;
export {};
