#!/usr/bin/env bun
// driver.mjs — launch and drive SyncCenter locally.
//
//   bun .claude/skills/run-synccenter/driver.mjs up      start API (:3000) + web (:5173), wait for health
//   bun .claude/skills/run-synccenter/driver.mjs smoke   assert the endpoints a change is likely to touch
//   bun .claude/skills/run-synccenter/driver.mjs token    print the bearer token (pipe to pbcopy for the UI)
//   bun .claude/skills/run-synccenter/driver.mjs logs     tail both logs
//   bun .claude/skills/run-synccenter/driver.mjs down     stop both
//
// Everything is relative to the repo root; the driver cd's there itself, so it
// works from any cwd. Run `up` then drive the React UI in a browser, or run
// `smoke` alone for a headless check.

import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";

const REPO = resolve(import.meta.dir, "../../..");
const CONFIG_DIR = process.env.SC_CONFIG_DIR ?? join(REPO, "..", "synccenter-config");
const STATE = join(tmpdir(), "synccenter-run");
const API_PORT = process.env.SC_PORT ?? "3000";
const WEB_PORT = "5173";
// Vite binds [::1] only (see SKILL.md Gotchas) — 127.0.0.1 refuses the
// connection while `localhost` resolves to ::1 and works. Use localhost for
// BOTH so one hostname is correct everywhere.
const API = `http://localhost:${API_PORT}`;
const WEB = `http://localhost:${WEB_PORT}`;

mkdirSync(STATE, { recursive: true });
const pidFile = (n) => join(STATE, `${n}.pid`);
const logFile = (n) => join(STATE, `${n}.log`);

function die(msg) { console.error(`✗ ${msg}`); process.exit(1); }

/** Decrypt secrets/api-env.enc.yaml into a plain env object. */
function loadEnv() {
  const enc = join(CONFIG_DIR, "secrets", "api-env.enc.yaml");
  if (!existsSync(enc)) die(`missing ${enc} — is SC_CONFIG_DIR right? (${CONFIG_DIR})`);
  const ageKey = process.env.SOPS_AGE_KEY_FILE ?? join(homedir(), ".config/sops/age/keys.txt");
  if (!existsSync(ageKey)) die(`no age key at ${ageKey}; set SOPS_AGE_KEY_FILE`);
  const p = Bun.spawnSync(["sops", "-d", enc], {
    env: { ...process.env, SOPS_AGE_KEY_FILE: ageKey },
    stderr: "pipe",
  });
  if (p.exitCode !== 0) die(`sops decrypt failed: ${p.stderr.toString().slice(0, 300)}`);
  const env = {};
  for (const line of p.stdout.toString().split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*):\s*"?(.*?)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
  if (!env.SC_API_TOKEN) die("SC_API_TOKEN not found in the sealed env");
  return env;
}

function alive(name) {
  if (!existsSync(pidFile(name))) return false;
  const pid = Number(readFileSync(pidFile(name), "utf8").trim());
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Start a detached child via bash so it survives this process exiting. */
function start(name, cmd, env) {
  if (alive(name)) { console.log(`• ${name} already running`); return; }
  const log = openSync(logFile(name), "a");
  const child = Bun.spawn(["bash", "-c", cmd], {
    cwd: REPO, env: { ...process.env, ...env },
    stdout: log, stderr: log, stdin: "ignore",
  });
  writeFileSync(pidFile(name), String(child.pid));
  child.unref();
  console.log(`• ${name} pid ${child.pid} → ${logFile(name)}`);
}

async function waitFor(url, name, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.ok) { console.log(`✓ ${name} up at ${url}`); return true; }
    } catch { /* not listening yet */ }
    await Bun.sleep(500);
  }
  console.error(`✗ ${name} never became healthy at ${url}`);
  console.error(readFileSync(logFile(name === "api" ? "api" : "web"), "utf8").slice(-1500));
  return false;
}

