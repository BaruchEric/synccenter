import type {
  ApplyPlan,
  ApplyResult,
  DriftReport,
  SchedulePlan,
  SyncthingOp,
} from "@synccenter/apply-planner";
import { renderCrontab } from "@synccenter/apply-planner";
import { esc, html, raw, type Raw } from "./html.ts";

/* ---------- small pieces ---------- */

export function typeBadge(type: string): Raw {
  return html`<span class="badge">${type}</span>`;
}

/** One badge per rclone member of the folder (host name + remote path). */
export function cloudBadge(members: Array<{ host: string; path: string }>): Raw | "" {
  if (members.length === 0) return "";
  return html`${members.map((m) => html`<span class="badge cloud">☁ ${m.host}:${m.path}</span>`)}`;
}

/** The rclone members of a folder, in paths order. */
export function rcloneMembersOf(
  paths: Record<string, string>,
  rcloneHosts: ReadonlySet<string>,
): Array<{ host: string; path: string }> {
  return Object.entries(paths)
    .filter(([host]) => rcloneHosts.has(host))
    .map(([host, path]) => ({ host, path }));
}

export function hostChip(name: string): Raw {
  return html`<span class="chip">${name}</span>`;
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Datalist fragment — swapped wholesale so the id must ride along. */
export function datalist(id: string, values: string[]): Raw {
  return html`<datalist id="${id}">${values.map((v) => html`<option value="${v}"></option>`)}</datalist>`;
}

/* ---------- panels ---------- */

export function errorPanel(errors: string[], title = "Fix these first"): Raw {
  return html`<div class="panel panel-err"><h3>${title}</h3><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>`;
}

export function warnPanel(warnings: string[], title = "Worth a look"): Raw {
  return html`<div class="panel panel-warn"><h3>${title}</h3><ul>${warnings.map((w) => html`<li>${w}</li>`)}</ul></div>`;
}

export function okPanel(title: string, body: Raw | string): Raw {
  return html`<div class="panel panel-ok"><h3>${title}</h3>${body}</div>`;
}

export function infoPanel(title: string, body: Raw | string): Raw {
  return html`<div class="panel panel-info"><h3>${title}</h3>${body}</div>`;
}

/* ---------- YAML pane ---------- */

/** Escape YAML and tint top-level keys — the pane shows the file being forged. */
function yamlToHtml(yaml: string): Raw {
  const lines = yaml.replace(/\n$/, "").split("\n");
  const out = lines
    .map((line) => {
      const m = /^([a-z_]+):(.*)$/.exec(line);
      if (m) return `<span class="yk">${esc(m[1])}:</span>${esc(m[2] ?? "")}`;
      return esc(line);
    })
    .join("\n");
  return raw(out);
}

export function yamlPane(name: string, yaml: string): Raw {
  const file = name ? `${name}.yaml` : "‹name›.yaml";
  return html`<section class="yaml-pane">
  <div class="file-chrome"><span class="file-dot"></span><span class="file-path">synccenter-config/folders/${file}</span></div>
  <pre class="yaml">${yamlToHtml(yaml)}</pre>
</section>`;
}

/* ---------- plan view ---------- */

function opRow(op: SyncthingOp): Raw {
  switch (op.kind) {
    case "addDevice":
      return html`<div class="op"><span class="op-kind">addDevice</span><span class="op-detail">trust ${op.name} <span class="dim">(${op.deviceID.slice(0, 7)}…)</span></span></div>`;
    case "addFolder": {
      const f = op.folder;
      const extras = [
        f.type,
        f.ignorePerms ? "ignorePerms" : "",
        f.fsWatcherEnabled === false ? "watcher off" : "",
        f.fsWatcherDelayS !== undefined ? `delay ${f.fsWatcherDelayS}s` : "",
      ].filter(Boolean);
      return html`<div class="op"><span class="op-kind">addFolder</span><span class="op-detail">${f.path} <span class="dim">· ${extras.join(" · ")}</span></span></div>`;
    }
    case "patchFolder":
      return html`<div class="op"><span class="op-kind">patchFolder</span><span class="op-detail">update ${Object.keys(op.patch).join(", ")}</span></div>`;
    case "setIgnores":
      return html`<div class="op"><span class="op-kind">setIgnores</span><span class="op-detail">${op.lines.length} ignore ${op.lines.length === 1 ? "line" : "lines"}
        <details><summary>show</summary><pre>${op.lines.join("\n") || "(empty)"}</pre></details></span></div>`;
    case "removeFolder":
      return html`<div class="op"><span class="op-kind">removeFolder</span><span class="op-detail">${op.folderId}</span></div>`;
  }
}

export function planView(plan: ApplyPlan): Raw {
  const hosts = Object.entries(plan.perHost);
  const cron = renderCrontab(plan.schedule);
  return html`
${plan.warnings.length > 0 ? warnPanel(plan.warnings, "Plan warnings") : ""}
<div class="eyebrow" style="margin-bottom:8px">Plan — ${hosts.length} ${hosts.length === 1 ? "host" : "hosts"}, ${hosts.reduce((n, [, ops]) => n + ops.length, 0)} ops</div>
${hosts.map(
  ([host, ops]) => html`<div class="host-card">
  <div class="host-card-head"><span class="led info"></span>${host}<span class="n">${ops.length} ops</span></div>
  ${ops.map(opRow)}
</div>`,
)}
${
  plan.schedule.length > 0
    ? html`<div class="eyebrow" style="margin:14px 0 8px">Bisync crontab — on ${scheduleAnchors(plan.schedule)}</div>
<div class="cron-line">${cron.trimEnd()}</div>`
    : ""
}`;
}

function scheduleAnchors(schedule: SchedulePlan[]): string {
  return [...new Set(schedule.map((s) => s.anchor))].join(", ");
}

/** Plan failed to build (usually sops off-host). Rendered as a warning, not a crash. */
export function planUnavailable(err: unknown): Raw {
  const message = err instanceof Error ? err.message : String(err);
  const sops = /SOPS|sops|ENOENT/.test(message);
  return html`<div class="panel panel-warn"><h3>Plan unavailable</h3>
<code>${message}</code>
${
  sops
    ? html`<p class="hint">Planning resolves device IDs with sops — it works where sops and the age key live (the server host). The manifest itself is unaffected.</p>`
    : ""
}</div>`;
}

/* ---------- apply outcome ---------- */

export function blockedPanel(code: "LIVE_ONLY" | "DIVERGENT", details: unknown[]): Raw {
  if (code === "LIVE_ONLY") {
    const items = details as Array<{ host: string; folderId: string }>;
    return html`<div class="panel panel-warn"><h3>Blocked — live-only folders</h3>
<p>These folders exist on hosts but not in the manifest:</p>
<ul>${items.map((d) => html`<li><code>${d.folderId}</code> on <code>${d.host}</code></li>`)}</ul>
<p class="hint">Tick <b>Prune live-only folders</b> and apply again to remove them, or leave them alone and they stay.</p></div>`;
  }
  const items = details as Array<{ host: string; path: string; expected: unknown; actual: unknown }>;
  return html`<div class="panel panel-warn"><h3>Blocked — live settings diverge</h3>
<ul>${items.map(
    (d) =>
      html`<li><code>${d.host}</code> · <code>${d.path}</code>: live <code>${JSON.stringify(d.actual)}</code> ≠ manifest <code>${JSON.stringify(d.expected)}</code></li>`,
  )}</ul>
<p class="hint">Tick <b>Force divergent settings</b> to overwrite the live values with the manifest.</p></div>`;
}

export function applyResultView(result: ApplyResult, delta: DriftReport, dryRun: boolean): Raw {
  const failed = result.hosts.filter((h) => h.status === "failed");
  const chips = result.hosts.map((h) => {
    const led = h.status === "applied" ? "ok" : h.status === "failed" ? "err" : "";
    return html`<span class="chip"><span class="led ${led}"></span><b>${h.host}</b> ${h.status} · ${h.ops.length} ops</span>`;
  });
  return html`
${dryRun ? infoPanel("Dry run", html`<p>Nothing was changed on any host. Uncheck <b>Dry run</b> and arm to apply for real.</p>`) : ""}
<div class="result-chips">${chips}</div>
${
  failed.length > 0
    ? errorPanel(
        failed.map((h) => `${h.host}: ${h.error ? `${h.error.code} — ${h.error.message}` : "failed"}`),
        "Host failures",
      )
    : dryRun
      ? ""
      : okPanel("Applied", html`<p>${result.hosts.length} ${result.hosts.length === 1 ? "host" : "hosts"} updated${result.verified ? " and verified by read-back" : ""}.</p>`)
}
${delta.manifestOnly.length > 0 && dryRun ? html`<p class="hint" style="color:var(--muted)">${delta.manifestOnly.length} pending ops would run.</p>` : ""}
${
  result.schedule.length > 0 && !dryRun
    ? html`<div class="eyebrow" style="margin:10px 0 6px">Install on ${scheduleAnchors(result.schedule)}</div><div class="cron-line">${renderCrontab(result.schedule).trimEnd()}</div>`
    : ""
}`;
}

/* ---------- live folder state ---------- */

export interface HostFolderState {
  host: string;
  ok: boolean;
  state?: string;
  needBytes?: number;
  error?: string;
  /** rclone members have no live Syncthing state — rendered as a bisync chip. */
  rclone?: boolean;
}

const STATE_LED: Record<string, string> = {
  idle: "ok",
  scanning: "info pulse",
  syncing: "info pulse",
  "sync-preparing": "info pulse",
  error: "err",
  outofsync: "err",
};

export function hostStateStrip(states: HostFolderState[]): Raw {
  return html`<div class="state-strip">${states.map((s) => {
    if (s.rclone) {
      return html`<span class="chip"><span class="led info"></span><b>☁ ${s.host}</b> bisync member</span>`;
    }
    if (!s.ok) {
      return html`<span class="chip" title="${s.error ?? ""}"><span class="led err"></span><b>${s.host}</b> unreachable</span>`;
    }
    const led = STATE_LED[s.state ?? ""] ?? "";
    const need = s.needBytes && s.needBytes > 0 ? html` · ${fmtBytes(s.needBytes)} to pull` : "";
    return html`<span class="chip"><span class="led ${led}"></span><b>${s.host}</b> ${s.state ?? "unknown"}${need}</span>`;
  })}</div>`;
}

/* ---------- apply history ---------- */

export interface HistoryRow {
  ts: string;
  actor: string;
  source: string;
  result: string;
  note: string | null;
}

export function historyTable(rows: HistoryRow[]): Raw {
  if (rows.length === 0) {
    return html`<p class="help">No applies recorded yet.</p>`;
  }
  return html`<table class="hist">
<thead><tr><th>When</th><th>Source</th><th>Result</th><th>Note</th></tr></thead>
<tbody>${rows.map(
    (r) => html`<tr><td>${r.ts.replace("T", " ").slice(0, 19)}</td><td>${r.source}/${r.actor}</td><td class="r-${r.result}">${r.result}</td><td>${r.note ?? ""}</td></tr>`,
  )}</tbody>
</table>`;
}
