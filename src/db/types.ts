import type { ColumnType, Generated } from "kysely";

// Postgres range type, represented as its text form ('[lower,upper)').
export type TsRange = string;

export type Timestamp = ColumnType<Date, Date | string, Date | string>;

// A timestamp with a database default (e.g. now()). GeneratedTimestamp
// would nest one ColumnType in another and break explicit inserts.
export type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface UsersTable {
  id: Generated<string>;
  name: string;
  email: string | null;
  phone: string | null;
  password_hash: string;
  role: "PLAYER" | "ADMIN";
  area: string | null;
  preferred_position: "GK" | "DEF" | "MID" | "FWD" | null;
  preferred_foot: "LEFT" | "RIGHT" | "BOTH" | null;
  created_at: GeneratedTimestamp;
}

export interface PlayerRatingsTable {
  user_id: string;
  rating: number;
  matches_played: Generated<number>;
  is_provisional: Generated<boolean>;
  updated_at: GeneratedTimestamp;
}

export interface FormatsTable {
  id: Generated<string>;
  name: string;
  players_per_side: number;
  default_duration_min: number;
}

export interface VenuesTable {
  id: Generated<string>;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  status: "ACTIVE" | "PENDING" | "INACTIVE";
}

export interface PitchesTable {
  id: Generated<string>;
  venue_id: string;
  name: string;
  max_players_per_side: number;
  surface: "TURF" | "GRASS" | "CONCRETE" | "INDOOR" | null;
}

export interface FormationTemplatesTable {
  id: Generated<string>;
  players_per_side: number;
  name: string;
}

export interface FormationSlotsTable {
  template_id: string;
  slot_code: string;
  role: "GK" | "DEF" | "MID" | "FWD";
  x: number;
  y: number;
}

export interface MatchesTable {
  id: Generated<string>;
  host_id: string;
  pitch_id: string;
  format_id: string | null;
  formation_id: string | null;
  players_per_side: number;
  subs_per_side: Generated<number>;
  capacity: number;
  filled: Generated<number>;
  join_mode: "OPEN" | "APPROVAL";
  min_rating: number | null;
  max_rating: number | null;
  status: "OPEN" | "FULL" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  during: TsRange;
  version: Generated<number>;
  created_at: GeneratedTimestamp;
}

export type MatchPlayerStatus =
  | "JOINED"
  // Holding a freed spot for a short window after a waitlist offer.
  // Counts towards matches.filled exactly like JOINED.
  | "OFFERED"
  | "WAITLISTED"
  | "CANCELLED"
  | "PLAYED"
  | "NO_SHOW";

export interface MatchPlayersTable {
  match_id: string;
  user_id: string;
  team: "A" | "B" | null;
  slot_code: string | null;
  status: MatchPlayerStatus;
  during: TsRange | null;
  waitlist_position: number | null;
  offer_expires_at: Timestamp | null;
  joined_at: GeneratedTimestamp;
}

export interface JoinRequestsTable {
  id: Generated<string>;
  match_id: string;
  user_id: string;
  note: string | null;
  status: "PENDING" | "ACCEPTED" | "REJECTED" | "EXPIRED" | "WITHDRAWN";
  requested_at: GeneratedTimestamp;
  expires_at: Timestamp;
  decided_at: Timestamp | null;
}

export interface BansTable {
  id: Generated<string>;
  user_id: string;
  starts_at: Timestamp;
  ends_at: Timestamp;
  reason: string;
}

export interface ConductEventsTable {
  id: Generated<string>;
  user_id: string;
  match_id: string | null;
  type: "LATE_CANCEL" | "NO_SHOW" | "LATE_ARRIVAL" | "ORGANIZER_LATE_CANCEL";
  created_at: GeneratedTimestamp;
}

export interface DemeritsTable {
  id: Generated<string>;
  user_id: string;
  conduct_event_id: string;
  points: number;
  expires_at: Timestamp;
}

export type MatchResultStatus = "SUBMITTED" | "DISPUTED" | "FINALIZED";

export interface MatchResultsTable {
  match_id: string;
  score_a: number;
  score_b: number;
  submitted_by: string;
  submitted_at: Generated<Timestamp>;
  dispute_deadline: Timestamp;
  status: Generated<MatchResultStatus>;
  finalized_at: Timestamp | null;
  ratings_applied_at: Timestamp | null;
}

export interface PlayerMatchStatsTable {
  match_id: string;
  user_id: string;
  goals: Generated<number>;
  assists: Generated<number>;
  clean_sheet: Generated<boolean>;
}

export interface DisputesTable {
  id: Generated<string>;
  match_id: string;
  raised_by: string;
  reason: string;
  status: Generated<"OPEN" | "RESOLVED" | "WITHDRAWN">;
  resolved_by: string | null;
  resolved_at: Timestamp | null;
}

export interface PeerRatingsTable {
  match_id: string;
  rater_id: string;
  ratee_id: string;
  score: number;
  created_at: Generated<Timestamp>;
}

export interface DB {
  users: UsersTable;
  player_ratings: PlayerRatingsTable;
  formats: FormatsTable;
  venues: VenuesTable;
  pitches: PitchesTable;
  formation_templates: FormationTemplatesTable;
  formation_slots: FormationSlotsTable;
  matches: MatchesTable;
  match_players: MatchPlayersTable;
  join_requests: JoinRequestsTable;
  bans: BansTable;
  conduct_events: ConductEventsTable;
  demerits: DemeritsTable;
  match_results: MatchResultsTable;
  player_match_stats: PlayerMatchStatsTable;
  disputes: DisputesTable;
  peer_ratings: PeerRatingsTable;
}
