import { describe, expect, it } from "bun:test";
import { SyncthingClient, SyncthingError } from "../src/syncthing/index.ts";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

interface FetchSetup {
  status?: number;
  statusText?: string;
  body?: unknown; // serialized as JSON if object, used verbatim if string
  contentType?: string;
  delayMs?: number;
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
    if (setup.delayMs) await new Promise((r) => setTimeout(r, setup.delayMs));
    if (setup.throwError) throw setup.throwError;
    if (init?.signal?.aborted) {
      const err: Error & { name: string } = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    const status = setup.status ?? 200;
    const bodyText =
      typeof setup.body === "string"
        ? setup.body
        : setup.body !== undefined
          ? JSON.stringify(setup.body)
          : "";
    return new Response(bodyText, {
      status,
      statusText: setup.statusText ?? "OK",
      headers: { "Content-Type": setup.contentType ?? "application/json" },
    });
  };
  return { impl: impl as typeof fetch, calls };
}

function client(setup?: FetchSetup) {
  const f = makeFetch(setup);
  return {
    client: new SyncthingClient({
      baseUrl: "http://st.local:8384",
      apiKey: "test-key",
      fetch: f.impl,
      timeoutMs: 200,
    }),
    calls: f.calls,
  };
}

describe("SyncthingClient request shape", () => {
  it("sends X-API-Key on every request", async () => {
    const { client: c, calls } = client({ body: { ping: "pong" } });
    await c.ping();
    expect(calls[0]!.headers["x-api-key"]).toBe("test-key");
    expect(calls[0]!.url).toBe("http://st.local:8384/rest/system/ping");
  });

  it("strips trailing slashes from baseUrl", async () => {
    const f = makeFetch({ body: { ping: "pong" } });
    const c = new SyncthingClient({
      baseUrl: "http://st.local:8384/",
      apiKey: "k",
      fetch: f.impl,
    });
    await c.ping();
    expect(f.calls[0]!.url).toBe("http://st.local:8384/rest/system/ping");
  });

  it("URL-encodes the folder id in path and query", async () => {
    const { client: c, calls } = client({ body: { state: "idle" } });
    await c.getFolderStatus("my folder/with chars&stuff");
    expect(calls[0]!.url).toContain("folder=my%20folder%2Fwith%20chars%26stuff");
  });
});

describe("read endpoints", () => {
  it("parses /rest/system/version", async () => {
    const { client: c } = client({
      body: { arch: "amd64", longVersion: "v1.30.0", os: "linux", version: "v1.30.0" },
    });
    const v = await c.getVersion();
    expect(v.version).toBe("v1.30.0");
  });

  it("listFolders returns the array verbatim", async () => {
    const sample = [
      { id: "code", path: "/sync/code", type: "sendreceive" as const, devices: [], paused: false },
    ];
    const { client: c } = client({ body: sample });
    const folders = await c.listFolders();
    expect(folders).toEqual(sample);
  });

  it("getIgnores returns parsed body", async () => {
    const { client: c } = client({ body: { ignore: ["*.log"], expanded: ["*.log"] } });
    const ig = await c.getIgnores("code");
    expect(ig.ignore).toEqual(["*.log"]);
  });

  it("events passes since and timeout as query params", async () => {
    const { client: c, calls } = client({ body: [] });
    await c.events(42, 30);
    expect(calls[0]!.url).toContain("since=42");
    expect(calls[0]!.url).toContain("timeout=30");
  });
});

describe("write endpoints", () => {
  it("setIgnores POSTs JSON body with ignore[]", async () => {
    const { client: c, calls } = client({ body: { ignore: ["*.log"], expanded: ["*.log"] } });
    await c.setIgnores("code", ["*.log"]);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ ignore: ["*.log"] });
  });

  it("scan POSTs with folder + sub", async () => {
    const { client: c, calls } = client({ status: 200, body: "" });
    await c.scan("code", "subdir/path");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("folder=code");
    expect(calls[0]!.url).toContain("sub=subdir%2Fpath");
  });

  it("pauseFolder PATCHes paused:true", async () => {
    const { client: c, calls } = client({ status: 200, body: "" });
    await c.pauseFolder("code");
    expect(calls[0]!.method).toBe("PATCH");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ paused: true });
  });

  it("resumeFolder PATCHes paused:false", async () => {
    const { client: c, calls } = client({ status: 200, body: "" });
    await c.resumeFolder("code");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ paused: false });
  });

  it("addFolder POSTs the full folder object", async () => {
    const { client: c, calls } = client({ status: 200, body: "" });
    await c.addFolder({
      id: "new",
      path: "/sync/new",
      type: "sendreceive",
      devices: [{ deviceID: "ABC" }],
    });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("http://st.local:8384/rest/config/folders");
    const sent = JSON.parse(calls[0]!.body!);
    expect(sent.id).toBe("new");
    expect(sent.devices[0].deviceID).toBe("ABC");
  });
});

describe("error handling", () => {
  it("throws SyncthingError with status on 4xx", async () => {
    const { client: c } = client({ status: 403, statusText: "Forbidden", body: "bad key" });
    let err: unknown;
    try {
      await c.getVersion();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SyncthingError);
    const sterr = err as SyncthingError;
    expect(sterr.status).toBe(403);
    expect(sterr.endpoint).toBe("/rest/system/version");
    expect(sterr.message).toContain("403");
  });

  it("throws SyncthingError on invalid JSON", async () => {
    const { client: c } = client({ status: 200, body: "<html>nope</html>", contentType: "text/html" });
    let err: unknown;
    try {
      await c.getVersion();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SyncthingError);
    expect((err as SyncthingError).message).toContain("invalid JSON");
  });

  it("wraps network errors with a clear message", async () => {
    const { client: c } = client({ throwError: new Error("ECONNREFUSED") });
    let err: unknown;
    try {
      await c.ping();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SyncthingError);
    expect((err as SyncthingError).message).toContain("ECONNREFUSED");
    expect((err as SyncthingError).status).toBeNull();
  });
});
