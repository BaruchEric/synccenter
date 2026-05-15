import { getToken, clearToken } from "@/lib/auth";

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "/api";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: string | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  if (res.status === 401) {
    clearToken();
    location.reload();
    throw new ApiError("unauthorized", 401);
  }
  if (!res.ok) {
    const msg =
      parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string"
        ? parsed.error
        : `${method} ${path} → ${res.status} ${res.statusText}`;
    throw new ApiError(msg, res.status);
  }
  return parsed as T;
}

export const api = {
  get: <T>(path: string) => send<T>("GET", path),
  post: <T>(path: string, body?: unknown) => send<T>("POST", path, body),
};

// Typed shapes (a subset; expand as needed).
export interface Health { ok: boolean; version: string }
export interface FoldersList { folders: string[] }
export interface RulesList { rules: string[] }
export interface HostsList { hosts: string[] }
export interface ConflictsList { conflicts: Array<{ id: number; folder: string; path: string; detected_at: string }> }
export interface FolderState {
  folder: string;
  perHost: Array<{
    host: string;
    ok: boolean;
    error?: string;
    status?: { state: string; globalBytes: number; localBytes: number; needFiles: number; errors: number };
  }>;
}
export interface ApplyResult {
  folder: string;
  dryRun?: boolean;
  stignorePreview?: string;
  rclonePreview?: string;
  warnings?: string[];
  payloadHash?: string;
  perHost?: Array<{ host: string; ok: boolean; error?: string }>;
}
