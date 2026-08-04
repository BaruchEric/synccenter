#!/usr/bin/env bun
// fake-rcd.mjs — a stand-in for the rclone rcd, so the live-progress UI can be
// driven locally without touching real data.
//
//   bun .claude/skills/run-synccenter/fake-rcd.mjs [--port 5572] [--fast]
//
// Then point the API at it:  SC_RCLONE_URL=http://localhost:5572
// (the driver's `up --fake-rclone` does this for you).
//
// It implements only the slice SyncCenter calls, and it reproduces the two
// behaviours that make bisync progress awkward to build against:
//
//   1. a long listing phase where `totalBytes` is 0 while `checks`/`listed`
//      climb — the real thing spends minutes here on a large folder;
//   2. stats that live under the caller's `_group`, NOT under `job/<jobid>`
//      (verified against rclone 1.75 — see the run-tracker notes).
//
// The real rcd finishes a small bisync in under a second, which is useless for
// building a progress meter. This one takes ~35s by default, ~7s with --fast.

const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf("--port") + 1]) || 5572;
const FAST = args.includes("--fast");
const SCALE = FAST ? 0.2 : 1;

const CHECK_MS = 12_000 * SCALE; // listing phase
const XFER_MS = 23_000 * SCALE; // transferring phase
const TOTAL_BYTES = 7_314_255_872; // ~6.8 GiB, so the readout has real numbers
const TOTAL_CHECKS = 18_450;

/** jobid → job */
const jobs = new Map();
let nextId = 1;

const FILES = [
  "Music/Talk Talk/Laughing Stock/03 After the Flood.flac",
  "notes/2026-Q3/mesh-policy.md",
  "dev/homelab/services/synccenter/apps/web/src/routes/Activity.tsx",
  "photos/2026-07-14/DSC_4471.ARW",
  "Music/Miles Davis/In a Silent Way/01 Shhh-Peaceful.flac",
];

function statsFor(job) {
  const now = Date.now();
  const elapsed = (now - job.started) / 1000;
  if (job.stopped) return { ...zero(), elapsedTime: elapsed, checks: job.lastChecks };

  const t = now - job.started;
  if (t < CHECK_MS) {
    // Listing: no denominator yet. This is the phase a naive bar renders as 0%.
    const p = t / CHECK_MS;
    job.lastChecks = Math.floor(TOTAL_CHECKS * p);
    return {
      ...zero(),
      elapsedTime: elapsed,
      checks: job.lastChecks,
      listed: Math.floor(TOTAL_CHECKS * 1.4 * p),
    };
  }

  const p = Math.min(1, (t - CHECK_MS) / XFER_MS);
  const bytes = Math.floor(TOTAL_BYTES * p);
  const speed = (TOTAL_BYTES / XFER_MS) * 1000;
  const remaining = Math.max(0, Math.round(((1 - p) * XFER_MS) / 1000));
  return {
    ...zero(),
    bytes,
    totalBytes: TOTAL_BYTES,
    elapsedTime: elapsed,
    checks: TOTAL_CHECKS,
    listed: Math.floor(TOTAL_CHECKS * 1.4),
    transfers: Math.floor(42 * p),
    totalTransfers: 42,
    speed,
    eta: p >= 1 ? 0 : remaining,
    transferring:
      p >= 1
        ? []
        : [
            {
              name: FILES[Math.floor(p * FILES.length) % FILES.length],
              size: 148_000_000,
              bytes: Math.floor(148_000_000 * ((p * 7) % 1)),
              speed,
            },
          ],
  };
}

const zero = () => ({
  bytes: 0,
  checks: 0,
  deletes: 0,
  elapsedTime: 0,
  errors: 0,
  eta: null,
  fatalError: false,
  listed: 0,
  speed: 0,
  totalBytes: 0,
  totalChecks: 0,
  totalTransfers: 0,
  transfers: 0,
  transferring: [],
});

const done = (job) => job.stopped || Date.now() - job.started >= CHECK_MS + XFER_MS;

const handlers = {
  "core/version": () => ({ version: "v1.75.0-fake", os: "darwin", arch: "arm64", goVersion: "go1.24" }),
  "core/pid": () => ({ pid: process.pid }),
  "config/listremotes": () => ({ remotes: ["gdrive", "gdrive-arik", "gdrive-baruchriollc"] }),

  "sync/bisync": (body) => {
    const id = nextId++;
    const job = {
      id,
      started: Date.now(),
      group: body._group ?? `job/${id}`,
      stopped: false,
      lastChecks: 0,
      path1: body.path1,
      path2: body.path2,
      dryRun: !!body.dryRun,
    };
    jobs.set(id, job);
    if (!body._async) {
      return { path1: job.path1, path2: job.path2, note: "fake sync bisync completed" };
    }
    return { jobid: id };
  },

  "job/status": (body) => {
    const job = jobs.get(Number(body.jobid));
    if (!job) throw new Error(`job not found: ${body.jobid}`);
    const finished = done(job);
    return {
      id: job.id,
      group: job.group,
      startTime: new Date(job.started).toISOString(),
      ...(finished ? { endTime: new Date().toISOString() } : {}),
      duration: (Date.now() - job.started) / 1000,
      finished,
      success: finished && !job.stopped,
      ...(job.stopped ? { error: "context canceled" } : {}),
    };
  },

  "job/stop": (body) => {
    const job = jobs.get(Number(body.jobid));
    if (!job) throw new Error(`job not found: ${body.jobid}`);
    job.stopped = true;
    return {};
  },

  "core/stats": (body) => {
    // Group-scoped, exactly like the real thing: ask for job/<id> and you get
    // zeros, which is the trap this simulator exists to reproduce.
    if (!body.group) return zero();
    const job = [...jobs.values()].find((j) => j.group === body.group);
    if (!job) return zero();
    return statsFor(job);
  },

  "core/group-list": () => ({ groups: [...jobs.values()].map((j) => j.group) }),
};

Bun.serve({
  port: PORT,
  async fetch(req) {
    const path = new URL(req.url).pathname.replace(/^\//, "");
    const fn = handlers[path];
    if (!fn) return json({ error: `unknown endpoint: ${path}` }, 404);
    let body = {};
    try {
      body = await req.json();
    } catch {
      /* empty body is fine */
    }
    try {
      return json(fn(body));
    } catch (err) {
      return json({ error: err.message, path }, 500);
    }
  },
});

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

console.log(`fake rcd on :${PORT} — bisync takes ~${Math.round((CHECK_MS + XFER_MS) / 1000)}s`);
console.log(`  ${Math.round(CHECK_MS / 1000)}s checking (totalBytes 0) then ${Math.round(XFER_MS / 1000)}s transferring`);