async function up() {
  const env = loadEnv();
  // The real rcd lives on the QNAP's internal docker network and is not
  // reachable from here, so local work on live progress needs the simulator.
  const fake = process.argv.includes("--fake-rclone");
  if (fake) {
    start("rcd", `bun .claude/skills/run-synccenter/fake-rcd.mjs --port 5572`, {});
    await Bun.sleep(400);
  }
  start("api", `bun run apps/api/src/index.ts`, {
    ...(fake ? { SC_RCLONE_URL: "http://localhost:5572" } : {}),
    ...env,
    SC_CONFIG_DIR: resolve(CONFIG_DIR),
    SC_DB_PATH: join(STATE, "local.db"),
    PORT: API_PORT,
    // The API shells out to sops at request time to resolve device IDs (the
    // plan/schedule endpoints). Without this it boots fine and then 500s with
    // SOPS_DECRYPT_FAILED on the first endpoint that needs a secret.
    SOPS_AGE_KEY_FILE: process.env.SOPS_AGE_KEY_FILE ?? join(homedir(), ".config/sops/age/keys.txt"),
  });
  start("web", `cd apps/web && bun run dev`, {});
  const okApi = await waitFor(`${API}/health`, "api");
  const okWeb = await waitFor(`${WEB}/`, "web");
  if (!okApi || !okWeb) process.exit(1);
  console.log(`\n  API  ${API}      (bearer: driver.mjs token)`);
  console.log(`  UI   ${WEB}      (React dashboard; proxies /api → :${API_PORT})`);
}

async function smoke() {
  const token = loadEnv().SC_API_TOKEN;
  const auth = { Authorization: `Bearer ${token}` };
  let failed = 0;
  // `want` receives (body, status) so a check can assert a REJECTION — an
  // unauthenticated 401 is the pass condition, not a failure.
  const check = async (label, url, opts, want) => {
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(20_000) });
      const body = await r.text();
      const ok = want(body, r.status);
      console.log(`${ok ? "✓" : "✗"} ${label} → ${r.status} ${body.slice(0, 90)}`);
      if (!ok) failed++;
    } catch (e) {
      console.log(`✗ ${label} → ${e.message}`);
      failed++;
    }
  };

  await check("health (public)", `${API}/health`, {}, (b, s) => s === 200 && JSON.parse(b).ok === true);
  await check("auth is enforced (expect 401)", `${API}/folders`, {}, (_b, s) => s === 401);
  await check("folders (authed)", `${API}/folders`, { headers: auth },
    (b, s) => s === 200 && Array.isArray(JSON.parse(b).folders));
  await check("folder manifest", `${API}/folders/arik`, { headers: auth },
    (b, s) => s === 200 && b.includes("ruleset"));
  await check("hosts", `${API}/hosts`, { headers: auth }, (b, s) => s === 200 && b.length > 2);
  await check("vite serves the SPA", `${WEB}/`, {}, (b, s) => s === 200 && b.includes('<div id="root"'));
  await check("vite proxies /api → API", `${WEB}/api/health`, {}, (b, s) => s === 200 && JSON.parse(b).ok === true);

  console.log(failed === 0 ? "\nall smoke checks passed" : `\n${failed} check(s) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

function down() {
  for (const name of ["api", "web", "rcd"]) {
    if (!existsSync(pidFile(name))) { console.log(`• ${name} not tracked`); continue; }
    const pid = Number(readFileSync(pidFile(name), "utf8").trim());
    try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} }
    unlinkSync(pidFile(name));
    console.log(`• ${name} (pid ${pid}) stopped`);
  }
  // `bun run dev` execs vite as a grandchild; killing the shell can leave it.
  Bun.spawnSync(["pkill", "-f", "apps/api/src/index.ts"]);
  Bun.spawnSync(["pkill", "-f", "vite"]);
  Bun.spawnSync(["pkill", "-f", "fake-rcd.mjs"]);
}

const cmd = process.argv[2];
if (cmd === "up") await up();
else if (cmd === "smoke") await smoke();
else if (cmd === "down") down();
else if (cmd === "token") process.stdout.write(loadEnv().SC_API_TOKEN);
else if (cmd === "logs") {
  for (const n of ["api", "web"]) {
    console.log(`\n===== ${n} =====`);
    if (existsSync(logFile(n))) console.log(readFileSync(logFile(n), "utf8").split("\n").slice(-25).join("\n"));
  }
} else {
  console.log("usage: driver.mjs up | smoke | token | logs | down");
  process.exit(2);
}
