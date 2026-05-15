export class SymphonyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly causeValue?: unknown
  ) {
    super(message);
    this.name = "SymphonyError";
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
