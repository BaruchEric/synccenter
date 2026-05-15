import { describe, expect, it } from "bun:test";
import { RcloneClient, RcloneError } from "../src/rclone/index.ts";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

interface FetchSetup {
  status?: number;
  statusText?: string;
  body?: unknown;
  contentType?: string;
  throwError?: Error;
}

function makeFetch(setup: FetchSetup = {}) {
  const calls: RecordedCall[] = [];
  const impl = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    }
    calls.push({
      url,
      method,
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (setup.throwError) throw setup.throwError;
    const status = setup.status ?? 200;
    const bodyText =
      typeof setup.body === "string"
        ? setup.body
        : setup.body !== undefined
          ? JSON.stringify(setup.body)
          : "{}";
    return new Response(bodyText, {
      status,
      statusText: setup.statusText ?? "OK",
      headers: { "Content-Type": setup.contentType ?? "application/json" },
    });
  };
  return { impl: impl as typeof fetch, calls };
}

function client(opts: Partial<ConstructorParameters<typeof RcloneClient>[0]> = {}, setup?: FetchSetup) {
  const f = makeFetch(setup);
  return {
    client: new RcloneClient({
      baseUrl: "http://rcd.local:5572",
      username: "u",
      password: "p",
      fetch: f.impl,
      ...opts,
    }),
    calls: f.calls,
  };
}

describe("RcloneClient request shape", () => {
  it("always POSTs JSON, even for queries without args", async () => {
    const { client: c, calls } = client({}, { body: { pid: 123 } });
    await c.ping();
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("http://rcd.local:5572/core/pid");
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(calls[0]!.body).toBe("{}");
  });

  it("sends Basic auth when username/password set", async () => {
    const { client: c, calls } = client({}, { body: {} });
    await c.ping();
    const expected = `Basic ${Buffer.from("u:p", "utf8").toString("base64")}`;
    expect(calls[0]!.headers["authorization"]).toBe(expected);
  });

  it("sends Bearer auth when bearerToken set (overriding basic)", async () => {
    const { client: c, calls } = client(
      { username: undefined, password: undefined, bearerToken: "tok-123" },
      { body: {} },
    );
    await c.ping();
    expect(calls[0]!.headers["authorization"]).toBe("Bearer tok-123");
  });

  it("omits auth header when no credentials provided", async () => {
    const { client: c, calls } = client(
      { username: undefined, password: undefined },
      { body: {} },
    );
    await c.ping();
    expect(calls[0]!.headers["authorization"]).toBeUndefined();
  });

  it("strips trailing slashes from baseUrl", async () => {
    const f = makeFetch({ body: { version: "v1" } });
    const c = new RcloneClient({ baseUrl: "http://rcd.local:5572/", fetch: f.impl });
    await c.getVersion();
    expect(f.calls[0]!.url).toBe("http://rcd.local:5572/core/version");
  });
});

describe("read endpoints", () => {
  it("getVersion returns parsed body", async () => {
    const { client: c } = client(
      {},
      { body: { version: "v1.69.0", goVersion: "go1.22", os: "linux", arch: "amd64" } },
    );
    const v = await c.getVersion();
    expect(v.version).toBe("v1.69.0");
  });

  it("listRemotes returns parsed body", async () => {
    const { client: c } = client({}, { body: { remotes: ["gdrive", "b2"] } });
    const r = await c.listRemotes();
    expect(r.remotes).toEqual(["gdrive", "b2"]);
  });

  it("getStats sends group param when provided", async () => {
    const { client: c, calls } = client({}, { body: { bytes: 0, checks: 0, elapsedTime: 0, errors: 0 } });
    await c.getStats("bisync-folder-x");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ group: "bisync-folder-x" });
  });

  it("about sends fs argument", async () => {
    const { client: c, calls } = client({}, { body: { total: 100, used: 30, free: 70 } });
    const a = await c.about("gdrive:");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ fs: "gdrive:" });
    expect(a.free).toBe(70);
  });

  it("jobStatus sends jobid", async () => {
    const { client: c, calls } = client(
      {},
      {
        body: {
          id: 42,
          startTime: "2026-05-14T00:00:00Z",
          duration: 1,
          finished: true,
          success: true,
        },
      },
    );
    const s = await c.jobStatus(42);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ jobid: 42 });
    expect(s.success).toBe(true);
  });
});

describe("bisync", () => {
  it("serializes convenience fields with rclone's expected key names", async () => {
    const { client: c, calls } = client({}, { body: { jobid: 7 } });
    const out = await c.bisync({
      path1: "/share/Sync/code",
      path2: "gdrive:sync/code",
      async: true,
      resilient: true,
      conflictResolve: "newer",
      compare: "size,modtime,checksum",
      filtersFile: "/share/synccenter-config/compiled/code/filter.rclone",
      maxLock: "2m",
    });
    expect(out.jobid).toBe(7);
    const body = JSON.parse(calls[0]!.body!);
    expect(body).toEqual({
      path1: "/share/Sync/code",
      path2: "gdrive:sync/code",
      _async: true,
      resilient: true,
      conflictResolve: "newer",
      compare: "size,modtime,checksum",
      filtersFile: "/share/synccenter-config/compiled/code/filter.rclone",
      maxLock: "2m",
    });
  });

  it("merges extra:{} for fields not covered by convenience props", async () => {
    const { client: c, calls } = client({}, { body: {} });
    await c.bisync({
      path1: "/p1",
      path2: "rem:p2",
      extra: { checkAccess: true, maxDelete: 25 },
    });
    const body = JSON.parse(calls[0]!.body!);
    expect(body.checkAccess).toBe(true);
    expect(body.maxDelete).toBe(25);
  });

  it("omits optional fields when undefined (no implicit defaults sent)", async () => {
    const { client: c, calls } = client({}, { body: {} });
    await c.bisync({ path1: "/a", path2: "r:b" });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ path1: "/a", path2: "r:b" });
  });
});

describe("error handling", () => {
  it("wraps 4xx with the upstream error message", async () => {
    const { client: c } = client(
      {},
      {
        status: 400,
        statusText: "Bad Request",
        body: { error: "didn't find a bisync workdir", input: { path1: "x" }, path: "sync/bisync", status: 400 },
      },
    );
    let err: unknown;
    try {
      await c.bisync({ path1: "x", path2: "r:y" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RcloneError);
    const re = err as RcloneError;
    expect(re.status).toBe(400);
    expect(re.endpoint).toBe("sync/bisync");
    expect(re.upstream?.input).toEqual({ path1: "x" });
    expect(re.message).toContain("didn't find a bisync workdir");
  });

  it("wraps network errors with the endpoint name", async () => {
    const { client: c } = client({}, { throwError: new Error("ECONNREFUSED") });
    let err: unknown;
    try {
      await c.getVersion();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RcloneError);
    expect((err as RcloneError).message).toContain("core/version");
    expect((err as RcloneError).message).toContain("ECONNREFUSED");
    expect((err as RcloneError).status).toBeNull();
  });
});
