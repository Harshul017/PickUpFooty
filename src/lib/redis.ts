import { Redis } from "ioredis";
import { env } from "./env.js";

// BullMQ requires this exact option on the connection it's given.
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});
