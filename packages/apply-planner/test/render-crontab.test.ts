import { describe, it, expect } from "bun:test";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { renderCrontab } from "../src/render-crontab.ts";
import type { SchedulePlan } from "../src/types.ts";

const GOLDEN = join(import.meta.dir, "golden/crontab-example-code-projects.cron");

describe("renderCrontab", () => {
  it("renders a single bisync schedule into a stable crontab fragment", () => {
    const plans: SchedulePlan[] = [{
      anchor: "qnap-ts453d",
      folder: "example-code-projects",
      cron: "*/15 * * * *",
      filtersFile: "/share/synccenter-config/compiled/dev-monorepo/filter.rclone",
      command: 'docker exec rclone-rcd rclone bisync /share/Sync/code gdrive:sync/code --filters-file=/share/synccenter-config/compiled/dev-monorepo/filter.rclone --resilient --recover --max-lock=2m --conflict-resolve=newer --conflict-loser=pathrename',
    }];
    const out = renderCrontab(plans);
    if (process.env["BUN_UPDATE_GOLDEN"] === "1" || !existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, out, "utf8");
    }
    const expected = readFileSync(GOLDEN, "utf8");
    expect(out).toBe(expected);
  });

  it("emits empty string for an empty schedule list", () => {
    expect(renderCrontab([])).toBe("");
  });
});
