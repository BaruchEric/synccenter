import { describe, expect, it } from "bun:test";
import { ApiClient } from "../src/api.ts";
import { TOOLS, requireConfirm } from "../src/tools.ts";

function buildApi(handler: (req: { method: string; url: string; body: string | undefined }) => Response): ApiClient {
  const fakeFetch = (async (input: Request | string | URL, init?: RequestInit) => {
    return handler({
      method: init?.method ?? "GET",
      url: typeof input === "string" ? input : input.toString(),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
  }) as unknown as typeof fetch;
  return new ApiClient({ baseUrl: "http://fake", token: "T", fetch: fakeFetch });
}

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;

describe("tool catalog", () => {
  it("exposes the expected tools with confirm requirements", () => {
    const names = TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "sc_apply",
        "sc_compile_rules",
        "sc_folder_state",
        "sc_get_folder",
        "sc_health",
        "sc_host_status",
        "sc_list_conflicts",
        "sc_list_folders",
        "sc_list_hosts",
        "sc_pause_folder",
        "sc_rclone_job",
        "sc_recent_changes",
        "sc_resume_folder",
        "sc_trigger_bisync",
      ].sort(),
    );
    expect(tool("sc_pause_folder").mutating).toBe(true);
    expect(tool("sc_apply").mutating).toBe(true);
    expect(tool("sc_trigger_bisync").mutating).toBe(true);
    expect(tool("sc_health").mutating).toBe(false);
    expect(tool("sc_compile_rules").mutating).toBe(false);
  });
});

describe("requireConfirm guard", () => {
  it("rejects mutating tools without confirm:true", () => {
    expect(() => requireConfirm(tool("sc_pause_folder"), { folder: "x" })).toThrow(/confirm: true/);
  });

  it("allows mutating tools with confirm:true", () => {
    expect(() => requireConfirm(tool("sc_pause_folder"), { folder: "x", confirm: true })).not.toThrow();
  });

  it("allows sc_apply with dryRun:true without confirm", () => {
    expect(() => requireConfirm(tool("sc_apply"), { folder: "x", dryRun: true })).not.toThrow();
  });

  it("ignores confirm for read-only tools", () => {
    expect(() => requireConfirm(tool("sc_health"), {})).not.toThrow();
  });
});

describe("handlers (HTTP shape)", () => {
  it("sc_health hits GET /health with bearer auth", async () => {
    let seen!: { method: string; url: string };
    const api = buildApi(({ method, url }) => {
      seen = { method, url };
      return new Response(JSON.stringify({ ok: true, version: "0.0.1" }), { status: 200 });
    });
    await tool("sc_health").handler({}, api);
    expect(seen.method).toBe("GET");
    expect(seen.url).toBe("http://fake/health");
  });

  it("sc_get_folder URL-encodes the folder name", async () => {
    let seen!: { url: string };
    const api = buildApi(({ url }) => {
      seen = { url };
      return new Response("{}", { status: 200 });
    });
    await tool("sc_get_folder").handler({ folder: "my folder/with slash" }, api);
    expect(seen.url).toContain("my%20folder%2Fwith%20slash");
  });

  it("sc_compile_rules POSTs with allowDivergent flag", async () => {
    let seen!: { method: string; url: string };
    const api = buildApi(({ method, url }) => {
      seen = { method, url };
      return new Response("{}", { status: 200 });
    });
    await tool("sc_compile_rules").handler({ ruleset: "node", allowDivergent: true }, api);
    expect(seen.method).toBe("POST");
    expect(seen.url).toContain("allowDivergent=true");
  });

  it("sc_trigger_bisync passes async/dryRun/resync as query params", async () => {
    let seen!: { url: string };
    const api = buildApi(({ url }) => {
      seen = { url };
      return new Response("{}", { status: 200 });
    });
    await tool("sc_trigger_bisync").handler(
      { folder: "code", confirm: true, async: true, dryRun: false, resync: true },
      api,
    );
    expect(seen.url).toContain("async=true");
    expect(seen.url).toContain("resync=true");
    expect(seen.url).not.toContain("dryRun=true");
  });

  it("sc_apply passes through the API's error message", async () => {
    const api = buildApi(() =>
      new Response(JSON.stringify({ error: "engine divergence detected" }), { status: 400 }),
    );
    let err: unknown;
    try {
      await tool("sc_apply").handler({ folder: "code", confirm: true }, api);
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toContain("engine divergence");
  });
});
