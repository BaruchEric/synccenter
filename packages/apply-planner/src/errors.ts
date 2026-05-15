import type { DriftReport, ApplyResult } from "./types.ts";

export type PlanErrorCode =
  | "MANIFEST_NOT_FOUND"
  | "SCHEMA_INVALID"
  | "UNKNOWN_HOST"
  | "MISSING_RULESET"
  | "MULTIPLE_CLOUD_EDGE"
  | "NO_CLOUD_EDGE_FOR_BISYNC"
  | "SECRET_REF_INVALID"
  | "SOPS_DECRYPT_FAILED";

export type DriftErrorCode =
  | "LIVE_ONLY_FOLDER"
  | "LIVE_ONLY_DEVICE"
  | "DIVERGENT_FIELD"
  | "DIVERGENT_IGNORES";

export type ApplyErrorCode =
  | "HOST_UNREACHABLE"
  | "ADAPTER_TIMEOUT"
  | "ADAPTER_4XX"
  | "ADAPTER_5XX"
  | "VERIFY_FAILED"
  | "BISYNC_NEEDS_RESYNC";

export class PlanError extends Error {
  override readonly cause: unknown;
  constructor(message: string, public readonly code: PlanErrorCode, cause?: unknown) {
    super(message);
    this.name = "PlanError";
    this.cause = cause;
  }
}

export class DriftError extends Error {
  constructor(
    message: string,
    public readonly code: DriftErrorCode,
    public readonly report: DriftReport,
  ) {
    super(message);
    this.name = "DriftError";
  }
}

export class ApplyError extends Error {
  override readonly cause: unknown;
  constructor(
    message: string,
    public readonly code: ApplyErrorCode,
    public readonly partial?: ApplyResult,
    cause?: unknown,
  ) {
    super(message);
    this.name = "ApplyError";
    this.cause = cause;
  }
}
