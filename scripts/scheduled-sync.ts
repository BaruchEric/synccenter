#!/usr/bin/env bun
// Run inside synccenter-api. Scheduled work uses the same tracked pipeline as
// manual sync, including mesh gating and the cloud-to-mesh return window.
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, rmdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const folder = process.argv[2];
if (!folder || !/^[a-z][a-z0-9-]*$/.test(folder)) throw new Error("usage: bun scripts/scheduled-sync.ts <folder>");
if (!process.env.SC_API_TOKEN || !process.env.SC_DB_PATH) throw new Error("run inside synccenter-api with its environment");
const lock = join(dirname(process.env.SC_DB_PATH), "scheduled-sync.lock");
const owner = join(lock, "pid");
const deadline = Date.now() + 12 * 60 * 60_000;
const sleep = () => Bun.sleep(15_000);
const log = (event: string, detail: unknown = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), folder, event, detail }));
const request = async (path: string, method = "GET") => {
  const r = await fetch(`http://127.0.0.1:${process.env.PORT ?? "3000"}${path}`, {
    method, headers: { Authorization: `Bearer ${process.env.SC_API_TOKEN}` }, signal: AbortSignal.timeout(60_000),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(data)}`);
  return data;
};

let acquired = false;
log("queued");
try {
  while (!acquired) {
    if (Date.now() > deadline) throw new Error("timed out waiting for scheduled-sync lock");
    try {
      mkdirSync(lock);
      acquired = true;
      writeFileSync(owner, String(process.pid));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // The lock belongs to a docker-exec process in this container's PID
      // namespace. Recover only when that recorded process no longer exists.
      try {
        const pid = Number(readFileSync(owner, "utf8"));
        if (!Number.isInteger(pid) || pid <= 0) throw new Error("invalid scheduled-sync lock owner");
        try { process.kill(pid, 0); }
        catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") { unlinkSync(owner); rmdirSync(lock); continue; }
          throw e;
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        // An interrupted mkdir before the owner write leaves an empty lock.
        try { if (Date.now() - statSync(lock).mtimeMs > 60_000) rmdirSync(lock); } catch { /* another waiter recovered it */ }
      }
      await sleep();
    }
  }
  // Let existing manual/recovery work finish; a running mesh-only recovery
  // job is also a reason to wait, even before its cloud leg exists.
  while ((await request("/jobs?state=running&limit=1")).activeCount > 0) {
    if (Date.now() > deadline) throw new Error("timed out waiting for active jobs");
    await sleep();
  }
  const result = await request(`/folders/${folder}/sync`, "POST");
  const id = result.job?.id;
  if (!Number.isInteger(id)) throw new Error("sync did not return a tracked job");
  log("started", { jobId: id });
  for (;;) {
    const { job } = await request(`/jobs/${id}`);
    if (job.state !== "running") {
      log("finished", { jobId: id, state: job.state, note: job.note });
      if (job.state !== "done") throw new Error(`job #${id} ended ${job.state}: ${job.note ?? "inspect job legs"}`);
      break;
    }
    if (Date.now() > deadline) throw new Error(`job #${id} still running at runner deadline; inspect it before retrying`);
    await sleep();
  }
} catch (err) {
  log("failed", { error: String(err) });
  process.exitCode = 1;
} finally {
  if (acquired) { unlinkSync(owner); rmdirSync(lock); }
}
