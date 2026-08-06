/**
 * The small uppercase chip that qualifies a timeline row — `dry run`, `resync`,
 * `syncthing`. Shared because run bands and sync bands render interleaved in
 * one list: two copies of this style drift into two different chips sitting on
 * adjacent rows.
 */
export function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-rule px-1 font-mono text-[10px] uppercase tracking-wider text-dim">
      {children}
    </span>
  );
}
