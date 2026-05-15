export interface OutputCtx {
  json: boolean;
}

export function emit(ctx: OutputCtx, human: string, json: unknown): void {
  if (ctx.json) {
    process.stdout.write(`${JSON.stringify(json)}\n`);
  } else {
    process.stdout.write(`${human}\n`);
  }
}

export function fail(ctx: OutputCtx, message: string, exitCode = 1): never {
  if (ctx.json) {
    process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exit(exitCode);
}
