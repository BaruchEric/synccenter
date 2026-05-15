import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { api, type ApplyResult, type FolderState } from "@/lib/api";
import { Card } from "@/components/Card";

export function FolderDetail() {
  const { name = "" } = useParams<{ name: string }>();
  const qc = useQueryClient();
  const [preview, setPreview] = useState<ApplyResult | null>(null);

  const folder = useQuery({
    queryKey: ["folder", name],
    queryFn: () => api.get<{ name: string; ruleset: string; type: string; paths: Record<string, string> }>(
      `/folders/${encodeURIComponent(name)}`,
    ),
    enabled: !!name,
  });

  const state = useQuery({
    queryKey: ["folder-state", name],
    queryFn: () => api.get<FolderState>(`/folders/${encodeURIComponent(name)}/state`),
    enabled: !!name,
  });

  const dryRun = useMutation({
    mutationFn: () => api.post<ApplyResult>(`/folders/${encodeURIComponent(name)}/apply?dryRun=true`),
    onSuccess: (r) => setPreview(r),
  });

  const apply = useMutation({
    mutationFn: () => api.post<ApplyResult>(`/folders/${encodeURIComponent(name)}/apply`),
    onSuccess: () => {
      setPreview(null);
      qc.invalidateQueries({ queryKey: ["folder-state", name] });
    },
  });

  const pause = useMutation({
    mutationFn: () => api.post(`/folders/${encodeURIComponent(name)}/pause`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["folder-state", name] }),
  });

  const resume = useMutation({
    mutationFn: () => api.post(`/folders/${encodeURIComponent(name)}/resume`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["folder-state", name] }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{name}</h1>
        <div className="flex gap-2">
          <Button onClick={() => dryRun.mutate()} loading={dryRun.isPending}>
            Dry-run
          </Button>
          <Button
            onClick={() => apply.mutate()}
            loading={apply.isPending}
            variant="primary"
          >
            Apply
          </Button>
          <Button onClick={() => pause.mutate()} loading={pause.isPending}>
            Pause
          </Button>
          <Button onClick={() => resume.mutate()} loading={resume.isPending}>
            Resume
          </Button>
        </div>
      </div>

      <Card title="Manifest">
        <pre className="overflow-auto text-xs text-slate-300">
          {folder.data ? JSON.stringify(folder.data, null, 2) : "…"}
        </pre>
      </Card>

      <Card title="Per-host state">
        {state.data ? (
          <ul className="space-y-2">
            {state.data.perHost.map((p) => (
              <li key={p.host} className="flex items-center justify-between rounded border border-slate-800 px-3 py-2">
                <span className="font-mono">{p.host}</span>
                {p.ok && p.status ? (
                  <span className="text-sm">
                    <span className={stateClass(p.status.state)}>{p.status.state}</span>
                    <span className="ml-3 text-slate-500">
                      {p.status.globalBytes.toLocaleString()} B · need {p.status.needFiles}
                      {p.status.errors > 0 ? ` · errors ${p.status.errors}` : ""}
                    </span>
                  </span>
                ) : (
                  <span className="text-error text-sm">{p.error ?? "offline"}</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-slate-500">…</div>
        )}
      </Card>

      {(apply.error || dryRun.error || pause.error || resume.error) && (
        <Card title="Error">
          <pre className="text-sm text-error">
            {((apply.error || dryRun.error || pause.error || resume.error) as Error).message}
          </pre>
        </Card>
      )}

      {preview && (
        <Card
          title="Dry-run preview"
          action={
            <button className="text-xs text-slate-500 hover:text-slate-300" onClick={() => setPreview(null)}>
              dismiss
            </button>
          }
        >
          {preview.warnings && preview.warnings.length > 0 && (
            <div className="mb-2 rounded bg-amber-900/40 p-2 text-xs text-amber-200">
              {preview.warnings.join("\n")}
            </div>
          )}
          <details open>
            <summary className="cursor-pointer text-xs text-slate-400">.stignore</summary>
            <pre className="mt-2 max-h-64 overflow-auto text-xs text-slate-300">{preview.stignorePreview}</pre>
          </details>
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-slate-400">filter.rclone</summary>
            <pre className="mt-2 max-h-64 overflow-auto text-xs text-slate-300">{preview.rclonePreview}</pre>
          </details>
        </Card>
      )}
    </div>
  );
}

function Button({
  children,
  onClick,
  loading,
  variant,
}: {
  children: React.ReactNode;
  onClick: () => void;
  loading?: boolean;
  variant?: "primary";
}) {
  const base = "rounded px-3 py-1.5 text-sm disabled:opacity-50";
  const styles =
    variant === "primary"
      ? "bg-blue-600 text-white hover:bg-blue-500"
      : "border border-slate-700 hover:bg-slate-800";
  return (
    <button onClick={onClick} disabled={loading} className={`${base} ${styles}`}>
      {loading ? "…" : children}
    </button>
  );
}

function stateClass(s: string): string {
  switch (s) {
    case "idle":
      return "text-idle";
    case "syncing":
    case "scanning":
      return "text-syncing";
    case "error":
      return "text-error";
    default:
      return "text-slate-300";
  }
}
