import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, heldMembers, type FolderManifest, type SyncNowResult } from "@/lib/api";

/**
 * The verbs for one folder. Two tiers, because they are not equally safe:
 * Sync now/Apply/Pause act on the running mesh and are reversible; Disable
 * and Delete change committed config, so Delete asks twice and says what it
 * will not touch.
 *
 * "Sync now" means every leg: a window on each held Syncthing member, then
 * the bisync to each cloud member once those windows close. "Cloud only"
 * is the bisync on its own, for when the mesh is already caught up.
 */
export function FolderActions({
  name,
  manifest,
  hasCloudMember,
  paused,
}: {
  name: string;
  manifest?: FolderManifest;
  hasCloudMember?: boolean;
  paused?: boolean;
}) {
  const qc = useQueryClient();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  const disabled = manifest?.enabled === false;
  const held = manifest ? heldMembers(manifest) : [];
  const canSync = held.length > 0 || hasCloudMember === true;

  const refresh = () => {
    for (const k of ["folders", "folder", "folder-state", "schedule", "apply-history", "jobs"]) {
      void qc.invalidateQueries({ queryKey: [k] });
      void qc.invalidateQueries({ queryKey: [k, name] });
    }
  };

  const run = useMutation({
    mutationFn: async (verb: Verb): Promise<unknown> => {
      switch (verb) {
        case "bisync":
          return api.post(`/folders/${encodeURIComponent(name)}/bisync?async=true`);
        case "sync":
          return api.post<SyncNowResult>(`/folders/${encodeURIComponent(name)}/sync`);
        case "apply":
          return api.post(`/folders/${encodeURIComponent(name)}/apply`, { confirm: true });
        case "pause":
        case "resume":
          return api.post(`/folders/${encodeURIComponent(name)}/${verb}`);
        case "enable":
        case "disable":
          return api.post(`/folders/${encodeURIComponent(name)}/${verb}`);
        case "delete":
          return api.del(`/folders/${encodeURIComponent(name)}`, { confirm: true });
      }
    },
    onSuccess: (data, verb) => {
      if (verb === "sync" && isSyncNowResult(data)) {
        const said = describeSyncNow(data);
        setNote(said);
      } else {
        setNote({ tone: "ok", text: DONE[verb] });
      }
      setConfirmingDelete(false);
      refresh();
    },
    onError: (e: Error) => setNote({ tone: "fail", text: e.message }),
  });

  const busy = run.isPending;
  const fire = (v: Verb) => () => {
    setNote(null);
    run.mutate(v);
  };

  // `contents`: the buttons and the note join the caller's flex row, so a
  // full-width note drops below the whole verb line instead of pushing the
  // caller's own Edit link onto a line of its own.
  return (
    <div className="contents">
      {canSync && (
        <Action
          onClick={fire("sync")}
          disabled={busy || disabled}
          primary
          title={
            held.length > 0 && hasCloudMember
              ? `Open a sync window on ${held.join(", ")}, then bisync to the cloud member when it closes`
              : held.length > 0
                ? `Open a sync window on ${held.join(", ")}`
                : "Run the bisync to the cloud member now"
          }
        >
          Sync now
        </Action>
      )}
      {hasCloudMember && held.length > 0 && (
        <Action
          onClick={fire("bisync")}
          disabled={busy || disabled}
          title="Bisync to the cloud member without opening a sync window first"
        >
          Cloud only
        </Action>
      )}
      <Action onClick={fire("apply")} disabled={busy || disabled}>
        Apply
      </Action>
      <Action onClick={fire(paused ? "resume" : "pause")} disabled={busy}>
        {paused ? "Resume" : "Pause"}
      </Action>
      <Action onClick={fire(disabled ? "enable" : "disable")} disabled={busy}>
        {disabled ? "Enable" : "Disable"}
      </Action>

      {confirmingDelete ? (
        <span className="flex items-center gap-1.5">
          <Action onClick={fire("delete")} disabled={busy} danger>
            Delete for good
          </Action>
          <Action onClick={() => setConfirmingDelete(false)} disabled={busy}>
            Keep
          </Action>
        </span>
      ) : (
        <Action onClick={() => setConfirmingDelete(true)} disabled={busy} danger>
          Delete
        </Action>
      )}

      {confirmingDelete && (
        <span className="basis-full text-[11px] text-dim">
          Removes the manifest only. Files on every host and the live Syncthing folders stay.
        </span>
      )}
      {note && (
        <span
          role="status"
          className={`basis-full text-[11px] ${note.tone === "ok" ? "text-ok" : "text-fail"}`}
        >
          {note.text}
          {note.job && (
            <>
              {" "}
              <Link
                to={`/history/jobs/${note.job}`}
                className="font-mono text-signal underline decoration-signal/40 underline-offset-2 hover:decoration-signal focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
              >
                job #{note.job}
              </Link>
            </>
          )}
        </span>
      )}
    </div>
  );
}

type Verb = "bisync" | "sync" | "apply" | "pause" | "resume" | "enable" | "disable" | "delete";

/** What the last verb said, and the job to follow if it started one. */
interface Note {
  tone: "ok" | "fail";
  text: string;
  job?: number;
}

const DONE: Record<Verb, string> = {
  bisync: "Bisync started on the anchor — watch it on the timeline.",
  sync: "Sync started — watch it on the timeline.",
  apply: "Applied to every host.",
  pause: "Paused.",
  resume: "Resumed.",
  enable: "Enabled — it will be scheduled again.",
  disable: "Disabled — no scheduled runs.",
  delete: "Manifest deleted.",
};

function isSyncNowResult(v: unknown): v is SyncNowResult {
  return typeof v === "object" && v !== null && "windows" in v && "cloud" in v;
}

/** One sentence on what Sync now set in motion, leg by leg, and the job to follow. */
function describeSyncNow(r: SyncNowResult): Note {
  const parts: string[] = [];
  let tone: "ok" | "fail" = "ok";
  const open = r.windows.filter((w) => w.state === "running");
  if (open.length > 0) parts.push(`window open on ${open.map((w) => w.host).join(", ")}`);
  for (const w of r.windows.filter((x) => x.state !== "running")) {
    parts.push(`window on ${w.host} ${w.state}${w.error ? ` (${w.error})` : ""}`);
    if (w.state === "failed") tone = "fail";
  }
  for (const f of r.failed) {
    parts.push(`${f.host}: ${f.error}`);
    tone = "fail";
  }
  if (r.cloud?.status === "queued") {
    parts.push(`bisync → ${r.cloud.members.join(", ")} follows when it closes`);
  } else if (r.cloud?.status === "started") {
    for (const run of r.cloud.runs) parts.push(`bisync → ${run.member ?? "cloud"} started`);
    for (const e of r.cloud.errors) {
      parts.push(`bisync → ${e.member} did not start: ${e.error}`);
      tone = "fail";
    }
  }
  const text = parts.length > 0 ? parts.join(" · ") : "nothing to do";
  return { tone, text: `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}.`, job: r.job.id };
}

function Action({
  children,
  onClick,
  disabled,
  primary,
  danger,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
  title?: string;
}) {
  const tone = primary
    ? "border-signal/60 text-signal hover:bg-signal/10"
    : danger
      ? "border-rule text-fail hover:bg-fail/10"
      : "border-rule text-slate-300 hover:bg-slate-100/5";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded border px-2 py-0.5 font-mono text-[11px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-signal disabled:cursor-not-allowed disabled:opacity-40 ${tone}`}
    >
      {children}
    </button>
  );
}
