import { SyncthingError } from "./errors.ts";
import type {
  NewSyncthingDevice,
  NewSyncthingFolder,
  SyncthingDeviceConfig,
  SyncthingEvent,
  SyncthingFolderConfig,
  SyncthingFolderStatus,
  SyncthingIgnores,
  SyncthingStatus,
  SyncthingVersion,
} from "./types.ts";

export interface SyncthingClientOpts {
  /** Base URL of the Syncthing daemon, e.g. http://127.0.0.1:8384 (no trailing slash needed). */
  baseUrl: string;
  /** API key from the Syncthing GUI / config.xml. */
  apiKey: string;
  /** Inject a fetch impl (tests). Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds. Default 10_000. */
  timeoutMs?: number;
}

export class SyncthingClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: SyncthingClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  /** GET /rest/system/ping → liveness check. */
  ping(): Promise<{ ping: "pong" }> {
    return this.json("GET", "/rest/system/ping");
  }

  /** GET /rest/system/version */
  getVersion(): Promise<SyncthingVersion> {
    return this.json("GET", "/rest/system/version");
  }

  /** GET /rest/system/status */
  getStatus(): Promise<SyncthingStatus> {
    return this.json("GET", "/rest/system/status");
  }

  /** GET /rest/config/folders */
  listFolders(): Promise<SyncthingFolderConfig[]> {
    return this.json("GET", "/rest/config/folders");
  }

  /** GET /rest/config/folders/{id} */
  getFolder(id: string): Promise<SyncthingFolderConfig> {
    return this.json("GET", `/rest/config/folders/${encodeURIComponent(id)}`);
  }

  /** GET /rest/config/devices */
  listDevices(): Promise<SyncthingDeviceConfig[]> {
    return this.json("GET", "/rest/config/devices");
  }

  /** GET /rest/db/status?folder=ID */
  getFolderStatus(id: string): Promise<SyncthingFolderStatus> {
    return this.json("GET", `/rest/db/status?folder=${encodeURIComponent(id)}`);
  }

  /** GET /rest/db/ignores?folder=ID */
  getIgnores(folder: string): Promise<SyncthingIgnores> {
    return this.json("GET", `/rest/db/ignores?folder=${encodeURIComponent(folder)}`);
  }

  /**
   * POST /rest/db/ignores?folder=ID — replace .stignore content.
   * Pass the parsed lines (no header comments needed — caller decides).
   */
  setIgnores(folder: string, lines: string[]): Promise<SyncthingIgnores> {
    return this.json("POST", `/rest/db/ignores?folder=${encodeURIComponent(folder)}`, {
      ignore: lines,
    });
  }

  /** POST /rest/db/scan?folder=ID[&sub=...] — trigger a rescan. */
  async scan(folder: string, sub?: string): Promise<void> {
    const q = new URLSearchParams({ folder });
    if (sub) q.set("sub", sub);
    await this.send("POST", `/rest/db/scan?${q.toString()}`);
  }

  /** POST /rest/config/folders — add a new folder. */
  async addFolder(folder: NewSyncthingFolder): Promise<void> {
    await this.send("POST", "/rest/config/folders", folder);
  }

  /** DELETE /rest/config/folders/{id} */
  async removeFolder(id: string): Promise<void> {
    await this.send("DELETE", `/rest/config/folders/${encodeURIComponent(id)}`);
  }

  /**
   * POST /rest/config/devices — add a new known device. Idempotent in Syncthing
   * (adding the same device twice is a no-op).
   */
  async addDevice(device: NewSyncthingDevice): Promise<void> {
    await this.send("POST", "/rest/config/devices", device);
  }

  /**
   * PATCH /rest/config/folders/{id} — partial update. Caller provides only the
   * fields to change.
   */
  async patchFolder(id: string, patch: Partial<SyncthingFolderConfig>): Promise<void> {
    await this.send("PATCH", `/rest/config/folders/${encodeURIComponent(id)}`, patch);
  }

  /** PATCH /rest/config/folders/{id} with { paused: true } */
  async pauseFolder(id: string): Promise<void> {
    await this.send("PATCH", `/rest/config/folders/${encodeURIComponent(id)}`, { paused: true });
  }

  /** PATCH /rest/config/folders/{id} with { paused: false } */
  async resumeFolder(id: string): Promise<void> {
    await this.send("PATCH", `/rest/config/folders/${encodeURIComponent(id)}`, { paused: false });
  }

  /**
   * GET /rest/events?since=N — long-poll. Returns up to the daemon's batch size
   * (default 1024 events). Pass the highest `id` from the previous call as `since`.
   */
  events(since = 0, timeoutS = 60): Promise<SyncthingEvent[]> {
    const q = new URLSearchParams({ since: String(since), timeout: String(timeoutS) });
    return this.json("GET", `/rest/events?${q.toString()}`);
  }

  // ---- internals ----

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.send(method, path, body);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new SyncthingError(`invalid JSON from ${path}: ${text.slice(0, 200)}`, res.status, path, cause);
    }
  }

  private async send(method: string, path: string, body?: unknown): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { "X-API-Key": this.apiKey };
    let payload: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body: payload, signal: ctrl.signal });
    } catch (cause) {
      throw new SyncthingError(
        cause instanceof Error && cause.name === "AbortError"
          ? `request to ${path} timed out after ${this.timeoutMs}ms`
          : `network error calling ${path}: ${(cause as Error).message ?? String(cause)}`,
        null,
        path,
        cause,
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new SyncthingError(
        `${method} ${path} → ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
        res.status,
        path,
      );
    }
    return res;
  }
}
