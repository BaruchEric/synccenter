import express, { Router, type NextFunction, type Request, type Response } from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { RcloneClient } from "@synccenter/adapters";
import { CompileError } from "@synccenter/rule-compiler";
import { PlanError, validateFolderManifest } from "@synccenter/apply-planner";
import { canonicalEmit, FOLDER_KEY_ORDER } from "@synccenter/state-importer";
import type { ApiConfig } from "../config.ts";
import type { Db } from "../db.ts";
import { listFolderManifests, listYamlNames, parseFolderByName } from "../lib/fs.ts";
import { applyFolder, createFolder, FolderServiceError, RESERVED_FOLDER_NAMES } from "../lib/folders-service.ts";
import { buildFolderPlan, buildFolderPlanFor } from "../lib/plan.ts";
import type { HostRegistry } from "../registry.ts";
import { describeCron } from "./cron.ts";
import { NAME_RE, parseJobForm, type FormBody } from "./form.ts";
import { html } from "./html.ts";
import { page } from "./layout.ts";
import {
  hostRowFragment,
  jobDetailPage,
  jobsListPage,
  loginPage,
  nameCheck,
  newJobPage,
  notFoundPage,
} from "./pages.ts";
import {
  applyResultView,
  blockedPanel,
  datalist,
  errorPanel,
  hostStateStrip,
  planUnavailable,
  planView,
  warnPanel,
  yamlPane,
  type HistoryRow,
  type HostFolderState,
} from "./render.ts";

const SESSION_COOKIE = "sc_auth";
const require_ = createRequire(import.meta.url);

export interface UiDeps {
  cfg: ApiConfig;
  registry: HostRegistry;
  db: Db;
  rclone: RcloneClient | null;
}

