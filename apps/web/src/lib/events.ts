import { getToken } from "@/lib/auth";
import type { RunView } from "@/lib/api";

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "/api";

export type ScEvent =
  | { type: "hello"; runs: RunView[]; at: string }
  | { type: "run"; run: RunView }
  | { type: "folder"; folder: string; action: string };

/**
 * How the dashboard is getting its updates.
 * `live` — an open event stream. `polling` — the stream would not hold, so
 * we're asking every second instead. `offline` — neither is answering.
 */
export type LiveStatus = "connecting" | "live" | "polling" | "offline";

export interface LiveOptions {
  onEvent: (e: ScEvent) => void;
  onStatus: (s: LiveStatus) => void;
}

/** Stream failures before giving up on SSE and settling for polling. */
const SSE_ATTEMPTS = 3;
const POLL_MS = 1000;
/**
 * Longest silence tolerated before the stream is presumed dead.
 *
 * A dead server does not necessarily close the socket: with a proxy in the
 * middle — Vite in dev, Traefik and Cloudflare in production — the connection
 * can stay open and simply never deliver anything again, so `read()` blocks
 * forever and the page shows a confident "live" lamp over frozen numbers. The
 * server heartbeats every 10s, so more than two missed beats means gone.
 */
const STALE_MS = 26_000;
const WATCHDOG_MS = 5_000;
/** How long to make do with polling before trying the stream once more. */
const POLL_BEFORE_RETRY_MS = 60_000;

/**
 * Opens the server's event stream and keeps it open.
 *
 * `EventSource` would be the obvious tool and is not usable here: the API wants
 * a bearer token, `EventSource` cannot set headers, and the alternative — the
 * token in the query string — writes a credential into every access log between
 * the browser and the server. Reading the stream from `fetch` costs a hand-
 * rolled frame parser and keeps the token in a header where it belongs.
 *
 * Falls back to polling /runs if the stream will not stay up; some proxies
 * buffer or close long-lived responses, and a second-resolution poll of a
 * SQLite-backed endpoint is a fine consolation prize.
 */
export function connectLive({ onEvent, onStatus }: LiveOptions): () => void {
  const ctrl = new AbortController();
  let closed = false;
  let failures = 0;

  const auth = (): Record<string, string> => {
    const t = getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  };

  async function stream(): Promise<void> {
    onStatus("connecting");
    // Its own controller so the watchdog can drop just this attempt; the
    // caller's abort still cascades through the listener below.
    const attempt = new AbortController();
    const cascade = () => attempt.abort();
    ctrl.signal.addEventListener("abort", cascade, { once: true });

    let lastByteAt = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastByteAt > STALE_MS) attempt.abort();
    }, WATCHDOG_MS);

    try {
      const res = await fetch(`${BASE}/events`, {
        headers: { ...auth(), Accept: "text/event-stream" },
        signal: attempt.signal,
      });
      if (!res.ok || !res.body) throw new Error(`events → ${res.status}`);

      onStatus("live");
      failures = 0;
      await pump(res.body, () => {
        lastByteAt = Date.now();
      });
    } finally {
      clearInterval(watchdog);
      ctrl.signal.removeEventListener("abort", cascade);
    }
  }

  async function pump(body: ReadableStream<Uint8Array>, beat: () => void): Promise<never> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error("stream ended");
      // Any traffic counts as proof of life, heartbeat comments included.
      beat();
      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line. Anything before the last one is
      // complete; whatever trails stays buffered until the rest arrives.
      let split: number;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (!data) continue; // a heartbeat comment
        try {
          onEvent(JSON.parse(data) as ScEvent);
        } catch {
          /* a frame we don't understand is not worth dropping the stream for */
        }
      }
    }
  }

  /**
   * Polls until it is worth trying the stream again.
   *
   * Falling back permanently would mean one server restart costs the page its
   * event stream for as long as the tab stays open — polling works, but it is
   * the consolation prize, and the usual reason the stream failed is that the
   * server was briefly gone.
   */
  async function poll(): Promise<void> {
    onStatus("polling");
    const until = Date.now() + POLL_BEFORE_RETRY_MS;
    while (!closed && Date.now() < until) {
      try {
        const res = await fetch(`${BASE}/runs?limit=25`, { headers: auth(), signal: ctrl.signal });
        if (res.ok) {
          const body = (await res.json()) as { runs: RunView[] };
          onEvent({ type: "hello", runs: body.runs, at: new Date().toISOString() });
          onStatus("polling");
        } else {
          onStatus("offline");
        }
      } catch {
        if (closed) return;
        onStatus("offline");
      }
      await sleep(POLL_MS, ctrl.signal);
    }
  }

  void (async () => {
    while (!closed) {
      try {
        await stream();
      } catch {
        if (closed) return;
        failures += 1;
        onStatus("offline");
        if (failures >= SSE_ATTEMPTS) {
          await poll();
          // Polling bought us a working page; go back and see whether the
          // stream will hold this time.
          failures = 0;
          continue;
        }
        // Back off a little so a server that is restarting isn't hammered.
        await sleep(Math.min(4000, 400 * 2 ** failures), ctrl.signal);
      }
    }
  })();

  return () => {
    closed = true;
    ctrl.abort();
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
