import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type FolderManifest } from "@/lib/api";

/**
 * The verbs for one folder. Two tiers, because they are not equally safe:
 * Run/Apply/Pause act on the running mesh and are reversible; Disable and
 * Delete change committed config, so Delete asks twice and says what it will
 * not touch.
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
  const [note, setNote] = useState<{ tone: "ok" | "fail"; text: string } | null>(null);

  const disabled = manifest?.enabled === false;

  const refresh = () => {
    for (const k of ["folders", "folder", "folder-state", "schedule", "apply-history"]) {
      void qc.invalidateQueries({ queryKey: [k] });
      void qc.invalidateQueries({ queryKey: [k, name] });
    }
  };

  const run = useMutation({
    mutationFn: async (verb: Verb) => {
      switch (verb) {
        case "bisync":
          return api.post(`/folders/${encodeURIComponent(name)}/bisync?async=true`);
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
    onSuccess: (_d, verb) => {
      setNote({ tone: "ok", text: DONE[verb] });
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

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {hasCloudMember && (
        <Action onClick={fire("bisync")} disabled={busy || disabled} primary>
          Run
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
        </span>
      )}
    </div>
  );
}

type Verb = "bisync" | "apply" | "pause" | "resume" | "enable" | "disable" | "delete";

const DONE: Record<Verb, string> = {
  bisync: "Bisync started on the anchor.",
  apply: "Applied to every host.",
  pause: "Paused.",
  resume: "Resumed.",
  enable: "Enabled — it will be scheduled again.",
  disable: "Disabled — no scheduled runs.",
  delete: "Manifest deleted.",
};

function Action({
  children,
  onClick,
  disabled,
  primary,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
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
      className={`rounded border px-2 py-0.5 font-mono text-[11px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-signal disabled:cursor-not-allowed disabled:opacity-40 ${tone}`}
    >
      {children}
    </button>
  );
}
