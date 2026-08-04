import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { api, type FolderManifest, type HostsList, type RulesList } from "@/lib/api";
import { nextRuns, relative } from "@/lib/cron";

const TYPES = ["send-receive", "send-only", "receive-only", "receive-encrypted"] as const;

/**
 * Write a folder manifest.
 *
 * The form owns the fields people actually change — where the folder lives on
 * each host, which ruleset governs it, when the cloud leg runs. Everything else
 * in the manifest is carried through byte-for-byte and listed as such: this
 * writes a real file in a git repo, and a form that quietly dropped the keys it
 * didn't have inputs for would delete a folder's versioning policy the first
 * time somebody fixed a typo in a path.
 *
 * `enabled` is deliberately absent. Disable already has a button of its own,
 * and two controls writing one key is how they end up disagreeing.
 */
export function FolderEdit() {
  const { name: routeName } = useParams<{ name: string }>();
  const creating = !routeName;
  const nav = useNavigate();
  const qc = useQueryClient();

  const existing = useQuery({
    queryKey: ["folder", routeName],
    queryFn: () => api.get<FolderManifest>(`/folders/${encodeURIComponent(routeName!)}`),
    enabled: !creating,
  });
  const rules = useQuery({ queryKey: ["rules"], queryFn: () => api.get<RulesList>("/rules") });
  const hosts = useQuery({ queryKey: ["hosts"], queryFn: () => api.get<HostsList>("/hosts") });

  const [form, setForm] = useState<FormState>(() => blank());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (creating || !existing.data || loaded) return;
    setForm(fromManifest(existing.data));
    setLoaded(true);
  }, [creating, existing.data, loaded]);

  const save = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      creating
        ? api.post<{ folder: FolderManifest }>("/folders", payload)
        : api.put<{ folder: FolderManifest }>(
            `/folders/${encodeURIComponent(routeName!)}`,
            payload,
          ),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["folders"] });
      void qc.invalidateQueries({ queryKey: ["folder", r.folder.name] });
      nav("/folders");
    },
  });

  const payload = useMemo(() => toManifest(form), [form]);
  const problems = useMemo(() => validate(form, creating), [form, creating]);
  const upcoming = useMemo(
    () => (form.schedule.trim() ? nextRuns(form.schedule.trim(), 1, new Date()) : []),
    [form.schedule],
  );

  if (!creating && existing.isLoading) {
    return <p className="py-12 text-center text-sm text-dim">Reading the manifest…</p>;
  }
  if (!creating && existing.isError) {
    return (
      <Empty>
        No manifest for <span className="font-mono text-slate-200">{routeName}</span>. It may have
        been deleted since this page loaded.
      </Empty>
    );
  }

  const carried = Object.keys(form.rest);

  return (
    <form
      className="mx-auto max-w-3xl"
      onSubmit={(e) => {
        e.preventDefault();
        if (problems.length === 0) save.mutate(payload);
      }}
    >
      <header className="mb-6">
        <h1 className="font-mono text-3xl font-semibold tracking-tight text-slate-100">
          {creating ? "new folder" : form.name}
        </h1>
        <p className="mt-1 text-sm text-dim">
          {creating
            ? "Writes a manifest to folders/ in the config repo. Nothing reaches a host until you apply it."
            : "Edits folders/" + form.name + ".yaml. Apply afterwards to push the change to every host."}
        </p>
      </header>

      <Section title="Identity">
        <Field label="Name" hint={creating ? "Lowercase, digits and dashes. Also the Syncthing folder ID." : undefined}>
          {creating ? (
            <input
              className={INPUT_FULL}
              value={form.name}
              autoFocus
              placeholder="photos"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          ) : (
            <p className="py-1.5 font-mono text-sm text-dim">
              {form.name}
              <span className="ml-2 text-xs">
                — renaming would orphan the compiled filters and the live folder ID. Delete and
                recreate instead.
              </span>
            </p>
          )}
        </Field>

        <Field label="Ruleset" hint="Which exclude policy compiles into this folder's ignores.">
          <select
            className={INPUT_FULL}
            value={form.ruleset}
            onChange={(e) => setForm({ ...form, ruleset: e.target.value })}
          >
            <option value="">Choose a ruleset…</option>
            {(rules.data?.rules ?? []).map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Type" hint="How Syncthing treats the folder on every host.">
          <select
            className={INPUT_FULL}
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value })}
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
      </Section>

      <Section
        title="Members"
        note="One line per host. Absolute path for a machine; path inside the remote for a cloud member."
      >
        <ul className="space-y-2">
          {form.paths.map((row, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <select
                className={`${INPUT} w-44 shrink-0`}
                value={row.host}
                aria-label={`Host for member ${i + 1}`}
                onChange={(e) => setForm({ ...form, paths: replaceAt(form.paths, i, { ...row, host: e.target.value }) })}
              >
                <option value="">host…</option>
                {(hosts.data?.hosts ?? []).map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
              <input
                className={`${INPUT} min-w-0 flex-1`}
                value={row.path}
                aria-label={`Path for member ${i + 1}`}
                placeholder="/share/Photos"
                onChange={(e) => setForm({ ...form, paths: replaceAt(form.paths, i, { ...row, path: e.target.value }) })}
              />
              <button
                type="button"
                className="rounded border border-rule px-2 py-1 font-mono text-[11px] text-fail transition-colors hover:bg-fail/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
                onClick={() => setForm({ ...form, paths: form.paths.filter((_, j) => j !== i) })}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="mt-2 rounded border border-rule px-2 py-1 font-mono text-[11px] text-slate-300 transition-colors hover:bg-slate-100/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
          onClick={() => setForm({ ...form, paths: [...form.paths, { host: "", path: "" }] })}
        >
          Add a member
        </button>
      </Section>

      <Section title="Cloud leg" note="Only used when one of the members is a cloud remote.">
        <Field label="Schedule" hint="Five-field cron, in the anchor host's local time. Leave empty for no scheduled run.">
          <input
            className={INPUT_FULL}
            value={form.schedule}
            placeholder="0 4 * * *"
            onChange={(e) => setForm({ ...form, schedule: e.target.value })}
          />
          <p className="mt-1 font-mono text-xs text-dim">
            {form.schedule.trim() === ""
              ? "No scheduled bisync. You can still run it by hand."
              : upcoming.length > 0
                ? `Next run ${relative(upcoming[0]!, new Date())} — ${upcoming[0]!.toLocaleString([], { hour12: false })}`
                : "Not a cron expression this reader understands."}
          </p>
        </Field>

        <Field label="Anchor" hint="The host that runs rclone. Defaults to the cloud-edge host.">
          <select
            className={INPUT_FULL}
            value={form.anchor}
            onChange={(e) => setForm({ ...form, anchor: e.target.value })}
          >
            <option value="">default (cloud-edge host)</option>
            {form.paths.filter((p) => p.host).map((p) => (
              <option key={p.host} value={p.host}>
                {p.host}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Flags" hint="One rclone flag per line.">
          <textarea
            className={`${INPUT_FULL} h-28 resize-y`}
            value={form.flags}
            placeholder="--resilient&#10;--modify-window=1s"
            onChange={(e) => setForm({ ...form, flags: e.target.value })}
          />
        </Field>
      </Section>

      {carried.length > 0 && (
        <Section title="Carried through unchanged">
          <p className="text-sm text-dim">
            This manifest also sets{" "}
            {carried.map((k, i) => (
              <span key={k}>
                {i > 0 && ", "}
                <span className="font-mono text-slate-300">{k}</span>
              </span>
            ))}
            . Saving keeps {carried.length === 1 ? "it" : "them"} exactly as {carried.length === 1 ? "it is" : "they are"} — edit the YAML directly to change{" "}
            {carried.length === 1 ? "it" : "them"}.
          </p>
        </Section>
      )}

      <Section title="What gets written">
        <pre className="max-h-72 overflow-auto rounded border border-rule bg-ink p-3 font-mono text-xs leading-relaxed text-slate-300">
          {JSON.stringify(payload, null, 2)}
        </pre>
      </Section>

      {problems.length > 0 && (
        <ul className="mb-4 space-y-1 border-l-2 border-signal pl-3">
          {problems.map((p) => (
            <li key={p} className="text-sm text-slate-300">
              {p}
            </li>
          ))}
        </ul>
      )}
      {save.error && (
        <p role="alert" className="mb-4 border-l-2 border-fail pl-3 text-sm text-fail">
          {(save.error as Error).message}
        </p>
      )}

      <div className="flex items-center gap-2 pb-10">
        <button
          type="submit"
          disabled={problems.length > 0 || save.isPending}
          className="rounded border border-signal/60 px-3 py-1.5 font-mono text-xs text-signal transition-colors hover:bg-signal/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal disabled:cursor-not-allowed disabled:opacity-40"
        >
          {save.isPending ? "Saving…" : creating ? "Create folder" : "Save changes"}
        </button>
        <button
          type="button"
          onClick={() => nav("/folders")}
          className="rounded border border-rule px-3 py-1.5 font-mono text-xs text-slate-300 transition-colors hover:bg-slate-100/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---- form state ↔ manifest -------------------------------------------------

interface PathRow {
  host: string;
  path: string;
}
interface FormState {
  name: string;
  ruleset: string;
  type: string;
  paths: PathRow[];
  schedule: string;
  anchor: string;
  flags: string;
  /** Every manifest key this form has no input for, kept verbatim. */
  rest: Record<string, unknown>;
}

function blank(): FormState {
  return {
    name: "",
    ruleset: "",
    type: "send-receive",
    paths: [{ host: "", path: "" }],
    schedule: "",
    anchor: "",
    flags: "",
    rest: {},
  };
}

/** Keys the form renders. Anything else belongs to `rest`. */
const OWNED = new Set(["name", "ruleset", "type", "paths", "bisync", "enabled"]);

function fromManifest(m: FolderManifest): FormState {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) if (!OWNED.has(k)) rest[k] = v;
  return {
    name: m.name,
    ruleset: m.ruleset,
    type: m.type,
    paths: Object.entries(m.paths ?? {}).map(([host, path]) => ({ host, path })),
    schedule: m.bisync?.schedule ?? "",
    anchor: m.bisync?.anchor ?? "",
    flags: (m.bisync?.flags ?? []).join("\n"),
    rest,
  };
}

function toManifest(f: FormState): Record<string, unknown> {
  const paths: Record<string, string> = {};
  for (const { host, path } of f.paths) {
    if (host.trim() && path.trim()) paths[host.trim()] = path.trim();
  }
  const flags = f.flags
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const bisync: Record<string, unknown> = {};
  if (f.anchor.trim()) bisync.anchor = f.anchor.trim();
  if (f.schedule.trim()) bisync.schedule = f.schedule.trim();
  if (flags.length > 0) bisync.flags = flags;

  return {
    name: f.name.trim(),
    ruleset: f.ruleset,
    type: f.type,
    paths,
    ...(Object.keys(bisync).length > 0 ? { bisync } : {}),
    // Last, so a stray key in `rest` can never shadow a form field.
    ...f.rest,
  };
}

/** Say what's wrong before the server has to, in the same words it would use. */
function validate(f: FormState, creating: boolean): string[] {
  const out: string[] = [];
  const name = f.name.trim();
  if (creating) {
    if (!name) out.push("Give the folder a name.");
    else if (!/^[a-z][a-z0-9-]*$/.test(name))
      out.push("Names start with a letter and use lowercase, digits and dashes only.");
    else if (name === "new") out.push("'new' is reserved — pick another name.");
  }
  if (!f.ruleset) out.push("Choose a ruleset.");

  const filled = f.paths.filter((p) => p.host.trim() && p.path.trim());
  if (filled.length === 0) out.push("Add at least one member with both a host and a path.");
  const seen = new Set<string>();
  for (const p of filled) {
    if (seen.has(p.host)) out.push(`${p.host} is listed twice — one path per host.`);
    seen.add(p.host);
  }
  if (f.anchor && !seen.has(f.anchor)) {
    out.push(`The anchor ${f.anchor} is not one of this folder's members.`);
  }
  return out;
}

function replaceAt<T>(xs: T[], i: number, v: T): T[] {
  return xs.map((x, j) => (j === i ? v : x));
}

// ---- chrome ----------------------------------------------------------------

// Width is deliberately NOT in here. Tailwind resolves conflicting utilities by
// stylesheet order, not by the order they appear in the class string, so a
// baked-in `w-full` silently beats a `w-44` added at the call site.
const INPUT =
  "rounded border border-rule bg-ink px-2 py-1.5 font-mono text-sm text-slate-200 placeholder:text-dim focus:border-signal/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal";
const INPUT_FULL = `${INPUT} w-full`;

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6 rounded-lg border border-rule bg-panel">
      <h2 className="border-b border-rule px-4 py-2 text-xs uppercase tracking-wider text-dim">
        {title}
      </h2>
      <div className="p-4">
        {note && <p className="mb-3 text-xs text-dim">{note}</p>}
        {children}
      </div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="mb-4 block last:mb-0">
      <span className="mb-1 block text-xs uppercase tracking-wider text-dim">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-dim">{hint}</span>}
    </label>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-12 text-center text-sm text-dim">{children}</p>;
}
