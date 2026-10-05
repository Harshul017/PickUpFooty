import { buildApp } from "./app.js";
import { env } from "./lib/env.js";
import { logger } from "./lib/logger.js";

const app = buildApp();

app.listen(env.PORT, () => {
  logger.info(`PickupFooty API listening on port ${env.PORT}`);
});
