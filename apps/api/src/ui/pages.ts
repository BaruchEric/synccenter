import { html, type Raw } from "./html.ts";
import { TYPES } from "./form.ts";
import { crumbLink, page } from "./layout.ts";
import { cloudBadge, historyTable, hostChip, typeBadge, yamlPane, type HistoryRow } from "./render.ts";

/** Display shape — satisfied by both the strict planner manifest and the loose disk-parsed one. */
export interface JobManifestView {
  name: string;
  ruleset: string;
  type: string;
  paths: Record<string, string>;
  cloud?: { rclone_remote: string; remote_path: string } | undefined;
}

/* ---------- login ---------- */

export function loginPage(error?: string): string {
  return page({
    title: "Sign in",
    authed: false,
    body: html`<div class="login-wrap">
  <form class="login-card" method="post" action="/ui/login">
    <span class="wordmark">sync<span class="dot">·</span>center</span>
    <p>Paste the API token to open the console.</p>
    <label for="f-token">API token</label>
    <input class="in mono-in" type="password" id="f-token" name="token" autocomplete="current-password" autofocus required>
    <div class="actions"><button class="btn btn-primary" type="submit">Sign in</button></div>
    ${error ? html`<p class="login-err">${error}</p>` : ""}
  </form>
</div>`,
  });
}

/* ---------- jobs list ---------- */

export interface JobListRow {
  manifest: JobManifestView;
  lastApply?: { ts: string; result: string } | undefined;
}

export function jobsListPage(rows: JobListRow[]): string {
  const body = html`
<div class="page-head">
  <h1>sync jobs</h1>
  <span class="eyebrow">${rows.length === 1 ? "1 job" : `${rows.length} jobs`} in folders/</span>
  <span class="spacer"></span>
  <a class="btn btn-primary" href="/ui/jobs/new">New sync job</a>
</div>
${
  rows.length === 0
    ? html`<div class="empty">
  <span class="glyph">folders/ ∅</span>
  <p>No sync jobs yet. A job is one folder synced across your hosts under one ruleset.</p>
  <p><a class="btn btn-primary" href="/ui/jobs/new">Create the first sync job</a></p>
</div>`
    : html`<div class="jobs">
  <div class="jobs-head"><span>Name</span><span>Type</span><span>Ruleset</span><span>Hosts</span><span>Last apply</span></div>
  ${rows.map((r) => {
    const m = r.manifest;
    return html`<a class="job-row" href="/ui/jobs/${m.name}">
    <span class="name">${m.name} ${cloudBadge(m.cloud)}</span>
    <span>${typeBadge(m.type)}</span>
    <span class="cell">${m.ruleset}</span>
    <span class="hosts">${Object.keys(m.paths).map(hostChip)}</span>
    <span class="cell">${r.lastApply ? html`${r.lastApply.ts.slice(0, 16).replace("T", " ")} · ${r.lastApply.result}` : "never"}</span>
  </a>`;
  })}
</div>`
}`;
  return page({ title: "Sync jobs", crumb: [html`<b>jobs</b>`], body });
}

/* ---------- new job (the forge) ---------- */

export function hostRowFragment(hosts: string[], uid: string): Raw {
  const dl = `pdl-${uid}`;
  return html`<div class="host-row">
  <select class="in" name="host" aria-label="Host"
    hx-get="/ui/frag/browse-host" hx-trigger="change" hx-include="closest .host-row" hx-target="#${dl}" hx-swap="outerHTML">
    <option value="">— host —</option>
    ${hosts.map((h) => html`<option value="${h}">${h}</option>`)}
  </select>
  <input class="in mono-in" name="path" list="${dl}" placeholder="/absolute/path/on/host" aria-label="Path on host" spellcheck="false"
    hx-get="/ui/frag/browse-host" hx-trigger="focus, input changed delay:300ms" hx-include="closest .host-row" hx-target="#${dl}" hx-swap="outerHTML">
  <select class="in" name="htype" aria-label="Per-host type override">
    <option value="">inherit type</option>
    ${TYPES.map((t) => html`<option value="${t}">${t}</option>`)}
  </select>
  <button type="button" class="btn btn-icon" aria-label="Remove this host row" title="Remove row" onclick="this.closest('.host-row').remove()">✕</button>
  <datalist id="${dl}"></datalist>
  <input type="hidden" name="pdl" value="${dl}">
</div>`;
}

