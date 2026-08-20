import "dotenv/config";
import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "./db";
import { authRouter, identify } from "./auth";
import { peopleRouter } from "./routes/people";
import { projectsRouter } from "./routes/projects";
import { tasksRouter } from "./routes/tasks";
import { ghostRouter } from "./routes/ghost";
import { cycleRouter } from "./routes/cycle";
import { exportRouter } from "./routes/export";
import { HttpError } from "./errors";

const app = express();
app.use(express.json());

const PgSession = connectPgSimple(session);
app.use(
  session({
    store: new PgSession({ pool, createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET ?? "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  })
);

app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.use("/auth", authRouter);

// Everything under /api requires a resolved identity.
app.use("/api", identify);
app.use("/api/people", peopleRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/tasks", tasksRouter);
app.use("/api/ghost", ghostRouter);
app.use("/api/cycle", cycleRouter);
app.use("/api/export", exportRouter);
app.get("/api/me", (req, res) => res.json(req.person));

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => console.log(`Flight Plan API listening on :${port}`));
