import type { Request, Response } from "express";

const started = Date.now();

export function metricsHandler(req: Request, res: Response): void {
  const uptime = (Date.now() - started) / 1000;
  const body = [
    "# HELP synccenter_up 1 if the API is responding.",
    "# TYPE synccenter_up gauge",
    "synccenter_up 1",
    "",
    "# HELP synccenter_uptime_seconds Seconds since API process started.",
    "# TYPE synccenter_uptime_seconds counter",
    `synccenter_uptime_seconds ${uptime.toFixed(3)}`,
    "",
    "# HELP synccenter_info Build info.",
    "# TYPE synccenter_info gauge",
    `synccenter_info{version="0.0.1"} 1`,
    "",
  ].join("\n");
  res.set("Content-Type", "text/plain; version=0.0.4").send(body);
}
