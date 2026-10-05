// Postgres SQLSTATE codes the app maps to domain errors.
export const PG_UNIQUE_VIOLATION = "23505";
export const PG_EXCLUSION_VIOLATION = "23P01";

export function isPgError(err: unknown): err is { code: string; constraint?: string } {
  return typeof err === "object" && err !== null && "code" in err;
}