export function newJobPage(rules: string[], hosts: string[]): string {
  const body = html`
<div class="page-head">
  <h1>new sync job</h1>
  <span class="eyebrow">forge a folder manifest, then plan &amp; apply</span>
</div>
<div class="forge">
  <form id="job-form" hx-post="/ui/jobs" hx-target="#create-result" hx-swap="innerHTML" autocomplete="off" novalidate>

    <fieldset class="sect">
      <div class="sect-head"><code class="sect-key">name:</code><span class="sect-hint">identity — becomes the Syncthing folder ID and the YAML filename</span></div>
      <div class="field">
        <label for="f-name">Job name</label>
        <input class="in mono-in" id="f-name" name="name" placeholder="media-photos" spellcheck="false"
          hx-post="/ui/frag/validate-name" hx-trigger="input changed delay:350ms" hx-target="#name-check" hx-swap="outerHTML">
        <span id="name-check" class="name-check"></span>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="f-ruleset">Ruleset</label>
          <select class="in" id="f-ruleset" name="ruleset">
            ${rules.map((r) => html`<option value="${r}">${r}</option>`)}
          </select>
          <span class="help">Compiled to .stignore + filter.rclone on apply</span>
        </div>
        <div class="field">
          <label>Folder type</label>
          <div class="pills">
            ${TYPES.map(
              (t, i) =>
                html`<label><input type="radio" name="type" value="${t}" ${i === 0 ? html`checked` : ""}>${t}</label>`,
            )}
          </div>
        </div>
      </div>
    </fieldset>

    <fieldset class="sect">
      <div class="sect-head"><code class="sect-key">paths:</code><span class="sect-hint">where this folder lives on each host</span></div>
      <div id="host-rows">${hostRowFragment(hosts, "0")}</div>
      <button type="button" class="btn btn-sm" hx-get="/ui/frag/host-row" hx-target="#host-rows" hx-swap="beforeend">+ Add host</button>
    </fieldset>

    <fieldset class="sect">
      <div class="sect-head"><code class="sect-key">conflict:</code><span class="sect-hint">what wins when both sides changed</span></div>
      <div class="field-row">
        <div class="field">
          <label for="f-conflict">Policy</label>
          <select class="in" id="f-conflict" name="conflict_policy">
            <option value="">default — newer on bisync</option>
            <option value="newer">newer — latest edit wins</option>
            <option value="older">older — first version wins</option>
            <option value="keep-both">keep-both — keep both copies</option>
            <option value="require-resolve">require-resolve — hold for manual pick</option>
          </select>
        </div>
        <div class="field">
          <label for="f-versioning">File versioning</label>
          <select class="in" id="f-versioning" name="versioning_type">
            <option value="">none</option>
            <option value="off">off — explicit</option>
            <option value="trash">trash — recycle bin</option>
            <option value="simple">simple — keep N copies</option>
            <option value="staggered">staggered — thin out over time</option>
          </select>
        </div>
      </div>
      <div class="field">
        <label for="f-vparams">Versioning params</label>
        <textarea class="in" id="f-vparams" name="versioning_params" rows="2" placeholder="keep: 5" spellcheck="false"></textarea>
        <span class="help">YAML <code>key: value</code> lines — only used with a versioning type</span>
      </div>
    </fieldset>

    <details class="opt">
      <summary><code class="sect-key">cloud:</code><span class="sect-hint">bisync one host's copy to an rclone remote (optional)</span></summary>
      <div class="opt-body">
        <div class="field-row">
          <div class="field">
            <label for="f-cloud-remote">rclone remote</label>
            <input class="in mono-in" id="f-cloud-remote" name="cloud_remote" list="dl-remotes" placeholder="gdrive" spellcheck="false"
              hx-get="/ui/frag/remotes" hx-trigger="focus once" hx-target="#dl-remotes" hx-swap="outerHTML">
            <datalist id="dl-remotes"></datalist>
          </div>
          <div class="field">
            <label for="f-cloud-path">Remote path</label>
            <input class="in mono-in" id="f-cloud-path" name="cloud_path" list="dl-cloud-path" placeholder="sync/media-photos" spellcheck="false"
              hx-get="/ui/frag/browse-remote" hx-trigger="focus, input changed delay:400ms" hx-include="#f-cloud-remote" hx-target="#dl-cloud-path" hx-swap="outerHTML">
            <datalist id="dl-cloud-path"></datalist>
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label for="f-cloud-anchor">Anchor host</label>
            <select class="in" id="f-cloud-anchor" name="cloud_anchor">
              <option value="">auto — the role: cloud-edge host</option>
              ${hosts.map((h) => html`<option value="${h}">${h}</option>`)}
            </select>
          </div>
          <div class="field">
            <label for="f-cloud-schedule">Bisync schedule (cron)</label>
            <div class="cron-row">
              <input class="in mono-in" id="f-cloud-schedule" name="cloud_schedule" placeholder="*/30 * * * *" spellcheck="false"
                hx-post="/ui/frag/cron-hint" hx-trigger="input changed delay:300ms" hx-target="#cron-hint" hx-swap="outerHTML">
              <select class="in" aria-label="Cron presets"
                onchange="var i=document.getElementById('f-cloud-schedule'); if(this.value){i.value=this.value; i.dispatchEvent(new Event('input',{bubbles:true}));} this.selectedIndex=0;">
                <option value="">presets…</option>
                <option value="*/15 * * * *">every 15 minutes</option>
                <option value="*/30 * * * *">every 30 minutes</option>
                <option value="0 * * * *">hourly</option>
                <option value="0 */6 * * *">every 6 hours</option>
                <option value="0 2 * * *">nightly at 02:00</option>
                <option value="0 3 * * 0">weekly — Sun 03:00</option>
              </select>
            </div>
            <span id="cron-hint" class="name-check"></span>
          </div>
        </div>
        <div class="field">
          <label for="f-cloud-flags">Extra bisync flags — one per line</label>
          <textarea class="in" id="f-cloud-flags" name="cloud_flags" rows="2" placeholder="--max-delete 50" spellcheck="false"></textarea>
        </div>
      </div>
    </details>

    <details class="opt">
      <summary><code class="sect-key">tuning</code><span class="sect-hint">permissions &amp; filesystem watcher (optional)</span></summary>
      <div class="opt-body">
        <label class="check"><input type="checkbox" name="ignore_perms"> Ignore permissions <span class="why">— for cross-platform folders (Mac/Win/Linux mode bits differ)</span></label>
        <div class="field-row">
          <div class="field">
            <label for="f-watcher">Filesystem watcher</label>
            <select class="in" id="f-watcher" name="fs_watcher">
              <option value="">engine default</option>
              <option value="true">enabled</option>
              <option value="false">disabled</option>
            </select>
          </div>
          <div class="field">
            <label for="f-watcher-delay">Watcher delay (seconds)</label>
            <input class="in mono-in" id="f-watcher-delay" name="fs_watcher_delay_s" inputmode="numeric" placeholder="10">
          </div>
        </div>
      </div>
    </details>

    <div id="create-result" class="fade-swap"></div>
    <div class="actions">
      <button class="btn btn-primary" type="submit">Create sync job</button>
      <a class="btn btn-ghost" href="/ui/jobs">Cancel</a>
    </div>
  </form>

  <aside class="preview-col">
    <div id="forge-preview" class="fade-swap"
      hx-post="/ui/frag/preview" hx-include="#job-form"
      hx-trigger="load, input from:#job-form delay:400ms, change from:#job-form delay:100ms"
      hx-swap="innerHTML"></div>
    <div class="plan-cta">
      <button type="button" class="btn" hx-post="/ui/frag/preview-plan" hx-include="#job-form" hx-target="#plan-preview" hx-swap="innerHTML">Preview plan</button>
      <span class="help">The exact per-host ops an apply would run</span>
    </div>
    <div id="plan-preview" class="fade-swap"></div>
  </aside>
</div>`;
  return page({ title: "New sync job", crumb: [crumbLink("/ui/jobs", "jobs"), html`<b>new</b>`], body });
}

