import { Router } from "express";
import type { Db } from "../db.ts";
import type { EventBus, ScEvent } from "../lib/bus.ts";
import { listRuns, toView } from "../lib/runs-service.ts";

/**
 * Heartbeat period. Two jobs: keep proxies from closing an idle stream, and
 * give the client something to miss — it declares the connection dead after a
 * couple of skipped beats, so this also sets how fast a dead server is noticed.
 */
const HEARTBEAT_MS = 10_000;

export function eventsRouter(db: Db, bus: EventBus): Router {
  const r = Router();

  /**
   * Server-sent events: one open stream per browser tab, fed by the run tracker
   * and by every mutation route.
   *
   * Clients connect with `fetch` and read the body, not `EventSource` — the API
   * is bearer-authenticated and `EventSource` cannot set a header, so the only
   * way to use it would be a token in the query string, where it lands in every
   * access log along the way.
   */
  r.get("/events", (req, res) => {
    res.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      // `no-transform` matters as much as `no-cache`: without it a proxy is
      // free to buffer the stream into chunks and the feed arrives in bursts.
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // nginx-family proxies buffer responses unless told otherwise.
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    const send = (e: ScEvent) => {
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    };

    // Open with the current state so a fresh tab is correct before anything
    // changes — otherwise a run in flight stays invisible until its next tick.
    res.write(
      `event: hello\ndata: ${JSON.stringify({
        type: "hello",
        runs: listRuns(db, 25).map(toView),
        at: new Date().toISOString(),
      })}\n\n`,
    );

    const unsubscribe = bus.subscribe(send);
    const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), HEARTBEAT_MS);
    heartbeat.unref?.();

    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on("close", close);
    req.on("error", close);
  });

  return r;
}
