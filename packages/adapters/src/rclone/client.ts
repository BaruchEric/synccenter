import { RcloneError } from "./errors.ts";
import type {
  BisyncParams,
  BisyncResult,
  RcloneAbout,
  RcloneJobList,
  RcloneJobStatus,
  RclonePid,
  RcloneRemoteList,
  RcloneStats,
  RcloneVersion,
} from "./types.ts";

export interface RcloneClientOpts {
  /** Base URL of the rclone rcd, e.g. http://127.0.0.1:5572 (no trailing slash needed). */
  baseUrl: string;
  /** HTTP basic auth user (when rcd was started with --rc-user). */
  username?: string;
  /** HTTP basic auth password (--rc-pass). */
  password?: string;
  /** Bearer token (alternative to basic auth, --rc-htpasswd token style). */
  bearerToken?: string;
  /** Inject a fetch impl (tests). Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Per-request timeout in ms. Default 30_000 (bisync can be slow). */
  timeoutMs?: number;
}

export class RcloneClient {
  private readonly baseUrl: string;
  private readonly authHeader: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: RcloneClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;

    if (opts.bearerToken) {
      this.authHeader = `Bearer ${opts.bearerToken}`;
    } else if (opts.username != null && opts.password != null) {
      const basic = Buffer.from(`${opts.username}:${opts.password}`, "utf8").toString("base64");
      this.authHeader = `Basic ${basic}`;
    } else {
      this.authHeader = null;
    }
  }

  // ---- system ----

  ping(): Promise<RclonePid> {
    return this.call("core/pid");
  }

  getVersion(): Promise<RcloneVersion> {
    return this.call("core/version");
  }

  getStats(group?: string): Promise<RcloneStats> {
    return this.call("core/stats", group ? { group } : undefined);
  }

  // ---- config ----

  listRemotes(): Promise<RcloneRemoteList> {
    return this.call("config/listremotes");
  }

  getRemote(name: string): Promise<Record<string, unknown>> {
    return this.call("config/get", { name });
  }

  // ---- operations ----

  about(fs: string): Promise<RcloneAbout> {
    return this.call("operations/about", { fs });
  }

  // ---- jobs ----

  listJobs(group?: string): Promise<RcloneJobList> {
    return this.call("job/list", group ? { group } : undefined);
  }

  jobStatus(jobid: number): Promise<RcloneJobStatus> {
    return this.call("job/status", { jobid });
  }

  async stopJob(jobid: number): Promise<void> {
    await this.call("job/stop", { jobid });
  }

  // ---- bisync ----

  /**
   * Trigger an rclone bisync between path1 and path2.
   * If `async: true`, returns `{ jobid }` immediately; poll with jobStatus(jobid).
   */
  bisync(params: BisyncParams): Promise<BisyncResult> {
    const body: Record<string, unknown> = {
      path1: params.path1,
      path2: params.path2,
    };
    if (params.async !== undefined) body._async = params.async;
    if (params.resilient !== undefined) body.resilient = params.resilient;
    if (params.resync !== undefined) body.resync = params.resync;
    if (params.conflictResolve !== undefined) body.conflictResolve = params.conflictResolve;
    if (params.compare !== undefined) body.compare = params.compare;
    if (params.filtersFile !== undefined) body.filtersFile = params.filtersFile;
    if (params.maxLock !== undefined) body.maxLock = params.maxLock;
    if (params.dryRun !== undefined) body.dryRun = params.dryRun;
    if (params.extra) Object.assign(body, params.extra);

    return this.call("sync/bisync", body);
  }

  // ---- internals ----

  private async call<T>(endpoint: string, body?: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl}/${endpoint}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.authHeader) headers.Authorization = this.authHeader;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body ?? {}),
        signal: ctrl.signal,
      });
    } catch (cause) {
      throw new RcloneError(
        cause instanceof Error && cause.name === "AbortError"
          ? `request to ${endpoint} timed out after ${this.timeoutMs}ms`
          : `network error calling ${endpoint}: ${(cause as Error).message ?? String(cause)}`,
        null,
        endpoint,
        undefined,
        cause,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch (cause) {
      throw new RcloneError(
        `invalid JSON from ${endpoint}: ${text.slice(0, 200)}`,
        res.status,
        endpoint,
        undefined,
        cause,
      );
    }

    if (!res.ok) {
      const upstream = parsed as { error?: string; input?: unknown; path?: string; status?: number };
      const message = upstream.error
        ? `${endpoint} → ${res.status}: ${upstream.error}`
        : `${endpoint} → ${res.status} ${res.statusText}`;
      throw new RcloneError(message, res.status, endpoint, upstream);
    }

    return parsed as T;
  }
}
