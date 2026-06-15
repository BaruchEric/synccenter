import type { Response } from "express";

export const ERR_INTERNAL = "INTERNAL";

interface CodedError {
  code?: string;
}

/**
 * Send a JSON error envelope. If the thrown value carries a `code` field,
 * the response is treated as a known/user-facing error (status 400 by default);
 * otherwise it's an internal fault and uses `internalStatus` (default 500).
 */
export function respondJsonError(
  res: Response,
  err: unknown,
  opts: { knownStatus?: number; internalStatus?: number } = {},
): void {
  const code = (err as CodedError).code;
  const status = code ? (opts.knownStatus ?? 400) : (opts.internalStatus ?? 500);
  res.status(status).json({
    error: { code: code ?? ERR_INTERNAL, message: (err as Error).message },
  });
}
