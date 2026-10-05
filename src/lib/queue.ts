import { Queue } from "bullmq";
import { redis } from "./redis.js";

const defaultJobOptions = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 5_000 },
  removeOnComplete: 1000,
  removeOnFail: false,
};

export const requestExpiryQueue = new Queue("request-expiry", {
  connection: redis,
  defaultJobOptions,
});

export const waitlistOfferQueue = new Queue("waitlist-offer", {
  connection: redis,
  defaultJobOptions,
});

export const matchLifecycleQueue = new Queue("match-lifecycle", {
  connection: redis,
  defaultJobOptions,
});

export const sweeperQueue = new Queue("sweeper", {
  connection: redis,
  defaultJobOptions,
});

/**
 * Enqueue a delayed job whose id is deterministic, so scheduling the same
 * job twice (e.g. on a retried request) never produces two jobs.
 */
export async function scheduleOnce(
  queue: Queue,
  jobName: string,
  jobId: string,
  data: Record<string, unknown>,
  delayMs: number
) {
  await queue.add(jobName, data, { jobId, delay: Math.max(delayMs, 0) });
}
