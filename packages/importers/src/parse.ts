import { ImporterError, type ParsedImport } from "./types.ts";

// Allow nested paths like `Global/macOS` since github/gitignore organizes
// OS/editor templates under subdirectories.
const GITHUB_RE = /^github:\/\/github\/gitignore\/([A-Za-z0-9._/-]+)$/;
const FILE_RE = /^file:\/\/(.+)$/;
const RULESET_RE = /^ruleset:\/\/([a-z][a-z0-9-]*)$/;
const URL_RE = /^url:\/\/(.+)$/;

export function parseImportUri(uri: string): ParsedImport {
  const gh = GITHUB_RE.exec(uri);
  if (gh) return { uri, scheme: "github", githubName: gh[1] };

  const f = FILE_RE.exec(uri);
  if (f) return { uri, scheme: "file", filePath: f[1] };

  const rs = RULESET_RE.exec(uri);
  if (rs) return { uri, scheme: "ruleset", rulesetName: rs[1] };

  const u = URL_RE.exec(uri);
  if (u) {
    const full = u[1]!;
    if (!full.startsWith("https://")) {
      throw new ImporterError(`url:// imports must use https (got ${uri})`, "non-https");
    }
    return { uri, scheme: "url", url: full };
  }

  throw new ImporterError(`unrecognized import URI: ${uri}`, "unknown-scheme");
}
