/**
 * Minimal server-side HTML templating for the HTMX UI.
 *
 * `html` is a tagged template that escapes every interpolated value unless it
 * is wrapped in `raw()` / is another `html` fragment. Arrays are joined,
 * null/undefined/false render as "" (so `${cond ? html`…` : ""}` works).
 */

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ESC[c] ?? c);
}

export class Raw {
  constructor(public readonly html: string) {}
  toString(): string {
    return this.html;
  }
}

export function raw(fragment: string): Raw {
  return new Raw(fragment);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = "";
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) out += renderValue(values[i]);
  }
  return new Raw(out);
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof Raw) return v.html;
  if (Array.isArray(v)) return v.map(renderValue).join("");
  return esc(v);
}
