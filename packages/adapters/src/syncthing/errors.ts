export class SyncthingError extends Error {
  override readonly cause: unknown;
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly endpoint: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "SyncthingError";
    this.cause = cause;
  }
}
