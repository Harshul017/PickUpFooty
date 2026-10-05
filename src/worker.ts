import { Worker } from "bullmq";
import { redis } from "./lib/redis.js";
import { logger } from "./lib/logger.js";
import { db } from "./lib/db.js";

// Request expiry: PENDING -> EXPIRED, guarded by status so a late or
// duplicate run never double-processes a request. Built out fully in
// week 2 alongside the accept/reject endpoints; wired here now so the
// queue → worker path is proven end to end from day one.
const requestExpiryWorker = new Worker(
  "request-expiry",
  async (job) => {
    const { requestId } = job.data as { requestId: string };
    const updated = await db
      .updateTable("join_requests")
      .set({ status: "EXPIRED", decided_at: new Date() })
      .where("id", "=", requestId)
      .where("status", "=", "PENDING")
      .where("expires_at", "<=", new Date())
      .returning("id")
      .executeTakeFirst();

    if (updated) {
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
