/**
 * SyncCenter console stylesheet.
 *
 * Design language: a machine-room console — gunmetal surfaces, one brass
 * accent, LED greens/ambers/reds reserved strictly for status semantics.
 * Type rule: monospace = machine truth (names, paths, YAML, cron); system
 * sans = human prose (labels, help). Committed dark look.
 */
export const STYLESHEET = /* css */ `
:root {
  --bg: #0e1319;
  --panel: #151c25;
  --panel-2: #1b2430;
  --line: #263140;
  --line-soft: #1e2833;
  --ink: #d9e2ec;
  --muted: #8598ab;
  --faint: #5a6c7f;
  --brass: #d9a054;
  --brass-hi: #eebd7a;
  --brass-dim: #8a6a3d;
  --ok: #58c98f;
  --warn: #dcb84f;
  --err: #e0654f;
  --info: #56aed2;
  --mono: ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.5;
}
a { color: var(--brass); text-decoration: none; }
a:hover { color: var(--brass-hi); text-decoration: underline; }
code, pre, .mono { font-family: var(--mono); }

:focus-visible { outline: 2px solid var(--brass); outline-offset: 2px; border-radius: 2px; }

.shell { max-width: 1280px; margin: 0 auto; padding: 0 24px; }

/* ---------- header ---------- */
.top { border-bottom: 1px solid var(--line); background: var(--panel); }
.top-in { display: flex; align-items: center; gap: 14px; height: 52px; }
.wordmark {
  font-family: var(--mono); font-size: 15px; font-weight: 600;
  letter-spacing: .02em; color: var(--ink);
}
.wordmark:hover { color: var(--ink); text-decoration: none; }
.wordmark .dot { color: var(--brass); }
.crumb { font-family: var(--mono); font-size: 13px; color: var(--muted); flex: 1; min-width: 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.crumb b { color: var(--ink); font-weight: 500; }
.crumb .sep { color: var(--faint); margin: 0 6px; }
.top form { margin: 0; }

/* ---------- page scaffolding ---------- */
main.shell { padding-top: 28px; padding-bottom: 64px; }
.page-head { display: flex; align-items: baseline; gap: 16px; margin-bottom: 22px; flex-wrap: wrap; }
.page-head h1 { font-family: var(--mono); font-size: 20px; font-weight: 600; margin: 0; letter-spacing: .01em; }
.page-head .spacer { flex: 1; }
.eyebrow {
  font-size: 11px; text-transform: uppercase; letter-spacing: .14em;
  color: var(--faint); font-weight: 600;
}

/* ---------- buttons ---------- */
.btn {
  display: inline-flex; align-items: center; gap: 7px;
  font-family: var(--mono); font-size: 13px; font-weight: 500;
  color: var(--ink); background: transparent;
  border: 1px solid var(--line); border-radius: 6px;
  padding: 7px 14px; cursor: pointer; text-decoration: none;
  transition: border-color .12s ease, background .12s ease, color .12s ease;
}
.btn:hover { border-color: var(--brass-dim); color: var(--brass-hi); text-decoration: none; }
.btn-primary { background: var(--brass); border-color: var(--brass); color: #17120a; font-weight: 600; }
.btn-primary:hover { background: var(--brass-hi); border-color: var(--brass-hi); color: #17120a; }
.btn-ghost { border-color: transparent; color: var(--muted); }
.btn-ghost:hover { color: var(--ink); border-color: var(--line); }
.btn-sm { padding: 4px 10px; font-size: 12px; }
.btn-icon { padding: 4px 9px; font-size: 12px; color: var(--muted); }
.btn-icon:hover { color: var(--err); border-color: var(--err); }
.btn[disabled] { opacity: .5; cursor: not-allowed; }
.btn.htmx-request { opacity: .6; pointer-events: none; }
.btn.htmx-request::after { content: "…"; }

/* ---------- forms ---------- */
label { display: block; font-size: 12.5px; color: var(--muted); margin-bottom: 5px; }
.in {
  width: 100%; color: var(--ink); background: var(--bg);
  border: 1px solid var(--line); border-radius: 6px;
  padding: 8px 10px; font-size: 13.5px; font-family: var(--sans);
}
.in:focus { outline: none; border-color: var(--brass); box-shadow: 0 0 0 1px var(--brass); }
.mono-in, select.in, textarea.in { font-family: var(--mono); }
textarea.in { resize: vertical; min-height: 60px; line-height: 1.55; }
select.in { appearance: none; background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%), linear-gradient(135deg, var(--muted) 50%, transparent 50%);
  background-position: calc(100% - 16px) 55%, calc(100% - 11px) 55%; background-size: 5px 5px; background-repeat: no-repeat; padding-right: 28px; }
.field { margin-bottom: 14px; }
.field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.help { font-size: 12px; color: var(--faint); margin-top: 4px; display: block; }
.check { display: flex; align-items: center; gap: 8px; color: var(--ink); font-size: 13px; margin: 0 0 8px; cursor: pointer; }
.check input { accent-color: var(--brass); width: 15px; height: 15px; margin: 0; }
.check .why { color: var(--faint); font-size: 12px; }

/* radio pills for folder type */
.pills { display: flex; gap: 6px; flex-wrap: wrap; }
.pills label {
  display: inline-flex; align-items: center; margin: 0; cursor: pointer;
  font-family: var(--mono); font-size: 12.5px; color: var(--muted);
  border: 1px solid var(--line); border-radius: 999px; padding: 5px 12px;
  transition: border-color .12s ease, color .12s ease, background .12s ease;
}
.pills input { position: absolute; opacity: 0; pointer-events: none; }
.pills label:has(input:checked) {
  color: #17120a; background: var(--brass); border-color: var(--brass); font-weight: 600;
}
.pills label:has(input:focus-visible) { outline: 2px solid var(--brass); outline-offset: 2px; }

/* ---------- the forge (new job) ---------- */
.forge { display: grid; grid-template-columns: minmax(430px, 46%) 1fr; gap: 28px; align-items: start; }
@media (max-width: 1000px) { .forge { grid-template-columns: 1fr; } }

.sect { border: 0; border-top: 1px solid var(--line-soft); margin: 0 0 6px; padding: 16px 0 10px; }
.sect:first-child { border-top: 0; padding-top: 0; }
.sect-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 14px; }
.sect-key { font-family: var(--mono); font-size: 14px; font-weight: 600; color: var(--brass); }
.sect-hint { font-size: 12px; color: var(--faint); }

.host-row { display: grid; grid-template-columns: minmax(120px, 3fr) minmax(160px, 5fr) minmax(110px, 3fr) auto; gap: 8px; margin-bottom: 8px; }
@media (max-width: 560px) {
  .host-row { grid-template-columns: 1fr 1fr; }
  .host-row .btn-icon { justify-self: start; }
}

details.opt { border: 1px solid var(--line-soft); border-radius: 8px; padding: 0; margin-bottom: 10px; }
details.opt > summary {
  cursor: pointer; list-style: none; padding: 11px 14px;
  font-family: var(--mono); font-size: 13px; color: var(--muted);
  display: flex; align-items: center; gap: 8px;
}
details.opt > summary::before { content: "▸"; color: var(--faint); font-size: 11px; transition: transform .12s ease; }
details.opt[open] > summary::before { transform: rotate(90deg); }
details.opt > summary:hover { color: var(--ink); }
details.opt > summary .sect-key { font-size: 13px; }
details.opt > .opt-body { padding: 4px 14px 14px; }

.actions { display: flex; gap: 10px; align-items: center; margin-top: 18px; }

.cron-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
.cron-row select.in { width: 118px; }

.name-check { font-family: var(--mono); font-size: 12px; margin-top: 5px; display: block; min-height: 16px; }
.name-check.ok { color: var(--ok); }
.name-check.bad { color: var(--err); }

/* ---------- preview column ---------- */
.preview-col { position: sticky; top: 20px; display: flex; flex-direction: column; gap: 14px; }
@media (max-width: 1000px) { .preview-col { position: static; } }

.yaml-pane { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; background: var(--panel); }
.file-chrome {
  display: flex; align-items: center; gap: 8px; padding: 8px 14px;
  background: var(--panel-2); border-bottom: 1px solid var(--line);
}
.file-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--brass); flex: none; }
.file-path { font-family: var(--mono); font-size: 12px; color: var(--muted); }
pre.yaml {
  margin: 0; padding: 14px 16px; font-size: 12.5px; line-height: 1.6;
  color: var(--ink); overflow-x: auto; tab-size: 2;
}
pre.yaml .yk { color: var(--info); }

.plan-cta { display: flex; align-items: center; gap: 12px; }
.plan-cta .help { margin: 0; }

/* ---------- panels ---------- */
.panel { border: 1px solid var(--line); border-left-width: 3px; border-radius: 8px; padding: 12px 14px; background: var(--panel); margin: 0 0 12px; }
.panel h3 { margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .1em; font-weight: 600; }
.panel ul { margin: 6px 0 0; padding-left: 18px; }
.panel li { margin: 3px 0; }
.panel code { font-size: 12.5px; }
.panel-err  { border-left-color: var(--err); }
.panel-err h3 { color: var(--err); }
.panel-warn { border-left-color: var(--warn); }
.panel-warn h3 { color: var(--warn); }
.panel-ok   { border-left-color: var(--ok); }
.panel-ok h3 { color: var(--ok); }
.panel-info { border-left-color: var(--info); }
.panel-info h3 { color: var(--info); }
.panel .hint { color: var(--muted); font-size: 12.5px; margin: 6px 0 0; }

/* ---------- plan view ---------- */
.host-card { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); margin-bottom: 10px; overflow: hidden; }
.host-card-head {
  display: flex; align-items: center; gap: 10px; padding: 9px 14px;
  background: var(--panel-2); border-bottom: 1px solid var(--line-soft);
  font-family: var(--mono); font-size: 13px;
}
.host-card-head .n { color: var(--faint); margin-left: auto; font-size: 12px; }
.op { display: flex; gap: 10px; padding: 8px 14px; border-top: 1px solid var(--line-soft); font-size: 12.5px; align-items: baseline; }
.op:first-of-type { border-top: 0; }
.op-kind {
  font-family: var(--mono); font-size: 11px; flex: none; width: 92px;
  color: var(--info); text-transform: lowercase;
}
.op-detail { font-family: var(--mono); color: var(--ink); word-break: break-all; }
.op-detail .dim { color: var(--muted); }
.op details { display: inline; }
.op summary { cursor: pointer; color: var(--brass); font-family: var(--mono); font-size: 12px; }
.op pre { margin: 6px 0 0; padding: 8px 10px; background: var(--bg); border-radius: 6px; font-size: 12px; overflow-x: auto; }

.cron-line { font-family: var(--mono); font-size: 12.5px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; overflow-x: auto; white-space: pre; }

/* ---------- chips, badges, leds ---------- */
.chip {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: var(--mono); font-size: 12px; color: var(--muted);
  border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px;
}
.badge {
  display: inline-block; font-family: var(--mono); font-size: 11px;
  border-radius: 4px; padding: 2px 7px; letter-spacing: .02em;
  color: var(--info); background: color-mix(in srgb, var(--info) 12%, transparent);
}
.badge.cloud { color: var(--brass); background: color-mix(in srgb, var(--brass) 12%, transparent); }
.led { width: 8px; height: 8px; border-radius: 50%; background: var(--faint); flex: none; }
.led.ok { background: var(--ok); }
.led.warn { background: var(--warn); }
.led.err { background: var(--err); }
.led.info { background: var(--info); }
@media (prefers-reduced-motion: no-preference) {
  .led.pulse { animation: led-pulse 1.4s ease-in-out infinite; }
  @keyframes led-pulse { 50% { opacity: .35; } }
}

.state-strip { display: flex; gap: 8px; flex-wrap: wrap; }
.state-strip .chip b { color: var(--ink); font-weight: 500; }

/* ---------- jobs list ---------- */
.jobs { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.jobs-head, .job-row {
  display: grid; grid-template-columns: minmax(140px, 2fr) 110px minmax(110px, 1.5fr) minmax(160px, 2.5fr) minmax(110px, 1.2fr); gap: 14px;
  padding: 10px 16px; align-items: center;
}
.jobs-head {
  background: var(--panel-2); border-bottom: 1px solid var(--line);
  font-size: 11px; text-transform: uppercase; letter-spacing: .12em; color: var(--faint); font-weight: 600;
}
.job-row { background: var(--panel); border-top: 1px solid var(--line-soft); text-decoration: none; color: var(--ink); }
.job-row:first-of-type { border-top: 0; }
.job-row:hover { background: var(--panel-2); text-decoration: none; }
.job-row .name { font-family: var(--mono); font-weight: 600; color: var(--brass); }
.job-row .cell { font-family: var(--mono); font-size: 12.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.job-row .hosts { display: flex; gap: 6px; flex-wrap: wrap; }
@media (max-width: 800px) {
  .jobs-head { display: none; }
  .job-row { grid-template-columns: 1fr; gap: 6px; }
}

.empty {
  border: 1px dashed var(--line); border-radius: 10px; padding: 48px 24px;
  text-align: center; color: var(--muted);
}
.empty .glyph { font-family: var(--mono); font-size: 22px; color: var(--faint); display: block; margin-bottom: 10px; }

/* ---------- detail page ---------- */
.detail-grid { display: grid; grid-template-columns: minmax(380px, 48%) 1fr; gap: 28px; align-items: start; }
@media (max-width: 1000px) { .detail-grid { grid-template-columns: 1fr; } }
.meta-strip { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 12px 0; }
.card { border: 1px solid var(--line); border-radius: 10px; background: var(--panel); padding: 16px; }
.card h2 { font-family: var(--mono); font-size: 14px; margin: 0 0 12px; color: var(--ink); font-weight: 600; }
.card h2 .k { color: var(--brass); }
.apply-form .check { margin-bottom: 10px; }
.arm-note { color: var(--faint); font-size: 12px; }

.hist { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.hist th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .1em; color: var(--faint); font-weight: 600; padding: 6px 10px; border-bottom: 1px solid var(--line); }
.hist td { font-family: var(--mono); padding: 6px 10px; border-bottom: 1px solid var(--line-soft); color: var(--muted); }
.hist td.r-ok { color: var(--ok); }
.hist td.r-error { color: var(--err); }
.hist td.r-dry-run { color: var(--info); }

/* result chips after apply */
.result-chips { display: flex; gap: 8px; flex-wrap: wrap; margin: 4px 0 10px; }

/* ---------- login ---------- */
.login-wrap { min-height: calc(100vh - 53px); display: flex; align-items: center; justify-content: center; padding: 24px; }
.login-card { width: 380px; max-width: 100%; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); padding: 28px; }
.login-card .wordmark { font-size: 18px; display: block; margin-bottom: 4px; }
.login-card p { color: var(--muted); font-size: 13px; margin: 0 0 18px; }
.login-err { color: var(--err); font-size: 12.5px; margin-top: 10px; font-family: var(--mono); }

/* ---------- htmx swap feel ---------- */
@media (prefers-reduced-motion: no-preference) {
  .fade-swap { transition: opacity .18s ease; }
  .fade-swap.htmx-swapping { opacity: .35; }
}
`;
