export class AppError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const Errors = {
  notFound: (what: string) => new AppError(404, "NOT_FOUND", `${what} not found`),
  badRequest: (message: string) => new AppError(400, "BAD_REQUEST", message),
  unauthorized: (message = "Unauthorized") => new AppError(401, "UNAUTHORIZED", message),
  forbidden: (message = "Forbidden") => new AppError(403, "FORBIDDEN", message),
  conflict: (message: string) => new AppError(409, "CONFLICT", message),
  matchFull: () => new AppError(409, "MATCH_FULL", "This match is already full"),
  pitchClash: () => new AppError(409, "PITCH_CLASH", "That pitch is already booked for an overlapping time"),
  playerOverlap: () => new AppError(409, "PLAYER_OVERLAP", "You are already in another match at an overlapping time"),
  banned: (until: Date) => new AppError(403, "BANNED", `You are banned until ${until.toISOString()}`),
};
