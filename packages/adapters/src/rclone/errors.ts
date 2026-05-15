export class RcloneError extends Error {
  override readonly cause: unknown;
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly endpoint: string,
    public readonly upstream?: { input?: unknown; path?: string; status?: number },
    cause?: unknown,
  ) {
    super(message);
    this.name = "RcloneError";
    this.cause = cause;
  }
}
