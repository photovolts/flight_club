import { Router } from "express";
import { z } from "zod";
import { pool } from "../db";
import { parseBody } from "../lib/validate";

export const projectsRouter = Router();

projectsRouter.get("/", async (_req, res, next) => {
  try {
    const { rows } = await pool.query("select * from projects order by name");
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  name: z.string().min(1),
  leadId: z.string().uuid(),
  pillar: z.enum(["product", "scale", "perovskite", "barrier"]),
});

projectsRouter.post("/", async (req, res, next) => {
  try {
    const body = parseBody(createSchema, req.body);
    const { rows } = await pool.query(
      `insert into projects (name, lead_id, pillar) values ($1, $2, $3) returning *`,
      [body.name, body.leadId, body.pillar]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

const patchSchema = z.object({
  leadId: z.string().uuid().optional(),
  pillar: z.enum(["product", "scale", "perovskite", "barrier"]).optional(),
});

projectsRouter.patch("/:id", async (req, res, next) => {
  try {
    const body = parseBody(patchSchema, req.body);
    const sets: string[] = [];
    const values: unknown[] = [req.params.id];
    if (body.leadId) {
      values.push(body.leadId);
      sets.push(`lead_id = $${values.length}`);
    }
    if (body.pillar) {
      values.push(body.pillar);
      sets.push(`pillar = $${values.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: "Nothing to update" });
    const { rows } = await pool.query(`update projects set ${sets.join(", ")} where id = $1 returning *`, values);
    if (!rows.length) return res.status(404).json({ error: "Project not found" });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});
