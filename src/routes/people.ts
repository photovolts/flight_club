import { Router } from "express";
import { z } from "zod";
import { pool } from "../db";
import { parseBody } from "../lib/validate";

export const peopleRouter = Router();

peopleRouter.get("/", async (_req, res, next) => {
  try {
    const { rows } = await pool.query("select * from people order by name");
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Scopes the allocation-meeting view: "who reports to me" is the only
// team-lead-specific query the app needs beyond plain task filters.
peopleRouter.get("/me/reports", async (req, res, next) => {
  try {
    const { rows } = await pool.query("select * from people where reports_to = $1 order by name", [
      req.person!.id,
    ]);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
  reportsTo: z.string().uuid().nullable().optional(),
  team: z.string().optional(),
});

// Open to any authenticated user, matching the prototype's People & Roles
// tab. Worth gating behind an admin role before this leaves the sandbox.
peopleRouter.post("/", async (req, res, next) => {
  try {
    const body = parseBody(createSchema, req.body);
    const { rows } = await pool.query(
      `insert into people (name, email, reports_to, team) values ($1, $2, $3, $4) returning *`,
      [body.name, body.email ?? null, body.reportsTo ?? null, body.team ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

const patchSchema = z.object({
  reportsTo: z.string().uuid().nullable().optional(),
  team: z.string().optional(),
});

peopleRouter.patch("/:id", async (req, res, next) => {
  try {
    const body = parseBody(patchSchema, req.body);
    const sets: string[] = [];
    const values: unknown[] = [req.params.id];
    if ("reportsTo" in body) {
      values.push(body.reportsTo ?? null);
      sets.push(`reports_to = $${values.length}`);
    }
    if ("team" in body) {
      values.push(body.team ?? null);
      sets.push(`team = $${values.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: "Nothing to update" });
    const { rows } = await pool.query(`update people set ${sets.join(", ")} where id = $1 returning *`, values);
    if (!rows.length) return res.status(404).json({ error: "Person not found" });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});
