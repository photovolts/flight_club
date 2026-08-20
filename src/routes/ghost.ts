import { Router } from "express";
import { z } from "zod";
import { pool } from "../db";
import { parseBody } from "../lib/validate";
import { getCurrentWeek } from "../lib/weeks";

export const ghostRouter = Router();

ghostRouter.get("/", async (req, res, next) => {
  try {
    const personId = req.query.personId as string | undefined;
    const { rows } = personId
      ? await pool.query("select * from ghost_log where person_id = $1 order by week desc", [personId])
      : await pool.query("select * from ghost_log order by week desc");
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  what: z.string().min(1),
  hours: z.number().nonnegative(),
  week: z.number().int().optional(),
});

// Self-only: logging unplanned work on someone else's behalf is an
// impersonation feature, not a data-entry feature, and doesn't belong here.
ghostRouter.post("/", async (req, res, next) => {
  try {
    const body = parseBody(createSchema, req.body);
    const week = body.week ?? (await getCurrentWeek(pool));
    const { rows } = await pool.query(
      `insert into ghost_log (person_id, what, hours, week) values ($1, $2, $3, $4) returning *`,
      [req.person!.id, body.what, body.hours, week]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});
