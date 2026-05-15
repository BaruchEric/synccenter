import type { AdapterPool, ApplyOpts, ApplyPlan, ApplyResult, HostApplyResult, HostName, SyncthingOp } from "./types.ts";

export async function apply(p: ApplyPlan, pool: AdapterPool, opts: ApplyOpts): Promise<ApplyResult> {
  const hosts: HostApplyResult[] = [];

  for (const host of Object.keys(p.perHost) as HostName[]) {
    const ops = p.perHost[host]!;
    if (opts.dryRun) {
      hosts.push({ host, status: "skipped", ops });
      continue;
    }
    try {
      await executeOps(host, ops, pool);
      hosts.push({ host, status: "applied", ops });
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      hosts.push({
        host,
        status: "failed",
        ops,
        error: { code: classify(err), message },
      });
    }
  }

  return {
    folder: p.folder,
    hosts,
    schedule: p.schedule,
    verified: false,
  };
}

async function executeOps(host: HostName, ops: SyncthingOp[], pool: AdapterPool): Promise<void> {
  const client = pool.syncthing(host);
  for (const op of ops) {
    switch (op.kind) {
      case "addDevice":
        await retry(() => client.addDevice({ deviceID: op.deviceID, name: op.name, addresses: op.addresses ?? ["dynamic"] }));
        break;
      case "addFolder":
        await retry(() => client.addFolder(op.folder));
        break;
      case "patchFolder":
        await retry(() => client.patchFolder(op.folderId, op.patch));
        break;
      case "setIgnores":
        await retry(() => client.setIgnores(op.folderId, op.lines));
        break;
      case "removeFolder":
        await retry(() => client.removeFolder(op.folderId));
        break;
    }
  }
}

async function retry<T>(fn: () => Promise<T>): Promise<T> {
  const delays = [500, 1000, 2000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number }).status;
      if (status && status >= 400 && status < 500) throw err; // no retry on 4xx
      if (attempt < delays.length) await sleep(delays[attempt]!);
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function classify(err: unknown): string {
  const status = (err as { status?: number }).status;
  if (typeof status === "number") {
    if (status >= 500) return "ADAPTER_5XX";
    if (status >= 400) return "ADAPTER_4XX";
  }
  const msg = (err as Error).message ?? "";
  if (msg.includes("timed out")) return "ADAPTER_TIMEOUT";
  if (msg.includes("network") || msg.includes("ECONN")) return "HOST_UNREACHABLE";
  return "ADAPTER_5XX";
}
