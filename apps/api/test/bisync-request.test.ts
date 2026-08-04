import { describe, expect, it } from "bun:test";
import { RcloneClient } from "@synccenter/adapters";
import { planBisyncFlags } from "../src/lib/bisync-flags.ts";

/**
 * Locks the on-demand request body to the one verified by hand against the
 * live rcd and the real Google Drive remote (dry run, 3m49s, 76 changes
 * detected, ZERO "Modtime not equal" aborts).
 *
 * The mechanics were proven out-of-band because the rcd sits on a container
 * network this test cannot reach. What can be checked here is the part that
 * would silently rot: that the code still generates exactly that call.
 */
describe("the on-demand bisync request", () => {
  /** baruchrio's real manifest flags. */
  const FLAGS = [
    "--resilient",
    "--recover",
    "--max-lock=2m",
    "--compare=size,modtime",
    "--modify-window=1s",
  ];

  const capture = async (extra: Record<string, unknown>) => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ jobid: 1 }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new RcloneClient({ baseUrl: "http://rcd:5572", fetch: fetchImpl });
    await client.bisync({
      path1: "/share/BaruchRio",
      path2: "gdrive-baruchriollc:/",
      filtersFile: "/config/filters/baruchrio-share.rclone",
      statsGroup: "sc/bisync/baruchrio/abcd1234",
      async: true,
      dryRun: true,
      extra,
    });
    return body;
  };

  it("matches the call proven against real Drive", async () => {
    const plan = planBisyncFlags(FLAGS);
    const body = await capture({
      ...plan.params,
      ...(Object.keys(plan.config).length > 0 ? { _config: plan.config } : {}),
    });

    expect(body).toEqual({
      path1: "/share/BaruchRio",
      path2: "gdrive-baruchriollc:/",
      filtersFile: "/config/filters/baruchrio-share.rclone",
      _group: "sc/bisync/baruchrio/abcd1234",
      _async: true,
      dryRun: true,
      resilient: true,
      recover: true,
      maxLock: "2m",
      compare: "size,modtime",
      _config: { ModifyWindow: "1s" },
    });
  });

  it("never omits the filter, which is what stops an unfiltered sync", async () => {
    const body = await capture({});
    // rclone aborts on a filters file it cannot open, but omitting the
    // parameter entirely makes it sync everything — secrets included.
    expect(body.filtersFile).toBe("/config/filters/baruchrio-share.rclone");
  });
});
