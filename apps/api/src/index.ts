#!/usr/bin/env bun
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const cfg = loadConfig();
const { app } = buildApp({ cfg });

app.listen(cfg.port, () => {
  process.stdout.write(`synccenter api listening on :${cfg.port}\n`);
  process.stdout.write(`  config dir: ${cfg.configDir}\n`);
  process.stdout.write(`  db:         ${cfg.dbPath}\n`);
});
