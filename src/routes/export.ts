import { Router } from "express";
import { pool } from "../db";
import { getCurrentWeek } from "../lib/weeks";

export const exportRouter = Router();

// A relational equivalent of the old "Export JSON" button, kept for the
// same reason it existed before: a manual backup / inspection path, now
// id-based instead of name-based. The one-time inbound migration from an
// old localStorage export lives in scripts/migrate-from-export.ts instead
// of trying to make this endpoint round-trip the legacy name-keyed shape.
exportRouter.get("/", async (_req, res, next) => {
  try {
    const [people, projects, tasks, ghost, currentWeek] = await Promise.all([
      pool.query("select * from people order by name"),
      pool.query("select * from projects order by name"),
      pool.query("select * from tasks order by created_at"),
      pool.query("select * from ghost_log order by week"),
      getCurrentWeek(pool),
    ]);
    res.json({
      exportedAt: new Date().toISOString(),
      currentWeek,
      people: people.rows,
      projects: projects.rows,
      tasks: tasks.rows,
      ghost: ghost.rows,
    });
  } catch (err) {
    next(err);
  }
});
