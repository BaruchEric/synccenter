/**
 * The filter dropdowns the record pages share. `label` may be empty when the
 * surrounding heading already says what the choice is.
 */
export function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<[string, string]>;
}) {
  return (
    <label className="flex items-center gap-1.5 text-dim">
      {label && <span className="text-[11px] uppercase tracking-wider">{label}</span>}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-rule bg-ink px-2 py-1 font-mono text-xs text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
      >
        {options.map(([v, l]) => (
          <option key={v || "-"} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}
