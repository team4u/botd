/** CLI-wide error type. `status` mirrors the Hub HTTP status when available. */
export class CliError extends Error {
  readonly status: number;

  constructor(message: string, status = 1) {
    super(message);
    this.name = 'CliError';
    this.status = status;
  }
}

export function describeError(error: unknown): { message: string; status: number } {
  if (error instanceof CliError) {
    return { message: error.message, status: error.status };
  }
  if (error instanceof Error) {
    const status = typeof (error as Error & { status?: number }).status === 'number'
      ? (error as Error & { status: number }).status
      : 1;
    return { message: error.message || String(error), status };
  }
  return { message: String(error), status: 1 };
}
