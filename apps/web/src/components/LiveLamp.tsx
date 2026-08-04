import type { LiveStatus } from "@/lib/events";

/**
 * Says how the page is being kept up to date, because "live" and "stale" look
 * identical on a dashboard that has simply stopped receiving anything. The
 * pulse is the tell: it stops when the feed does.
 */
export function LiveLamp({ status }: { status: LiveStatus }) {
  const { dot, label, title } = LOOK[status];
  return (
    <span className="inline-flex items-center gap-1.5" title={title}>
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${dot} ${status === "live" ? "sc-pulse" : ""}`}
      />
      <span role="status">{label}</span>
    </span>
  );
}

const LOOK: Record<LiveStatus, { dot: string; label: string; title: string }> = {
  connecting: { dot: "bg-dim", label: "connecting", title: "Opening the event stream" },
  live: { dot: "bg-signal", label: "live", title: "Streaming updates as they happen" },
  polling: {
    dot: "bg-run",
    label: "polling",
    title: "The event stream would not stay open — checking once a second instead",
  },
  offline: {
    dot: "bg-fail",
    label: "offline",
    title: "No updates are getting through. Numbers on this page may be stale.",
  },
};
