import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { connectLive, type LiveStatus, type ScEvent } from "@/lib/events";
import type { RunView } from "@/lib/api";

interface LiveValue {
  status: LiveStatus;
  /** Newest first. Everything the server has told us about, capped. */
  runs: RunView[];
  active: RunView[];
  /** Rises on every folder event, so views can key off "something changed". */
  revision: number;
}

const LiveCtx = createContext<LiveValue>({
  status: "connecting",
  runs: [],
  active: [],
  revision: 0,
});

const KEEP = 40;

/**
 * One event stream for the whole app.
 *
 * Runs live here rather than in react-query because they arrive as a push and
 * mutate several times a second; folder events go the other way, invalidating
 * the queries that own that data so there is exactly one source of truth for
 * each thing.
 */
export function LiveProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [runs, setRuns] = useState<RunView[]>([]);
  const [revision, setRevision] = useState(0);
  // The connection outlives renders; keep the callbacks off the effect's deps.
  const qcRef = useRef(qc);
  qcRef.current = qc;

  useEffect(() => {
    const onEvent = (e: ScEvent) => {
      if (e.type === "hello") {
        setRuns(e.runs.slice(0, KEEP));
        return;
      }
      if (e.type === "run") {
        setRuns((prev) => {
          const next = prev.filter((r) => r.id !== e.run.id);
          next.unshift(e.run);
          return next.slice(0, KEEP);
        });
        // A finished run writes history and may have changed what's on disk.
        if (e.run.state !== "running") {
          void qcRef.current.invalidateQueries({ queryKey: ["apply-history"] });
          void qcRef.current.invalidateQueries({ queryKey: ["folder-state", e.run.folder] });
        }
        return;
      }
      if (e.type === "folder") {
        setRevision((n) => n + 1);
        const c = qcRef.current;
        for (const key of ["folders", "schedule", "apply-history"]) {
          void c.invalidateQueries({ queryKey: [key] });
        }
        void c.invalidateQueries({ queryKey: ["folder", e.folder] });
        void c.invalidateQueries({ queryKey: ["folder-state", e.folder] });
      }
    };

    return connectLive({ onEvent, onStatus: setStatus });
  }, []);

  const value = useMemo<LiveValue>(
    () => ({ status, runs, active: runs.filter((r) => r.state === "running"), revision }),
    [status, runs, revision],
  );

  return <LiveCtx.Provider value={value}>{children}</LiveCtx.Provider>;
}

export function useLive(): LiveValue {
  return useContext(LiveCtx);
}

/** Active runs for one folder. */
export function useFolderRuns(folder: string): RunView[] {
  const { active } = useLive();
  return useMemo(() => active.filter((r) => r.folder === folder), [active, folder]);
}
