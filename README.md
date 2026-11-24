# PickupFooty

A backend for organizing local football matches: create or join a match,
get auto-balanced into a lineup, play, and see your skill rating update
from the real result. Built as a backend-engineering showcase — the
interesting parts are enforced by PostgreSQL itself, not by application
code that could be bypassed.

Full design doc: see `docs/design.md` 

## What's actually enforced by the database, not just the app

- **No double-booked pitch.** A `matches` row can't be inserted if its
  time range overlaps another non-cancelled match on the same pitch —
  a Postgres `EXCLUDE USING gist` constraint, not an application check.
- **No player in two places at once.** The same exclusion-constraint
  trick on `match_players`, keyed on the player instead of the pitch.
- **No overfilled match.** Joining is one atomic
  `UPDATE ... WHERE filled < capacity`; a `CHECK (filled <= capacity)`
  constraint is the last line of defense.
- **No duplicate pending request.** A partial unique index allows only
  one `PENDING` join request per player per match.
- **No spot held without a deadline.** A freed spot is offered to the next
  player in line under an `OFFERED` row, and a check constraint ties that
  state to an expiry: `(status = 'OFFERED') = (offer_expires_at IS NOT NULL)`.
  So `matches.filled` always equals `JOINED + OFFERED`, and a spot can
  never be quietly held forever.
- **No two players in one position.** A partial unique index on
  `(match, team, slot)` settles a contested position, so two players
  tapping goalkeeper at the same instant can't both end up in goal.

See `tests/concurrency/last-spot.test.ts` for a test that fires 200
simultaneous join attempts at a 10-spot match and asserts exactly 10
succeed, against a real (disposable) Postgres instance.

## Stack

Node.js, TypeScript, Express, Kysely (Postgres), Redis, BullMQ, Zod,
Vitest + Testcontainers. See the design doc for the full rationale.

## Running locally

```bash
cp .env.example .env
docker compose up -d postgres redis
npm install
npm run migrate
npm run seed
npm run dev        # API on http://localhost:3000
npm run worker     # in a second terminal
```

Or run everything in containers:

```bash
cp .env.example .env
docker compose up --build
```

## Testing

```bash
npm test                    # everything, including concurrency tests
npm run test:concurrency    # just the concurrency suite (needs Docker)
npm run typecheck
npm run lint
```

The concurrency tests spin up a throwaway Postgres via Testcontainers, so
Docker must be running, but no manual setup is needed.

## Project layout

```text
src/
  modules/        one folder per domain: auth, venues, matches, ...
    <module>/     routes.ts, service.ts (+ tokens.ts, middleware.ts for auth)
  jobs/           background job processors (registered from worker.ts)
  db/             migrations/, seed.ts, types.ts (Kysely schema), migrate.ts
  lib/            db, redis, queue, errors, time, env, logger
tests/
  integration/    unit and integration tests
  concurrency/    tests against a real Postgres via Testcontainers
load/             k6 load-test scripts (added in week 4)
```

## Status

Built and tested: accounts, venues and pitches, match creation, open joins
with a waitlist, organizer approval of join requests with automatic
expiry, leaving a match with the late-cancellation penalty ladder and
waitlist promotion, lineups on a formation, result submission, the
24-hour dispute window with automatic finalisation, and peer ratings.

Next: the rating engine and the weekly leaderboard. See the design doc
for the full plan.

## API reference (current)

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/api/v1/auth/signup` | — | `skillLevel` sets the starting rating |
| POST | `/api/v1/auth/login` | — | by email or phone |
| POST | `/api/v1/auth/refresh` | — | |
| GET | `/api/v1/formats` | — | |
| GET | `/api/v1/venues` | — | |
| GET | `/api/v1/venues/:id/pitches` | — | |
| GET | `/api/v1/pitches/:id/availability?date=` | — | booked ranges for that day |
| POST | `/api/v1/matches` | Player | rejects on pitch clash (409) |
| GET | `/api/v1/matches?cursor=&format=&limit=` | — | keyset pagination |
| POST | `/api/v1/matches/:id/join` | Player | 200 joined, 202 waitlisted; 403 `BANNED` or `RATING_OUT_OF_RANGE` |
| POST | `/api/v1/matches/:id/requests` | Player | APPROVAL matches only; optional `note` (max 280); 409 if one is already pending; 403 `BANNED` or `RATING_OUT_OF_RANGE` |
| GET | `/api/v1/matches/:id/requests` | Host | pending, unexpired requests, oldest first, with name and rating |
| POST | `/api/v1/requests/:id/accept` | Host | 200 joined, 202 waitlisted; 409 if already decided or expired; 403 `BANNED` or `RATING_OUT_OF_RANGE` if the player is no longer eligible |
| POST | `/api/v1/requests/:id/reject` | Host | 409 if already decided or expired |
| POST | `/api/v1/requests/:id/withdraw` | Requester | 409 if already decided or expired |
| POST | `/api/v1/matches/:id/leave` | Player | returns any penalty applied; 400 for the host, 409 if not in the match |
| POST | `/api/v1/matches/:id/waitlist/confirm` | Offered player | takes the spot; 409 `NO_LIVE_OFFER` once the window closes |
| POST | `/api/v1/matches/:id/waitlist/decline` | Offered player | passes the spot to the next player in line |
| GET | `/api/v1/me/discipline` | Player | own warnings, demerit points, active ban, and what the next late cancel would cost |
| GET | `/api/v1/matches/:id/lineup` | — | every position, who is in it, and who is spare |
| PUT | `/api/v1/matches/:id/formation` | Host | must match the match size; clears the pitch |
| POST | `/api/v1/matches/:id/lineup` | Player | take a position; 409 `SLOT_TAKEN`. Host may name another player |
| POST | `/api/v1/matches/:id/lineup/clear` | Player | step off the pitch without leaving the match |
| POST | `/api/v1/matches/:id/result` | Host | goals must add up to the score; one submission only |
| GET | `/api/v1/matches/:id/result` | — | score plus every player's line |
| POST | `/api/v1/matches/:id/disputes` | Participant | freezes the result; 409 once the window closes |
| GET | `/api/v1/matches/:id/disputes` | Player | objections raised about a match |
| PATCH | `/api/v1/admin/matches/:id/dispute` | Admin | `DISMISSED` finalises it, `UPHELD` voids it for resubmission |
| POST | `/api/v1/matches/:id/ratings` | Participant | rate teammates 1-5 within 48 hours; may report lateness |

More endpoints land as each week's features are built — see the design
doc's API section for the full planned surface.
