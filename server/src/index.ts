import express from "express";
import path from "node:path";
import cors from "cors";
import helmet from "helmet";
import { config } from "./config.js";
import { pool } from "./db/pool.js";
import { requestId, rateLimit } from "./security.js";
import { healthRouter } from "./routes/health.js";
import { authRouter } from "./routes/auth.js";
import { challengesRouter } from "./routes/challenges.js";
import { collaborationRouter } from "./routes/collaboration.js";
import { lifecycleRouter } from "./routes/lifecycle.js";
import { communicationRouter } from "./routes/communication.js";
import { sosRouter } from "./routes/sos.js";
import { governmentRouter } from "./routes/government.js";

const app = express();

app.disable("x-powered-by");

if (config.trustProxy) {
  app.set("trust proxy", 1);
}

/*
 * ---------------------------------------------------------
 * BASIC SECURITY / REQUEST IDENTIFICATION
 * ---------------------------------------------------------
 */

app.use(requestId);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

/*
 * ---------------------------------------------------------
 * FRONTEND STATIC FILES
 * ---------------------------------------------------------
 *
 * Render runs:
 *
 *   npm --prefix server run start
 *
 * which means process.cwd() is:
 *
 *   /opt/render/project/src/server
 *
 * Therefore:
 *
 *   ../client/dist
 *
 * correctly resolves to:
 *
 *   /opt/render/project/src/client/dist
 *
 * IMPORTANT:
 * Static frontend files are served BEFORE API CORS/rate-limit
 * middleware so browser requests for JS/CSS are not rejected
 * by API CORS rules.
 */

const clientDist = path.resolve(process.cwd(), "../client/dist");
const clientIndex = path.join(clientDist, "index.html");

app.use(express.static(clientDist));

app.get("/", (_req, res) => {
  res.sendFile(clientIndex);
});

/*
 * ---------------------------------------------------------
 * API CORS
 * ---------------------------------------------------------
 */

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || config.clientOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Origin not allowed"));
    },

    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],

    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Request-Id",
    ],

    maxAge: 86400,
  })
);

/*
 * ---------------------------------------------------------
 * BODY PARSING
 * ---------------------------------------------------------
 */

app.use(
  express.json({
    limit: config.maxJsonBytes,
  })
);

app.use(
  express.urlencoded({
    extended: false,
    limit: "1mb",
  })
);

/*
 * ---------------------------------------------------------
 * API RATE LIMITING
 * ---------------------------------------------------------
 */

const generalLimit = rateLimit({
  windowMs: 60_000,
  max: 180,
});

const authLimit = rateLimit({
  windowMs: 15 * 60_000,
  max: 30,
  message:
    "Too many authentication attempts. Please wait and try again.",
});

app.use("/api", generalLimit);

app.use("/api/auth/login", authLimit);
app.use("/api/auth/signup", authLimit);
app.use("/api/auth/refresh", authLimit);

/*
 * ---------------------------------------------------------
 * API ROUTES
 * ---------------------------------------------------------
 */

app.use("/api/health", healthRouter);

app.use("/api/auth", authRouter);

app.use("/api/challenges", challengesRouter);

app.use("/api/collaboration", collaborationRouter);

app.use("/api/lifecycle", lifecycleRouter);

app.use("/api/communication", communicationRouter);

app.use("/api/sos", sosRouter);

app.use("/api/government", governmentRouter);

/*
 * ---------------------------------------------------------
 * SPA FALLBACK + API 404
 * ---------------------------------------------------------
 *
 * React Router / client-side routes such as:
 *
 *   /login
 *   /dashboard
 *   /challenges
 *   /government
 *
 * should receive index.html.
 *
 * API routes that don't exist should instead receive JSON 404.
 */

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({
      error: "Route not found",
    });
  }

  return res.sendFile(clientIndex);
});

/*
 * ---------------------------------------------------------
 * GLOBAL ERROR HANDLER
 * ---------------------------------------------------------
 */

app.use(
  (
    error: unknown,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    const uploadCode =
      error instanceof Error && "code" in error
        ? String(
            (error as { code?: unknown }).code
          )
        : "";

    /*
     * Multer upload errors
     */
    if (
      [
        "LIMIT_FILE_SIZE",
        "LIMIT_FILE_COUNT",
        "LIMIT_UNEXPECTED_FILE",
      ].includes(uploadCode)
    ) {
      const message =
        uploadCode === "LIMIT_FILE_SIZE"
          ? "Uploaded file is too large."
          : uploadCode === "LIMIT_FILE_COUNT"
            ? "Too many files."
            : "Upload could not be processed.";

      return res.status(400).json({
        error: message,
        requestId: res.locals.requestId,
      });
    }

    /*
     * CORS error
     */
    if (
      error instanceof Error &&
      error.message === "Origin not allowed"
    ) {
      return res.status(403).json({
        error: "Origin not allowed",
        requestId: res.locals.requestId,
      });
    }

    /*
     * Unexpected server error
     */
    console.error(
      `[${res.locals.requestId ?? "no-request-id"}]`,
      error,
      {
        method: req.method,
        path: req.path,
      }
    );

    return res.status(500).json({
      error: "Internal server error",
      requestId: res.locals.requestId,
    });
  }
);

/*
 * ---------------------------------------------------------
 * START SERVER
 * ---------------------------------------------------------
 */

const server = app.listen(config.port, () => {
  console.log(`API listening on port ${config.port}`);
});

/*
 * ---------------------------------------------------------
 * GRACEFUL SHUTDOWN
 * ---------------------------------------------------------
 */

async function shutdown(signal: string) {
  console.log(
    `${signal} received; shutting down gracefully.`
  );

  server.close(async () => {
    await pool.end();
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 10_000);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));

process.on("SIGINT", () => void shutdown("SIGINT"));