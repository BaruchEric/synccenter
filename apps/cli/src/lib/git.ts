import { spawnSync } from "node:child_process";

export function gitShortSha(dir: string): string {
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (r.status !== 0 || !r.stdout) return "local";
  return r.stdout.trim() || "local";
}