export function uiRouter({ cfg, registry, db, rclone }: UiDeps): Router {
  const r = Router();
  r.use(express.urlencoded({ extended: false, limit: "256kb" }));

  /* ---------- public: assets + login ---------- */

  r.get("/assets/htmx.min.js", (_req, res) => {
    res.sendFile(require_.resolve("htmx.org/dist/htmx.min.js"), {
      maxAge: "1d",
      headers: { "content-type": "text/javascript; charset=utf-8" },
    });
  });

  r.get("/login", (req, res) => {
    if (hasSession(req, cfg.apiToken)) {
      res.redirect(303, "/ui/jobs");
      return;
    }
    res.type("html").send(loginPage());
  });

  r.post("/login", (req, res) => {
    const token = str(req.body as FormBody, "token");
    if (!safeEqual(token, cfg.apiToken)) {
      res.status(401).type("html").send(loginPage("Token doesn't match. Check SC_API_TOKEN on the server."));
      return;
    }
    res.append("Set-Cookie", sessionCookie(token, isSecure(req)));
    res.redirect(303, "/ui/jobs");
  });

  r.post("/logout", (req, res) => {
    res.append("Set-Cookie", clearSessionCookie(isSecure(req)));
    res.redirect(303, "/ui/login");
  });

  /* ---------- session gate ---------- */

  r.use((req, res, next) => {
    if (hasSession(req, cfg.apiToken)) {
      next();
      return;
    }
    if (req.get("HX-Request")) {
      res.set("HX-Redirect", "/ui/login").status(401).send("");
      return;
    }
    res.redirect(303, "/ui/login");
  });

  r.get("/", (_req, res) => res.redirect("/ui/jobs"));

  /* ---------- jobs list ---------- */

  r.get("/jobs", (_req, res) => {
    const manifests = listFolderManifests(cfg.foldersDir);
    const last = new Map<string, { ts: string; result: string }>();
    const rows = db
      .query(
        `SELECT target_name AS name, MAX(ts) AS ts, result FROM apply_history
         WHERE target_kind = 'folder' GROUP BY target_name`,
      )
      .all() as Array<{ name: string; ts: string; result: string }>;
    for (const row of rows) last.set(row.name, { ts: row.ts, result: row.result });
    res
      .type("html")
      .send(jobsListPage(manifests.map((m) => ({ manifest: m, lastApply: last.get(m.name) })), registry.rcloneNames()));
  });

  /* ---------- new job (must precede /jobs/:name) ---------- */

  r.get("/jobs/new", (_req, res) => {
    const hostNames = listYamlNames(cfg.hostsDir);
    res.type("html").send(newJobPage(listYamlNames(cfg.rulesDir), hostNames, registry.rcloneNames(hostNames)));
  });

  /* ---------- fragments ---------- */

  r.get("/frag/host-row", (_req, res) => {
    res.type("html").send(hostRowFragment(listYamlNames(cfg.hostsDir), randomUUID().slice(0, 8)).html);
  });

  const DL_RE = /^[a-z0-9-]{1,40}$/i;
  // rclone remote names only — reject connection-string syntax (":local",
  // ":sftp,host=…:") that would let browse-remote enumerate the rcd host's FS.
  const REMOTE_NAME_RE = /^[A-Za-z0-9_.-]+$/;

  // Directory completions on a member — Syncthing /rest/system/browse for
  // devices, rclone lsjson inside the remote for rclone members.
  r.get("/frag/browse-host", async (req, res) => {
    const host = qstr(req, "host");
    const path = qstr(req, "path");
    const dl = qstr(req, "pdl");
    if (!DL_RE.test(dl)) {
      res.status(400).type("html").send(errorPanel(["bad datalist id"]).html);
      return;
    }
    let dirs: string[] = [];
    if (host) {
      if (registry.isRclone(host)) {
        const remote = (registry.manifest(host)?.remote ?? "").replace(/:+$/, "");
        if (rclone && remote && REMOTE_NAME_RE.test(remote)) {
          const slash = path.lastIndexOf("/");
          const parent = slash === -1 ? "" : path.slice(0, slash);
          const frag = slash === -1 ? path : path.slice(slash + 1);
          try {
            const out = await rclone.listDirs(`${remote}:`, parent);
            dirs = (out.list ?? [])
              .filter((e) => e.IsDir && (frag === "" || e.Name.toLowerCase().startsWith(frag.toLowerCase())))
              .map((e) => e.Path)
              .slice(0, 30);
          } catch {
            // Remote missing / rcd offline — no suggestions.
          }
        }
      } else {
        try {
          // Empty field → browse the filesystem root so volumes/top-level shares
          // show up as starting points ("/share/…" on QNAP, "/Users/…" on macOS).
          // Cap generously — QNAP's /share alone has ~45 entries (HD*_DATA stubs).
          dirs = (await registry.client(host).browse(path || "/")).slice(0, 80);
        } catch {
          // Host offline / no key — typing still works, just no suggestions.
        }
      }
    }
    res.type("html").send(datalist(dl, dirs).html);
  });

  // Plain-English readout for the bisync cron expression.
  r.post("/frag/cron-hint", (req, res) => {
    const expr = str(req.body as FormBody, "bisync_schedule");
    if (!expr) {
      res.type("html").send(html`<span id="cron-hint" class="name-check"></span>`.html);
      return;
    }
    const d = describeCron(expr);
    res
      .type("html")
      .send(html`<span id="cron-hint" class="name-check ${d.ok ? "ok" : "bad"}">${d.ok ? `↻ ${d.text}` : d.text}</span>`.html);
  });

  r.post("/frag/validate-name", (req, res) => {
    const name = str(req.body as FormBody, "name");
    if (!name) {
      res.type("html").send(nameCheck("empty", "").html);
      return;
    }
    if (!NAME_RE.test(name)) {
      res.type("html").send(nameCheck("bad", "lowercase letters, digits, hyphens — start with a letter").html);
      return;
    }
    if (RESERVED_FOLDER_NAMES.has(name)) {
      res.type("html").send(nameCheck("bad", `'${name}' is a reserved name — pick another`).html);
      return;
    }
    if (existsSync(join(cfg.foldersDir, `${name}.yaml`))) {
      res.type("html").send(nameCheck("bad", `folders/${name}.yaml already exists`).html);
      return;
    }
    res.type("html").send(nameCheck("ok", `✓ will write folders/${name}.yaml`).html);
  });

  r.post("/frag/preview", (req, res) => {
    const parsed = parseJobForm(req.body as FormBody, registry.rcloneNames());
    const errors = [...parsed.errors, ...repoChecks(cfg, parsed.manifest, { checkName: true })];
    if (errors.length === 0) {
      const v = validateFolderManifest(parsed.manifest);
      if (!v.ok) errors.push(v.errors);
    }
    const yaml = canonicalEmit(parsed.manifest, FOLDER_KEY_ORDER);
    const body = html`
${errors.length > 0 ? errorPanel(errors, "Fix before creating") : ""}
${parsed.warnings.length > 0 ? warnPanel(parsed.warnings) : ""}
${yamlPane(parsed.manifest.name, yaml)}`;
    res.type("html").send(body.html);
  });

  r.post("/frag/preview-plan", (req, res) => {
    const parsed = parseJobForm(req.body as FormBody, registry.rcloneNames());
    const errors = [...parsed.errors, ...repoChecks(cfg, parsed.manifest, { checkName: false })];
    if (errors.length > 0) {
      res.status(422).type("html").send(errorPanel(errors, "Fix the form before planning").html);
      return;
    }
    try {
      const plan = buildFolderPlanFor(cfg, parsed.manifest);
      res.type("html").send(planView(plan).html);
    } catch (err) {
      res.type("html").send(planUnavailable(err).html);
    }
  });

  /* ---------- create ---------- */

  r.post("/jobs", (req, res) => {
    const parsed = parseJobForm(req.body as FormBody, registry.rcloneNames());
    if (parsed.errors.length > 0) {
      res.status(422).type("html").send(errorPanel(parsed.errors, "Fix before creating").html);
      return;
    }
    try {
      const created = createFolder(cfg, parsed.manifest);
      res
        .set("HX-Redirect", `/ui/jobs/${created.manifest.name}`)
        .type("html")
        .send(html`<div class="panel panel-ok"><h3>Created</h3><p>Wrote <code>${created.relPath}</code> — opening the job page…</p></div>`.html);
    } catch (err) {
      if (err instanceof FolderServiceError) {
        res
          .status(err.code === "NAME_TAKEN" ? 409 : 422)
          .type("html")
          .send(errorPanel([err.message], "Can't create yet").html);
        return;
      }
      throw err;
    }
  });

  /* ---------- job detail + actions ---------- */

  r.get("/jobs/:name", (req, res) => {
    const name = req.params.name;
    if (!NAME_RE.test(name)) {
      res.status(404).type("html").send(notFoundPage(`'${name}' isn't a valid job name.`));
      return;
    }
    const manifest = parseFolderByName(cfg.foldersDir, name);
    if (!manifest) {
      res.status(404).type("html").send(notFoundPage(`No sync job named '${name}'. It may have been removed.`));
      return;
    }
    let yaml: string;
    try {
      yaml = readFileSync(join(cfg.foldersDir, `${name}.yaml`), "utf8");
    } catch {
      res.status(404).type("html").send(notFoundPage(`No sync job named '${name}'. It may have been removed.`));
      return;
    }
    const history = db
      .query(
        `SELECT ts, actor, source, result, note FROM apply_history
         WHERE target_kind = 'folder' AND target_name = ? ORDER BY id DESC LIMIT 8`,
      )
      .all(name) as HistoryRow[];
    res.type("html").send(jobDetailPage(name, manifest, yaml, history, registry.rcloneNames()));
  });

  r.get("/jobs/:name/state", async (req, res) => {
    const manifest = guardManifest(cfg, req, res);
    if (!manifest) return;
    const states: HostFolderState[] = await Promise.all(
      Object.keys(manifest.paths).map(async (host) => {
        if (registry.isRclone(host)) return { host, ok: true, rclone: true };
        try {
          const status = await registry.client(host).getFolderStatus(manifest.name);
          return { host, ok: true, state: status.state, needBytes: status.needBytes };
        } catch (err) {
          return { host, ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    res.type("html").send(hostStateStrip(states).html);
  });

  r.post("/jobs/:name/plan", (req, res) => {
    const manifest = guardManifest(cfg, req, res);
    if (!manifest) return;
    try {
      const plan = buildFolderPlan(cfg, req.params.name);
      res.type("html").send(planView(plan).html);
    } catch (err) {
      res.type("html").send(planUnavailable(err).html);
    }
  });

  r.post("/jobs/:name/apply", async (req, res) => {
    const manifest = guardManifest(cfg, req, res);
    if (!manifest) return;
    const body = req.body as FormBody;
    const dryRun = str(body, "dry_run") === "on";
    const prune = str(body, "prune") === "on";
    const force = str(body, "force") === "on";
    const armed = str(body, "arm") === "on";
    if (!dryRun && !armed) {
      res
        .status(422)
        .type("html")
        .send(errorPanel(["Arm real apply before applying without dry run — or keep Dry run checked."], "Not armed").html);
      return;
    }
    try {
      const outcome = await applyFolder(cfg, db, req.params.name, {
        dryRun,
        prune,
        force,
        actor: "ui-session",
        source: "ui",
      });
      if (outcome.kind === "blocked") {
        res.status(409).type("html").send(blockedPanel(outcome.code, outcome.details).html);
        return;
      }
      res.type("html").send(applyResultView(outcome.result, outcome.delta, dryRun).html);
    } catch (err) {
      if (err instanceof CompileError || err instanceof PlanError || err instanceof FolderServiceError) {
        res.status(422).type("html").send(errorPanel([err.message], "Apply failed").html);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).type("html").send(errorPanel([message], "Apply failed").html);
    }
  });

  /* ---------- 404 + errors ---------- */

  r.use((req, res) => {
    if (req.get("HX-Request")) {
      res.status(404).type("html").send(errorPanel(["Not found."]).html);
      return;
    }
    res.status(404).type("html").send(notFoundPage("Nothing at this address."));
  });

  r.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const message = err instanceof Error ? err.message : "internal error";
    const fragment = errorPanel([message], "Something broke");
    if (req.get("HX-Request")) {
      res.status(500).type("html").send(fragment.html);
      return;
    }
    res.status(500).type("html").send(page({ title: "Error", body: fragment }));
  });

  return r;
}

/* ---------- helpers ---------- */

function str(body: FormBody, key: string): string {
  const v = body?.[key];
  if (Array.isArray(v)) return String(v[0] ?? "").trim();
  return v === undefined || v === null ? "" : String(v).trim();
}

/** First value of a query-string param, trimmed. */
function qstr(req: Request, key: string): string {
  const v = req.query[key];
  if (Array.isArray(v)) return String(v[0] ?? "").trim();
  return v === undefined ? "" : String(v).trim();
}

function safeEqual(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function hasSession(req: Request, token: string): boolean {
  const cookie = getCookie(req, SESSION_COOKIE);
  return cookie !== undefined && safeEqual(cookie, token);
}

function isSecure(req: Request): boolean {
  return req.secure || req.get("x-forwarded-proto") === "https";
}

function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/ui; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? "; Secure" : ""}`;
}

function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/ui; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

/** Resolve :name → manifest, or answer 404 (page or fragment) and return undefined. */
function guardManifest(cfg: ApiConfig, req: Request, res: Response) {
  const name = req.params.name ?? "";
  if (!NAME_RE.test(name)) {
    res.status(404).type("html").send(errorPanel([`'${name}' isn't a valid job name.`]).html);
    return undefined;
  }
  const manifest = parseFolderByName(cfg.foldersDir, name);
  if (!manifest) {
    res.status(404).type("html").send(errorPanel([`No sync job named '${name}'.`]).html);
    return undefined;
  }
  return manifest;
}

/** Config-repo coherence checks shared by preview and planning. */
function repoChecks(
  cfg: ApiConfig,
  manifest: { name: string; ruleset: string; paths: Record<string, string> },
  opts: { checkName: boolean },
): string[] {
  const errors: string[] = [];
  if (manifest.ruleset && !existsSync(join(cfg.rulesDir, `${manifest.ruleset}.yaml`))) {
    errors.push(`Ruleset '${manifest.ruleset}' not found in rules/.`);
  }
  const known = listYamlNames(cfg.hostsDir);
  for (const host of Object.keys(manifest.paths)) {
    if (!known.includes(host)) errors.push(`Unknown host '${host}' — known hosts: ${known.join(", ")}.`);
  }
  if (
    opts.checkName &&
    manifest.name &&
    NAME_RE.test(manifest.name) &&
    existsSync(join(cfg.foldersDir, `${manifest.name}.yaml`))
  ) {
    errors.push(`Name '${manifest.name}' is taken — folders/${manifest.name}.yaml already exists.`);
  }
  return errors;
}
