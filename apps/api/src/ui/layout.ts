import { html, raw, type Raw } from "./html.ts";
import { STYLESHEET } from "./styles.ts";

export interface PageOpts {
  /** Browser-tab title; " — SyncCenter" is appended. */
  title: string;
  /** Breadcrumb fragments after the wordmark, e.g. [link("jobs"), "new"]. */
  crumb?: Array<Raw | string>;
  body: Raw;
  /** Hide the sign-out control (login page). */
  authed?: boolean;
}

/**
 * Full HTML document shell. The htmx-config meta opts 4xx/5xx responses into
 * swapping, so validation errors and blocked applies render as fragments
 * while keeping honest status codes.
 */
export function page(opts: PageOpts): string {
  const crumb = (opts.crumb ?? []).map((c) => html`<span class="sep">▸</span>${c}`);
  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${opts.title} — SyncCenter</title>
<meta name="htmx-config" content='{"responseHandling":[{"code":"204","swap":false},{"code":"[23]..","swap":true},{"code":"[45]..","swap":true}]}'>
<style>${raw(STYLESHEET)}</style>
<script src="/ui/assets/htmx.min.js" defer></script>
</head>
<body>
<header class="top">
  <div class="shell top-in">
    <a class="wordmark" href="/ui/jobs">sync<span class="dot">·</span>center</a>
    <nav class="crumb" aria-label="Breadcrumb">${crumb}</nav>
    ${
      opts.authed === false
        ? ""
        : html`<form method="post" action="/ui/logout"><button class="btn btn-ghost btn-sm" type="submit">Sign out</button></form>`
    }
  </div>
</header>
<main class="shell">
${opts.body}
</main>
</body>
</html>`;
  return doc.html;
}

/** Breadcrumb link helper. */
export function crumbLink(href: string, label: string): Raw {
  return html`<a href="${href}">${label}</a>`;
}
