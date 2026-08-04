#!/usr/bin/env bun
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const cfg = loadConfig();
const { app, tracker, rclone } = buildApp({ cfg });

// Only the long-lived server polls rclone; tests build an app without it.
tracker.start();

app.listen(cfg.port, () => {
  process.stdout.write(`synccenter api listening on :${cfg.port}\n`);
  process.stdout.write(`  config dir: ${cfg.configDir}\n`);
  process.stdout.write(`  db:         ${cfg.dbPath}\n`);
  process.stdout.write(`  runs:       ${rclone ? "tracking live bisync jobs" : "no rclone (SC_RCLONE_URL unset)"}\n`);
});
