import type { ApiClient } from "./api.ts";
import { ApiError } from "./api.ts";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  mutating: boolean;
  handler: (args: Record<string, unknown>, api: ApiClient) => Promise<unknown>;
}

const FOLDER_NAME: Record<string, unknown> = {
  type: "string",
  description: "Folder name as defined in synccenter-config/folders/<name>.yaml.",
};

const CONFIRM: Record<string, unknown> = {
  type: "boolean",
  description:
    "Must be true. Mutating tools refuse to run without explicit confirmation to prevent accidental side effects.",
};

export const TOOLS: ToolDef[] = [
  {
    name: "sc_health",
    description: "Check that the SyncCenter API is up. Returns { ok, version }.",
    mutating: false,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: (_args, api) => api.get("/health"),
  },
  {
    name: "sc_list_folders",
    description: "List every folder defined in synccenter-config.",
    mutating: false,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: (_args, api) => api.get("/folders"),
  },
  {
    name: "sc_get_folder",
    description: "Return the parsed YAML for one folder.",
    mutating: false,
    inputSchema: {
      type: "object",
      required: ["folder"],
      properties: { folder: FOLDER_NAME },
      additionalProperties: false,
    },
    handler: (args, api) => api.get(`/folders/${encodeURIComponent(String(args.folder))}`),
  },
  {
    name: "sc_folder_state",
    description: "Per-host folder state, aggregated across the Syncthing mesh.",
    mutating: false,
    inputSchema: {
      type: "object",
      required: ["folder"],
      properties: { folder: FOLDER_NAME },
      additionalProperties: false,
    },
    handler: (args, api) => api.get(`/folders/${encodeURIComponent(String(args.folder))}/state`),
  },
  {
    name: "sc_list_conflicts",
    description: "List all unresolved sync conflicts across folders.",
    mutating: false,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: (_args, api) => api.get("/conflicts"),
  },
  {
    name: "sc_recent_changes",
    description: "Recent apply history (last 50 operations) from the audit log.",
    mutating: false,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: (_args, api) => api.get("/apply-history"),
  },
  {
    name: "sc_list_hosts",
    description: "List all hosts registered in synccenter-config.",
    mutating: false,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: (_args, api) => api.get("/hosts"),
  },
  {
    name: "sc_host_status",
    description: "Syncthing daemon version + status for a single host.",
    mutating: false,
    inputSchema: {
      type: "object",
      required: ["host"],
      properties: { host: { type: "string", description: "Host name from synccenter-config/hosts/." } },
      additionalProperties: false,
    },
    handler: (args, api) => api.get(`/hosts/${encodeURIComponent(String(args.host))}/status`),
  },
  {
    name: "sc_compile_rules",
    description:
      "Compile a ruleset to its .stignore and rclone filter outputs. Read-only — does not deploy anything.",
    mutating: false,
    inputSchema: {
      type: "object",
      required: ["ruleset"],
      properties: {
        ruleset: { type: "string", description: "Ruleset name from synccenter-config/rules/." },
        allowDivergent: { type: "boolean", description: "Bypass engine-divergence guard. Default false." },
      },
      additionalProperties: false,
    },
    handler: (args, api) => {
      const qs = args.allowDivergent === true ? "?allowDivergent=true" : "";
      return api.post(`/rules/${encodeURIComponent(String(args.ruleset))}/compile${qs}`);
    },
  },
  {
    name: "sc_pause_folder",
    description: "Pause sync on a folder across every host. Confirm:true required.",
    mutating: true,
    inputSchema: {
      type: "object",
      required: ["folder", "confirm"],
      properties: { folder: FOLDER_NAME, confirm: CONFIRM },
      additionalProperties: false,
    },
    handler: (args, api) => api.post(`/folders/${encodeURIComponent(String(args.folder))}/pause`),
  },
  {
    name: "sc_resume_folder",
    description: "Resume a paused folder across every host. Confirm:true required.",
    mutating: true,
    inputSchema: {
      type: "object",
      required: ["folder", "confirm"],
      properties: { folder: FOLDER_NAME, confirm: CONFIRM },
      additionalProperties: false,
    },
    handler: (args, api) => api.post(`/folders/${encodeURIComponent(String(args.folder))}/resume`),
  },
  {
    name: "sc_apply",
    description:
      "Compile and deploy a folder's .stignore to every Syncthing host, then trigger a scan. Confirm:true required. dryRun:true returns previews without touching daemons (no confirm needed for dry-run).",
    mutating: true,
    inputSchema: {
      type: "object",
      required: ["folder"],
      properties: {
        folder: FOLDER_NAME,
        confirm: CONFIRM,
        dryRun: { type: "boolean", description: "Preview only — no side effects." },
        allowDivergent: { type: "boolean", description: "Bypass engine-divergence guard." },
      },
      additionalProperties: false,
    },
    handler: (args, api) => {
      const qs = new URLSearchParams();
      if (args.dryRun === true) qs.set("dryRun", "true");
      if (args.allowDivergent === true) qs.set("allowDivergent", "true");
      const path = `/folders/${encodeURIComponent(String(args.folder))}/apply${qs.toString() ? `?${qs}` : ""}`;
      return api.post(path);
    },
  },
  {
    name: "sc_trigger_bisync",
    description:
      "Trigger an rclone bisync for a folder. Confirm:true required. ?async=true returns a jobid; poll sc_rclone_job.",
    mutating: true,
    inputSchema: {
      type: "object",
      required: ["folder", "confirm"],
      properties: {
        folder: FOLDER_NAME,
        confirm: CONFIRM,
        async: { type: "boolean" },
        dryRun: { type: "boolean" },
        resync: { type: "boolean", description: "One-time bootstrap / recovery resync." },
      },
      additionalProperties: false,
    },
    handler: (args, api) => {
      const qs = new URLSearchParams();
      if (args.async === true) qs.set("async", "true");
      if (args.dryRun === true) qs.set("dryRun", "true");
      if (args.resync === true) qs.set("resync", "true");
      return api.post(
        `/folders/${encodeURIComponent(String(args.folder))}/bisync${qs.toString() ? `?${qs}` : ""}`,
      );
    },
  },
  {
    name: "sc_rclone_job",
    description: "Look up an rclone job's status by id.",
    mutating: false,
    inputSchema: {
      type: "object",
      required: ["jobid"],
      properties: { jobid: { type: "integer", minimum: 1 } },
      additionalProperties: false,
    },
    handler: (args, api) => api.get(`/rclone/jobs/${Number(args.jobid)}`),
  },
];

/** Validate confirm:true on mutating tools (dry-run carve-out for sc_apply). */
export function requireConfirm(tool: ToolDef, args: Record<string, unknown>): void {
  if (!tool.mutating) return;
  if (tool.name === "sc_apply" && args.dryRun === true) return;
  if (args.confirm !== true) {
    throw new ApiError(
      `${tool.name} is a mutating tool — call it with confirm: true (or dryRun: true for sc_apply).`,
      400,
    );
  }
}
