import { ResponseCache } from "../routing/cache.js";
import { RequestLog } from "./request-log.js";
import { UsageTracker } from "./usage-tracker.js";

export class ObservabilityStore {
  readonly requestLog: RequestLog;
  readonly usageTracker: UsageTracker;
  readonly cache: ResponseCache;

  constructor() {
    this.requestLog = new RequestLog();
    this.usageTracker = new UsageTracker();
    this.cache = new ResponseCache();
  }
}
