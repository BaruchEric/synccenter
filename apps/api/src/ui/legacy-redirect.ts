import { Router } from "express";
import { NAME_RE } from "./form.ts";

/**
 * Retires the server-rendered HTMX console in favour of the React dashboard.
 *
 * `/ui/jobs` and `/app/folders` were always the same list: both read the folder
 * manifests out of `cfg.foldersDir`, one calling them "jobs" and the other
 * "folders". The HTMX console came first; the React app grew past it — rules,
 * hosts, conflicts, a live activity timeline — so it is the one that survives.
 *
 * Mounted at `/ui` *instead of* `uiRouter` whenever a bundle is configured, so
 * old bookmarks land on the equivalent React route rather than on a second,
 * quietly diverging view of the same data. With no bundle (`SC_WEB_DIR` unset —
 * dev, and the test suite) the console stays mounted and unchanged: it is the
 * fallback UI, not dead weight.
 *
 * Both consoles authenticate against the same `SC_API_TOKEN`, so forwarding
 * someone mid-session costs them one re-entry, not a new credential.
 *
 * Redirects are 302, never 301: a permanent redirect gets cached past the point
 * where reverting it would help.
 */
export function legacyUiRedirect(webMount: string): Router {
  const r = Router();
  const folders = `${webMount}/folders`;

  r.get("/jobs", (_req, res) => res.redirect(302, folders));
  r.get("/jobs/new", (_req, res) => res.redirect(302, `${folders}/new`));

  // Registered after the two literals above so `/jobs/new` wins over `:name`.
  // `/plan`, `/apply` and `/state` hung off the detail page and the React detail
  // page carries all three, so the trailing segment collapses onto it.
  //
  // The name arrives straight from the URL, and an unvalidated value in a
  // Location header is a header-injection and open-redirect hole. NAME_RE — the
  // same rule that let the name be created — is the sanitizer: everything it
  // admits is already URL-safe, and everything else falls back to the dashboard
  // root, which is where an unrecognised name should land anyway.
  r.get(/^\/jobs\/([^/]+)(?:\/.*)?$/, (req, res) => {
    const name = (req.params as unknown as string[])[0] ?? "";
    res.redirect(302, NAME_RE.test(name) ? `${folders}/${name}` : `${webMount}/`);
  });

  // Everything else: `/`, `/login`, the htmx fragments, and anything a stale
  // open tab still POSTs. 303 on non-GET so the browser re-issues as a GET
  // rather than replaying the body at a route that cannot read it.
  r.use((req, res) => res.redirect(req.method === "GET" ? 302 : 303, `${webMount}/`));

  return r;
}
