import { ScError } from "./config.ts";

export interface ApiClientOpts {
  baseUrl?: string;
  token?: string;
  env?: NodeJS.ProcessEnv;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(opts: ApiClientOpts = {}) {
    const env = opts.env ?? process.env;
    const url = opts.baseUrl ?? env.SC_API_URL;
    if (!url) {
      throw new ScError("no API URL — pass --api <url> or set SC_API_URL", 2);
    }
    this.baseUrl = url.replace(/\/+$/, "");
    const tok = opts.token ?? env.SC_TOKEN ?? env.SC_API_TOKEN ?? "";
    if (!tok) {
      throw new ScError("no API token — set SC_TOKEN (or SC_API_TOKEN)", 2);
    }
    this.token = tok;
  }

  get<T>(path: string): Promise<T> {
    return this.send<T>("GET", path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.send<T>("POST", path, body);
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    let payload: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, { method, headers, body: payload });
    } catch (err) {
      throw new ScError(`network error calling ${path}: ${(err as Error).message}`, 1);
    }
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // non-JSON response — pass through as raw text inside an envelope
        parsed = { raw: text };
      }
    }
    if (!res.ok) {
      const errMsg =
        parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string"
          ? parsed.error
          : `${method} ${path} → ${res.status} ${res.statusText}`;
      throw new ScError(`${errMsg} (HTTP ${res.status})`, res.status === 401 ? 2 : 1);
    }
    return parsed as T;
  }
}

export function apiFromCmd(cmd: { optsWithGlobals: () => Record<string, unknown> }): ApiClient {
  const opts = cmd.optsWithGlobals();
  const init: ApiClientOpts = {};
  if (typeof opts.api === "string") init.baseUrl = opts.api;
  if (typeof opts.token === "string") init.token = opts.token;
  return new ApiClient(init);
}
