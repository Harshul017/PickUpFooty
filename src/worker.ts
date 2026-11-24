import { Worker } from "bullmq";
import { redis } from "./lib/redis.js";
import { logger } from "./lib/logger.js";
import { waitlistOfferQueue, scheduleOnce } from "./lib/queue.js";
import { finalizeResult } from "./modules/results/service.js";
import { expireRequest } from "./modules/requests/service.js";
import { expireOffer } from "./modules/matches/waitlist.js";

// Request expiry: PENDING -> EXPIRED, guarded by status and by expires_at
// on the database clock, so a late, early or duplicate run never
// double-processes a request or races an accept into two final states.
const requestExpiryWorker = new Worker(
  "request-expiry",
  async (job) => {
    const { requestId } = job.data as { requestId: string };
    const expired = await expireRequest(requestId);

    if (expired) {
      logger.info({ requestId }, "join request expired");
      // TODO: notify the player.
    }
  },
  { connection: redis }
);

// Waitlist offer expiry: the ten minutes ran out, so the spot moves to the
// next player in line. Guarded the same way — a duplicate or late run
// finds no live offer and does nothing.
//
// Passing the spot on creates a fresh offer, which needs its own timer, so
// this job schedules the next one. That chain is what walks a spot down
// the queue when several players in a row ignore it.
const waitlistOfferWorker = new Worker(
  "waitlist-offer",
  async (job) => {
    const { matchId, userId } = job.data as { matchId: string; userId: string };
    const outcome = await expireOffer(matchId, userId);

    if (!outcome) return;
    logger.info({ matchId, userId }, "waitlist offer expired");
    // TODO: notify the player who missed it.

    if (outcome.offer) {
      const { userId: nextUserId, expiresAt } = outcome.offer;
      await scheduleOnce(
        waitlistOfferQueue,
        "expire-offer",
        `${matchId}:${nextUserId}:${expiresAt.getTime()}`,
        { matchId, userId: nextUserId },
        expiresAt.getTime() - Date.now()
      );
      logger.info({ matchId, userId: nextUserId }, "spot offered to the next player");
      // TODO: notify them that a spot is open.
    }
  },
  { connection: redis }
);

// Result finalisation: a result nobody disputed becomes final once its
// 24-hour window closes, and that is when no-shows are charged for.
// Guarded by status and deadline, so a duplicate or late run is a no-op
// and a disputed result is simply left alone for a human.
const matchLifecycleWorker = new Worker(
  "match-lifecycle",
  async (job) => {
    const { matchId } = job.data as { matchId: string };
    const finalized = await finalizeResult(matchId);

    if (finalized) {
      logger.info(
        { matchId, penalised: finalized.penalised.length },
        "result finalised"
      );
      // TODO: notify players; apply ratings once Phase 7 lands.
    }
  },
  { connection: redis }
);

for (const worker of [requestExpiryWorker, waitlistOfferWorker, matchLifecycleWorker]) {
  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "job failed");
  });
}

logger.info("PickupFooty worker started");
