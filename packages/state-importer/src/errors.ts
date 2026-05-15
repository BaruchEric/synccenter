export type ImportErrorCode =
  | "HOST_UNREACHABLE"
  | "FOLDER_NOT_PRESENT_ANYWHERE"
  | "RULESET_AMBIGUOUS"
  | "WRITE_BLOCKED";

export class ImportError extends Error {
  override readonly cause: unknown;
  constructor(
    message: string,
    public readonly code: ImportErrorCode,
    cause?: unknown,
  ) {
    super(message);
    this.name = "ImportError";
    this.cause = cause;
  }
}
