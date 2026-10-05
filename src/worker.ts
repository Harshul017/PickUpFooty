import { Worker } from "bullmq";
import { redis } from "./lib/redis.js";
import { logger } from "./lib/logger.js";
import { expireRequest } from "./modules/requests/service.js";

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
      // TODO (week 2): notify the player.
    }
  },
  { connection: redis }
);

for (const worker of [requestExpiryWorker]) {
  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "job failed");
  });
}

logger.info("PickupFooty worker started");
