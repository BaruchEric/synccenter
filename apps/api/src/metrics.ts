import type { Request, Response } from "express";
import { SyncthingError } from "@synccenter/adapters";
import type { ApiConfig } from "./config.ts";
import type { Db } from "./db.ts";
import { listFolderManifests } from "./lib/fs.ts";
import type { HostRegistry } from "./registry.ts";

const STARTED = Date.now();

export function metricsHandlerFactory(
  cfg: ApiConfig,
  registry: HostRegistry,
  db: Db,
): (req: Request, res: Response) => Promise<void> {
  return async function metricsHandler(_req, res) {
    const lines: string[] = [];
    const push = (l: string) => lines.push(l);

    // Process / build info
    push("# HELP synccenter_up 1 if the API is responding.");
    push("# TYPE synccenter_up gauge");
    push("synccenter_up 1");
    push("");
    push("# HELP synccenter_uptime_seconds Seconds since API process started.");
    push("# TYPE synccenter_uptime_seconds counter");
    push(`synccenter_uptime_seconds ${((Date.now() - STARTED) / 1000).toFixed(3)}`);
    push("");

    // Apply history aggregates
    type ApplyRow = { result: string; count: number };
    const applyAgg = db
      .query<ApplyRow, []>(
        `SELECT result, COUNT(*) AS count FROM apply_history GROUP BY result`,
      )
      .all();
    push("# HELP synccenter_apply_total Total apply operations by result.");
    push("# TYPE synccenter_apply_total counter");
    for (const row of applyAgg) {
      push(`synccenter_apply_total{result="${escapeLabel(row.result)}"} ${row.count}`);
    }
    if (applyAgg.length === 0) push("synccenter_apply_total{result=\"none\"} 0");
    push("");

    // Conflicts
    const conflictRow = db
      .query<{ c: number }, []>(
        `SELECT COUNT(*) AS c FROM conflict_ledger WHERE resolved_at IS NULL`,
      )
      .get();
    push("# HELP synccenter_conflicts_open Number of unresolved conflicts.");
    push("# TYPE synccenter_conflicts_open gauge");
    push(`synccenter_conflicts_open ${conflictRow?.c ?? 0}`);
    push("");

    // Per-host metrics
    const hosts = registry.list();
    push("# HELP synccenter_host_online 1 if the host's Syncthing API is reachable.");
    push("# TYPE synccenter_host_online gauge");
    push("# HELP synccenter_host_uptime_seconds Syncthing daemon uptime.");
    push("# TYPE synccenter_host_uptime_seconds gauge");
    push("# HELP synccenter_host_version_info Syncthing daemon version.");
    push("# TYPE synccenter_host_version_info gauge");

    type HostResult = {
      host: string;
      online: boolean;
      uptime?: number;
      version?: string;
    };
    const hostResults: HostResult[] = await Promise.all(
      hosts.map(async (host): Promise<HostResult> => {
        try {
          const c = registry.client(host);
          const [v, s] = await Promise.all([c.getVersion(), c.getStatus()]);
          return { host, online: true, uptime: s.uptime, version: v.version };
        } catch {
          return { host, online: false };
        }
      }),
    );
    for (const h of hostResults) {
      push(`synccenter_host_online{host="${escapeLabel(h.host)}"} ${h.online ? 1 : 0}`);
      if (h.online && h.uptime != null) {
        push(`synccenter_host_uptime_seconds{host="${escapeLabel(h.host)}"} ${h.uptime}`);
      }
      if (h.online && h.version) {
        push(
          `synccenter_host_version_info{host="${escapeLabel(h.host)}",version="${escapeLabel(h.version)}"} 1`,
        );
      }
    }
    push("");

    // Per-folder per-host metrics
    const folders = listFolderManifests(cfg.foldersDir);
    push("# HELP synccenter_folder_state_info 1 if folder is in the given state on the host.");
    push("# TYPE synccenter_folder_state_info gauge");
    push("# HELP synccenter_folder_global_bytes Total bytes the folder should hold.");
    push("# TYPE synccenter_folder_global_bytes gauge");
    push("# HELP synccenter_folder_need_files Files needing transfer.");
    push("# TYPE synccenter_folder_need_files gauge");
    push("# HELP synccenter_folder_errors Folder error count.");
    push("# TYPE synccenter_folder_errors gauge");
    push("# HELP synccenter_folder_pull_errors Folder pull-error count.");
    push("# TYPE synccenter_folder_pull_errors gauge");
    // The silent-failure detector. Syncthing throws away the ENTIRE ignore file
    // when one pattern is unsupported, and the folder then syncs with no
    // exclusions — secrets included — while every gauge above stays green.
    // Alert on `synccenter_folder_ignores_error > 0` for any folder/host.
    push("# HELP synccenter_folder_ignores_error 1 if the folder's ignore file failed to parse (ALL rules are then inactive).");
    push("# TYPE synccenter_folder_ignores_error gauge");
    push("# HELP synccenter_folder_ignore_patterns Ignore patterns currently loaded (0 with no error means an empty ignore file).");
    push("# TYPE synccenter_folder_ignore_patterns gauge");

    const folderJobs: Array<{ folder: string; host: string }> = [];
    for (const f of folders) {
      // rclone members have no Syncthing daemon, so every call below would
      // throw and emit a permanent scrape_error series for them. Same filter
      // as `syncthingHosts()` in routes/folders.ts.
      for (const host of Object.keys(f.paths).filter((h) => !registry.isRclone(h))) {
        folderJobs.push({ folder: f.name, host });
      }
    }
    await Promise.all(
      folderJobs.map(async ({ folder, host }) => {
        // Resolved once, outside the settled pair: `client()` throws
        // SYNCHRONOUSLY for an unknown/unconfigured host, which would escape
        // allSettled and reject the whole handler — losing every metric.
        let client;
        try {
          client = registry.client(host);
        } catch (err) {
          push(
            `synccenter_folder_scrape_error{folder="${escapeLabel(folder)}",host="${escapeLabel(host)}",reason="${escapeLabel(briefError(err))}"} 1`,
          );
          return;
        }

        // Status and ignores are independent, and a folder whose status reads
        // fine can still be running with every ignore rule silently discarded,
        // so one failing must not suppress the other. Settled in PARALLEL: run
        // serially and two 10s client timeouts stack to 20s, past the 15s
        // Prometheus scrape_timeout, which drops the entire scrape.
        const [statusRes, ignoresRes] = await Promise.allSettled([
          client.getFolderStatus(folder),
          client.getIgnores(folder),
        ]);

        if (statusRes.status === "fulfilled") {
          const status = statusRes.value;
          push(
            `synccenter_folder_state_info{folder="${escapeLabel(folder)}",host="${escapeLabel(host)}",state="${escapeLabel(status.state)}"} 1`,
          );
          push(
            `synccenter_folder_global_bytes{folder="${escapeLabel(folder)}",host="${escapeLabel(host)}"} ${status.globalBytes}`,
          );
          push(
            `synccenter_folder_need_files{folder="${escapeLabel(folder)}",host="${escapeLabel(host)}"} ${status.needFiles}`,
          );
          push(
            `synccenter_folder_errors{folder="${escapeLabel(folder)}",host="${escapeLabel(host)}"} ${status.errors}`,
          );
          push(
            `synccenter_folder_pull_errors{folder="${escapeLabel(folder)}",host="${escapeLabel(host)}"} ${status.pullErrors}`,
          );
        } else {
          push(
            `synccenter_folder_scrape_error{folder="${escapeLabel(folder)}",host="${escapeLabel(host)}",reason="${escapeLabel(briefError(statusRes.reason))}"} 1`,
          );
        }

        if (ignoresRes.status === "fulfilled") {
          const ig = ignoresRes.value;
          push(
            `synccenter_folder_ignores_error{folder="${escapeLabel(folder)}",host="${escapeLabel(host)}"} ${ig.error ? 1 : 0}`,
          );
          // `expanded`, NOT `ignore`. `ignore` is the raw file content, which
          // Syncthing reads back verbatim even when it refused to parse it —
          // counting that reports a healthy-looking pattern count at the exact
          // moment zero rules are in force. `expanded` is what actually loaded,
          // which is what the HELP text above promises.
          push(
            `synccenter_folder_ignore_patterns{folder="${escapeLabel(folder)}",host="${escapeLabel(host)}"} ${ig.expanded?.length ?? 0}`,
          );
        } else {
          push(
            `synccenter_folder_scrape_error{folder="${escapeLabel(folder)}",host="${escapeLabel(host)}",reason="ignores-${escapeLabel(briefError(ignoresRes.reason))}"} 1`,
          );
        }
      }),
    );

    res.set("Content-Type", "text/plain; version=0.0.4").send(`${lines.join("\n")}\n`);
  };
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function briefError(err: unknown): string {
  if (err instanceof SyncthingError) return `syncthing-${err.status ?? "net"}`;
  return "unknown";
}
