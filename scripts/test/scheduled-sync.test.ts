import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("scheduled sync runner", () => {
  for (const state of ["done", "partial"] as const) {
    it(`reports ${state} from the tracked job and releases its lock`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "sc-scheduled-test-"));
      const calls: string[] = [];
      const server = Bun.serve({ port: 0, fetch(req) {
        const path = new URL(req.url).pathname;
        calls.push(`${req.method} ${path}`);
        if (path === "/jobs") return Response.json({ activeCount: 0 });
        if (path === "/folders/example/sync") return Response.json({ job: { id: 42 } });
        if (path === "/jobs/42") return Response.json({ job: { state } });
        return new Response("unexpected", { status: 404 });
      } });
      try {
        const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../scheduled-sync.ts"), "example"], {
          env: { ...process.env, PORT: String(server.port), SC_API_TOKEN: "test-only", SC_DB_PATH: join(dir, "state.db") },
          stdout: "pipe", stderr: "pipe",
        });
        expect(await proc.exited).toBe(state === "done" ? 0 : 1);
        const output = await new Response(proc.stdout).text();
        expect(output).toContain(`"state":"${state}"`);
        expect(calls).toEqual(["GET /jobs", "POST /folders/example/sync", "GET /jobs/42"]);
        expect(existsSync(join(dir, "scheduled-sync.lock"))).toBe(false);
      } finally { server.stop(true); rmSync(dir, { recursive: true, force: true }); }
    });
  }
});
