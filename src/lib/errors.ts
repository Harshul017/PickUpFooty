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
  playerOverlap: (message = "You are already in another match at an overlapping time") =>
    new AppError(409, "PLAYER_OVERLAP", message),
  alreadyInMatch: () => new AppError(409, "ALREADY_IN_MATCH", "Already joined or waitlisted in this match"),
  matchNotOpen: () => new AppError(409, "MATCH_NOT_OPEN", "This match is no longer open"),
  requestsClosed: () =>
    new AppError(409, "REQUESTS_CLOSED", "Join requests close 90 minutes before kickoff"),
  requestAlreadyPending: () =>
    new AppError(409, "REQUEST_ALREADY_PENDING", "You already have a pending request for this match"),
  requestNotPending: () =>
    new AppError(409, "REQUEST_NOT_PENDING", "Request already decided or expired"),
  banned: (until: Date) => new AppError(403, "BANNED", `You are banned until ${until.toISOString()}`),
  playerBanned: (until: Date) =>
    new AppError(403, "BANNED", `This player is banned until ${until.toISOString()}`),
  notInMatch: () => new AppError(409, "NOT_IN_MATCH", "You are not currently in this match"),
  hostCannotLeave: () =>
    new AppError(400, "HOST_CANNOT_LEAVE", "The organizer cannot leave; cancel the match instead"),
  noLiveOffer: () =>
    new AppError(409, "NO_LIVE_OFFER", "You have no open offer for this match, or it has expired"),
  slotTaken: () => new AppError(409, "SLOT_TAKEN", "Someone already took that position"),
  unknownSlot: (slotCode: string) =>
    new AppError(400, "UNKNOWN_SLOT", `This match's formation has no position "${slotCode}"`),
  noFormation: () =>
    new AppError(409, "NO_FORMATION", "This match has no formation set, so it has no positions yet"),
  ratingOutOfRange: (message: string) => new AppError(403, "RATING_OUT_OF_RANGE", message),
};