/* ---------- name check fragment ---------- */

export function nameCheck(state: "ok" | "bad" | "empty", text: string): Raw {
  const cls = state === "ok" ? "ok" : state === "bad" ? "bad" : "";
  return html`<span id="name-check" class="name-check ${cls}">${text}</span>`;
}

/* ---------- job detail ---------- */

export function jobDetailPage(
  name: string,
  manifest: JobManifestView,
  yaml: string,
  history: HistoryRow[],
): string {
  const hosts = Object.keys(manifest.paths);
  const body = html`
<div class="page-head">
  <h1>${name}</h1>
  <span class="spacer"></span>
  <a class="btn btn-ghost btn-sm" href="/ui/jobs">← All jobs</a>
</div>
<div class="detail-grid">
  <div>
    <div class="meta-strip">
      ${typeBadge(manifest.type)}
      <span class="chip">ruleset · ${manifest.ruleset}</span>
      ${cloudBadge(manifest.cloud)}
    </div>
    <div id="host-state" hx-get="/ui/jobs/${name}/state" hx-trigger="load" hx-swap="innerHTML" class="fade-swap" style="margin-bottom:14px">
      <div class="state-strip">${hosts.map((h) => html`<span class="chip"><span class="led"></span><b>${h}</b> checking…</span>`)}</div>
    </div>
    ${yamlPane(name, yaml)}
    <div class="card" style="margin-top:14px">
      <h2><span class="k">apply</span> history</h2>
      ${historyTable(history)}
    </div>
  </div>
  <div>
    <div class="card">
      <h2><span class="k">plan</span> — what apply would do</h2>
      <p class="help" style="margin:0 0 10px">Compiles the ruleset, resolves device IDs, and lists the exact ops per host. Nothing changes.</p>
      <button type="button" class="btn" hx-post="/ui/jobs/${name}/plan" hx-target="#plan-out" hx-swap="innerHTML">Preview plan</button>
      <div id="plan-out" class="fade-swap" style="margin-top:12px"></div>
    </div>
    <div class="card" style="margin-top:14px">
      <h2><span class="k">apply</span> — push to hosts</h2>
      <form class="apply-form" hx-post="/ui/jobs/${name}/apply" hx-target="#apply-out" hx-swap="innerHTML">
        <label class="check"><input type="checkbox" name="dry_run" checked> Dry run <span class="why">— report ops, change nothing</span></label>
        <label class="check"><input type="checkbox" name="prune"> Prune live-only folders <span class="why">— remove folders hosts have that the manifest doesn't</span></label>
        <label class="check"><input type="checkbox" name="force"> Force divergent settings <span class="why">— overwrite live values with the manifest</span></label>
        <label class="check"><input type="checkbox" name="arm"> Arm real apply <span class="why">— required when dry run is off</span></label>
        <div class="actions" style="margin-top:12px">
          <button class="btn btn-primary" type="submit">Apply to ${hosts.length} ${hosts.length === 1 ? "host" : "hosts"}</button>
        </div>
      </form>
      <div id="apply-out" class="fade-swap" style="margin-top:12px"></div>
    </div>
  </div>
</div>`;
  return page({ title: name, crumb: [crumbLink("/ui/jobs", "jobs"), html`<b>${name}</b>`], body });
}

/* ---------- 404 ---------- */

export function notFoundPage(what: string): string {
  return page({
    title: "Not found",
    crumb: [crumbLink("/ui/jobs", "jobs")],
    body: html`<div class="empty" style="margin-top:40px">
  <span class="glyph">404</span>
  <p>${what}</p>
  <p><a class="btn" href="/ui/jobs">← Back to sync jobs</a></p>
</div>`,
  });
}
