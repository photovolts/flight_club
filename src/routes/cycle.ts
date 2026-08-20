import { Router } from "express";
import { pool, withTransaction } from "../db";
import { getCurrentWeek, advanceWeek } from "../lib/weeks";

export const cycleRouter = Router();

const admins = () =>
  (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

cycleRouter.get("/", async (_req, res, next) => {
  try {
    res.json({ currentWeek: await getCurrentWeek(pool) });
  } catch (err) {
    next(err);
  }
});

// The one gate in this scaffold that needed a role and had no natural
// owner (no project/team to scope it to) -- everything else derives
// permission from data already on the task or the org chart.
cycleRouter.post("/advance", async (req, res, next) => {
  try {
    const email = req.person?.email?.toLowerCase();
    if (!email || !admins().includes(email)) {
      res.status(403).json({ error: "Only an admin can advance the current week." });
      return;
    }
    const currentWeek = await withTransaction((client) => advanceWeek(client));
    res.json({ currentWeek });
  } catch (err) {
    next(err);
  }
});
