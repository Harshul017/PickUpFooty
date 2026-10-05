import express from "express";
import cors from "cors";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { ZodError } from "zod";
import { logger } from "./lib/logger.js";
import { AppError } from "./lib/errors.js";
import { authRouter } from "./modules/auth/routes.js";
import { venuesRouter } from "./modules/venues/routes.js";
import { matchesRouter } from "./modules/matches/routes.js";
import { requestsRouter } from "./modules/requests/routes.js";

export function buildApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json());
  app.use(pinoHttp({ logger }));

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1", venuesRouter);
  app.use("/api/v1", matchesRouter);
  app.use("/api/v1", requestsRouter);

  app.use((req, res) => {
    res.status(404).json({ code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` });
  });

  // Central error handler: every route calls next(err) on failure, so
  // response shape stays consistent across the whole API.
  app.use(
    (err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (err instanceof AppError) {
        return res.status(err.status).json({ code: err.code, message: err.message });
      }
      if (err instanceof ZodError) {
        const message = err.issues
          .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
          .join("; ");
        return res.status(400).json({ code: "VALIDATION_ERROR", message });
      }
      req.log?.error({ err }, "unhandled error");
      res.status(500).json({ code: "INTERNAL_ERROR", message: "Something went wrong" });
    }
  );

  return app;
}
