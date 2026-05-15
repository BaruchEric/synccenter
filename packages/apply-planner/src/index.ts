export { plan } from "./plan.ts";
export { apply } from "./apply.ts";
export { verify } from "./verify.ts";
export { computeDelta } from "./delta.ts";
export { renderCrontab } from "./render-crontab.ts";
export { mapPolicy } from "./conflict.ts";
export { buildSchedulePlan } from "./schedule.ts";
export { createSecretsResolver } from "./secrets.ts";
export { loadFolderManifest, loadHostManifest, loadAllHosts } from "./load.ts";
export type {
  ApplyPlan,
  ApplyOpts,
  ApplyResult,
  AdapterPool,
  DriftReport,
  HostApplyResult,
  HostName,
  FolderType,
  PlanContext,
  SchedulePlan,
  SecretsResolver,
  SyncthingFolderConfig,
  SyncthingFolderDevice,
  SyncthingOp,
} from "./types.ts";
export type { FolderManifest, HostManifest } from "./load.ts";
export { PlanError, DriftError, ApplyError } from "./errors.ts";
