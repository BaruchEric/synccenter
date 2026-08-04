import type { RunView } from "./runs-service.ts";

/**
 * What changed. Every connected browser gets these over SSE, so a run started
 * in one tab shows up in every other one — and so the UI never has to poll the
 * Syncthing/rclone daemons N times over for N viewers.
 */
export type ScEvent =
  | { type: "run"; run: RunView }
  | { type: "folder"; folder: string; action: FolderAction }
  | { type: "ping" };

export type FolderAction =
  | "created"
  | "updated"
  | "deleted"
  | "enabled"
  | "disabled"
  | "paused"
  | "resumed"
  | "applied";

export type Listener = (e: ScEvent) => void;

/** A process-local fan-out. One instance per app; SSE connections subscribe. */
export class EventBus {
  private readonly listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  emit(e: ScEvent): void {
    for (const fn of [...this.listeners]) {
      // One broken subscriber (a socket that died between the close event and
      // this write) must not stop the rest from being told.
      try {
        fn(e);
      } catch {
        /* dropped */
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}
