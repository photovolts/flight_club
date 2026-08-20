import { Router, Request } from "express";
import { PoolClient } from "pg";
import { z } from "zod";
import { pool, withTransaction } from "../db";
import { parseBody } from "../lib/validate";
import { logHistory } from "../lib/history";
import { getCurrentWeek } from "../lib/weeks";
import { assertIsOwner, assertIsProjectLead, assertIsEscalationTarget } from "../permissions";
import { badRequest, conflict, notFound } from "../errors";
import { HORIZON_CAPS, EFFORT_BUCKETS, Task } from "../types";

export const tasksRouter = Router();

const EFFORT = z.union(EFFORT_BUCKETS.map((n) => z.literal(n)) as [z.ZodLiteral<number>, ...z.ZodLiteral<number>[]]);
const HORIZON = z.enum(["week", "month", "quarter"]);
const PILLAR = z.enum(["product", "scale", "perovskite", "barrier"]);

async function loadForUpdate(client: PoolClient, id: string): Promise<Task> {
  const { rows } = await client.query<Task>("select * from tasks where id = $1 for update", [id]);
  if (!rows.length) throw notFound("Task");
  return rows[0];
}

/** Every mutating handler goes through here so version bumps and 404/409s are consistent. */
async function applyTaskUpdate(
  client: PoolClient,
  taskId: string,
  expectedVersion: number | undefined,
  fields: Record<string, unknown>
): Promise<Task> {
  const cols = Object.keys(fields);
  const values: unknown[] = [taskId, ...cols.map((c) => fields[c])];
  const setClause = cols.map((c, i) => `${c} = $${i + 2}`).join(", ");
  let sql = `update tasks set ${setClause}, version = version + 1, updated_at = now() where id = $1`;
  if (expectedVersion != null) {
    values.push(expectedVersion);
    sql += ` and version = $${values.length}`;
  }
  sql += " returning *";
  const { rows } = await client.query<Task>(sql, values);
  if (!rows.length) {
    if (expectedVersion != null) throw conflict("Task changed since you last loaded it. Reload and retry.");
    throw notFound("Task");
  }
  return rows[0];
}

/** Mirrors the prototype's `setPrio`: setting #N bumps whoever currently holds it. */
async function setPriority(client: PoolClient, task: Task, newPriority: number | null): Promise<void> {
  if (newPriority != null) {
    const cap = HORIZON_CAPS[task.horizon];
    if (newPriority < 1 || newPriority > cap) {
      throw badRequest(`Priority must be between 1 and ${cap} for a ${task.horizon} task.`);
    }
    await client.query(
      `update tasks set priority = $5, version = version + 1, updated_at = now()
       where owner_id = $1 and horizon = $2 and id <> $3 and priority = $4
         and status in ('proposed','allocated','signed','prog','blocked')`,
      [task.owner_id, task.horizon, task.id, newPriority, task.priority]
    );
  }
  await client.query(`update tasks set priority = $2, version = version + 1, updated_at = now() where id = $1`, [
    task.id,
    newPriority,
  ]);
}

function expectedVersionFrom(req: Request): number | undefined {
  const v = req.body?.version;
  return typeof v === "number" ? v : undefined;
}

/* ── list / read ───────────────────────── */

tasksRouter.get("/", async (req, res, next) => {
  try {
    const filters: string[] = [];
    const values: unknown[] = [];
    for (const [param, col] of [
      ["owner", "owner_id"],
      ["project", "project_id"],
      ["status", "status"],
      ["horizon", "horizon"],
    ] as const) {
      const v = req.query[param];
      if (typeof v === "string") {
        values.push(v);
        filters.push(`${col} = $${values.length}`);
      }
    }
    const where = filters.length ? `where ${filters.join(" and ")}` : "";
    const { rows } = await pool.query<Task>(`select * from tasks ${where} order by created_at`, values);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

tasksRouter.get("/:id", async (req, res, next) => {
  try {
    const { rows } = await pool.query<Task>("select * from tasks where id = $1", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Task not found" });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

tasksRouter.get("/:id/history", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "select * from task_history where task_id = $1 order by at",
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/* ── create ───────────────────────── */

const createSchema = z.object({
  title: z.string().min(1),
  projectId: z.string().uuid(),
  pillar: PILLAR,
  horizon: HORIZON,
  source: z.enum(["self", "lead", "pool"]),
  ownerId: z.string().uuid().nullable().optional(),
  effort: EFFORT,
  note: z.string().optional(),
});

tasksRouter.post("/", async (req, res, next) => {
  try {
    const body = parseBody(createSchema, req.body);
    const task = await withTransaction(async (client) => {
      if (body.source !== "self") {
        // The prototype lets anyone pick "lead" as the source with no
        // check; enforcing it here is the actual point of this rewrite.
        await assertIsProjectLead(client, { project_id: body.projectId }, req.person!.id);
      }
      if (body.source === "lead" && !body.ownerId) {
        throw badRequest("A lead-assigned task needs a named owner. Use source \"pool\" if you don't know who.");
      }
      const currentWeek = await getCurrentWeek(client);
      const ownerId = body.source === "pool" ? null : body.source === "self" ? req.person!.id : body.ownerId!;
      const status = body.source === "self" ? "signed" : body.source === "pool" ? "pool" : "proposed";
      const { rows } = await client.query<Task>(
        `insert into tasks
           (title, project_id, pillar, horizon, owner_id, source, created_by_id,
            effort_assigner, effort_owner, status, note, posted_week)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         returning *`,
        [
          body.title,
          body.projectId,
          body.pillar,
          body.horizon,
          ownerId,
          body.source === "self" ? "self" : "lead",
          req.person!.id,
          body.effort,
          body.source === "self" ? body.effort : null,
          status,
          body.note ?? "",
          body.source === "pool" ? currentWeek : null,
        ]
      );
      await logHistory(client, rows[0].id, req.person!.id, "created", { source: body.source });
      return rows[0];
    });
    res.status(201).json(task);
  } catch (err) {
    next(err);
  }
});

/* ── owner self-service field edits (note / priority / their effort estimate) ── */

const patchSchema = z.object({
  note: z.string().optional(),
  priority: z.number().int().nullable().optional(),
  effortOwner: EFFORT.optional(),
  version: z.number().int().optional(),
});

tasksRouter.patch("/:id", async (req, res, next) => {
  try {
    const body = parseBody(patchSchema, req.body);
    const result = await withTransaction(async (client) => {
      const task = await loadForUpdate(client, req.params.id);
      assertIsOwner(task, req.person!.id);
      if ("priority" in body) await setPriority(client, task, body.priority ?? null);
      const fields: Record<string, unknown> = {};
      if (body.note !== undefined) fields.note = body.note;
      if (body.effortOwner !== undefined) fields.effort_owner = body.effortOwner;
      if (!Object.keys(fields).length) {
        const { rows } = await client.query<Task>("select * from tasks where id = $1", [task.id]);
        return rows[0];
      }
      return applyTaskUpdate(client, task.id, expectedVersionFrom(req), fields);
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/* ── owner: sign up for a proposed/allocated task ───────────────────────── */

const signSchema = z.object({ effortOwner: EFFORT, version: z.number().int().optional() });

tasksRouter.post("/:id/sign", async (req, res, next) => {
  try {
    const body = parseBody(signSchema, req.body);
    const result = await withTransaction(async (client) => {
      const task = await loadForUpdate(client, req.params.id);
      assertIsOwner(task, req.person!.id);
      if (task.status !== "proposed" && task.status !== "allocated") {
        throw badRequest(`Cannot sign up for a task in status "${task.status}".`);
      }
      const updated = await applyTaskUpdate(client, task.id, expectedVersionFrom(req), {
        effort_owner: body.effortOwner,
        status: "signed",
        note: "",
      });
      await logHistory(client, task.id, req.person!.id, "signed", {});
      return updated;
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/* ── owner: decline ───────────────────────── */

const declineSchema = z.object({ reason: z.string().min(1), version: z.number().int().optional() });

tasksRouter.post("/:id/decline", async (req, res, next) => {
  try {
    const body = parseBody(declineSchema, req.body);
    const result = await withTransaction(async (client) => {
      const task = await loadForUpdate(client, req.params.id);
      assertIsOwner(task, req.person!.id);
      const wasAllocated = task.status === "allocated";
      const currentWeek = await getCurrentWeek(client);
      const declinedBy = task.owner_id!;
      const fields: Record<string, unknown> = {
        declined_by_id: declinedBy,
        owner_id: null,
        effort_owner: null,
        priority: null,
        note: body.reason,
      };
      if (wasAllocated) {
        Object.assign(fields, {
          status: "pool",
          posted_week: currentWeek,
          escalated: true,
          escalated_to_id: task.allocated_by_id ?? task.escalated_to_id,
          escalated_subject_id: declinedBy,
          escalated_by_id: declinedBy,
          escalated_week: currentWeek,
          bounced: true,
        });
      } else {
        fields.status = "declined";
      }
      const updated = await applyTaskUpdate(client, task.id, expectedVersionFrom(req), fields);
      await logHistory(client, task.id, req.person!.id, wasAllocated ? "bounced" : "declined", {
        reason: body.reason,
      });
      return updated;
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/* ── owner: status changes (in progress / blocked) ───────────────────────── */

const statusSchema = z.object({
  status: z.enum(["signed", "prog", "blocked"]),
  note: z.string().optional(),
  version: z.number().int().optional(),
});

tasksRouter.post("/:id/status", async (req, res, next) => {
  try {
    const body = parseBody(statusSchema, req.body);
    if (body.status === "blocked" && !body.note) throw badRequest("A reason is required to mark a task blocked.");
    const result = await withTransaction(async (client) => {
      const task = await loadForUpdate(client, req.params.id);
      assertIsOwner(task, req.person!.id);
      const updated = await applyTaskUpdate(client, task.id, expectedVersionFrom(req), {
        status: body.status,
        note: body.note ?? task.note,
      });
      await logHistory(client, task.id, req.person!.id, "status_changed", { to: body.status, note: body.note });
      return updated;
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/* ── owner: tick their side of "done" ───────────────────────── */

const tickOwnerSchema = z.object({
  helpedBy: z.string().uuid().optional(),
  helpedHours: z.number().nonnegative().optional(),
  version: z.number().int().optional(),
});

tasksRouter.post("/:id/tick-owner", async (req, res, next) => {
  try {
    const body = parseBody(tickOwnerSchema, req.body);
    const result = await withTransaction(async (client) => {
      const task = await loadForUpdate(client, req.params.id);
      assertIsOwner(task, req.person!.id);
      if (!["signed", "prog", "blocked"].includes(task.status)) {
        throw badRequest(`Cannot tick done from status "${task.status}".`);
      }
      const currentWeek = await getCurrentWeek(client);
      if (body.helpedBy && body.helpedHours) {
        await client.query(
          `insert into task_help (task_id, person_id, hours) values ($1,$2,$3)
           on conflict (task_id, person_id) do update set hours = excluded.hours`,
          [task.id, body.helpedBy, body.helpedHours]
        );
      }
      const bothTicked = task.done_lead_week != null;
      const updated = await applyTaskUpdate(client, task.id, expectedVersionFrom(req), {
        done_owner_week: currentWeek,
        status: bothTicked ? "done" : "await",
        done_week: bothTicked ? currentWeek : null,
      });
      await logHistory(client, task.id, req.person!.id, "ticked_owner", {});
      return updated;
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

tasksRouter.post("/:id/untick-owner", async (req, res, next) => {
  try {
    const result = await withTransaction(async (client) => {
      const task = await loadForUpdate(client, req.params.id);
      assertIsOwner(task, req.person!.id);
      if (task.status !== "await" || task.done_owner_week == null) {
        throw badRequest("Nothing to undo -- you haven't ticked this task.");
      }
      const updated = await applyTaskUpdate(client, task.id, expectedVersionFrom(req), {
        done_owner_week: null,
        status: task.done_lead_week != null ? "await" : "prog",
      });
      await logHistory(client, task.id, req.person!.id, "unticked_owner", {});
      return updated;
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Owner disputes the project lead's completion claim.
const rejectSchema = z.object({ reason: z.string().optional(), version: z.number().int().optional() });

tasksRouter.post("/:id/reject-owner", async (req, res, next) => {
  try {
    const body = parseBody(rejectSchema, req.body);
    const result = await withTransaction(async (client) => {
      const task = await loadForUpdate(client, req.params.id);
      assertIsOwner(task, req.person!.id);
      if (task.status !== "await" || task.done_lead_week == null || task.done_owner_week != null) {
        throw badRequest("This task isn't waiting on your response to the project lead's tick.");
      }
      const updated = await applyTaskUpdate(client, task.id, expectedVersionFrom(req), {
        done_lead_week: null,
        status: "prog",
        note: body.reason ?? task.note,
      });
      await logHistory(client, task.id, req.person!.id, "owner_rejected_lead_tick", { reason: body.reason });
      return updated;
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/* ── project lead: approve / send back close-out ───────────────────────── */

tasksRouter.post("/:id/tick-lead", async (req, res, next) => {
  try {
    const result = await withTransaction(async (client) => {
      const task = await loadForUpdate(client, req.params.id);
      await assertIsProjectLead(client, task, req.person!.id);
      if (task.status !== "await" || task.done_lead_week != null) {
        throw badRequest("This task isn't waiting on your approval.");
      }
      const currentWeek = await getCurrentWeek(client);
      const bothTicked = task.done_owner_week != null;
      const updated = await applyTaskUpdate(client, task.id, expectedVersionFrom(req), {
        done_lead_week: currentWeek,
        status: bothTicked ? "done" : "await",
        done_week: bothTicked ? currentWeek : null,
      });
      await logHistory(client, task.id, req.person!.id, "ticked_lead", {});
      return updated;
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

tasksRouter.post("/:id/reject-lead", async (req, res, next) => {
  try {
    const body = parseBody(rejectSchema, req.body);
    const result = await withTransaction(async (client) => {
      const task = await loadForUpdate(client, req.params.id);
      await assertIsProjectLead(client, task, req.person!.id);
      if (task.status !== "await" || task.done_lead_week != null) {
        throw badRequest("This task isn't waiting on your approval.");
      }
      const updated = await applyTaskUpdate(client, task.id, expectedVersionFrom(req), {
        done_owner_week: null,
        done_lead_week: null,
        status: "prog",
        note: body.reason ?? "Project lead sent it back as not complete.",
      });
      await logHistory(client, task.id, req.person!.id, "lead_rejected_owner_tick", { reason: body.reason });
      return updated;
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/* ── project lead: triage unresourced work ───────────────────────── */

const reassignSchema = z.object({ ownerId: z.string().uuid(), version: z.number().int().optional() });

tasksRouter.post("/:id/reassign", async (req, res, next) => {
  try {
    const body = parseBody(reassignSchema, req.body);
    const result = await withTransaction(async (client) => {
      const task = await loadForUpdate(client, req.params.id);
      await assertIsProjectLead(client, task, req.person!.id);
      if (!["declined", "pool"].includes(task.status)) throw badRequest("Only unresourced work can be reassigned.");
      const updated = await applyTaskUpdate(client, task.id, expectedVersionFrom(req), {
        owner_id: body.ownerId,
        effort_owner: null,
        status: "proposed",
        escalated: false,
        posted_week: null,
        note: "Reassigned by the project lead.",
      });
      await logHistory(client, task.id, req.person!.id, "reassigned", { to: body.ownerId });
      return updated;
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

tasksRouter.post("/:id/to-pool", async (req, res, next) => {
  try {
    const result = await withTransaction(async (client) => {
      const task = await loadForUpdate(client, req.params.id);
      await assertIsProjectLead(client, task, req.person!.id);
      const currentWeek = await getCurrentWeek(client);
      const updated = await applyTaskUpdate(client, task.id, expectedVersionFrom(req), {
        owner_id: null,
        effort_owner: null,
        status: "pool",
        posted_week: currentWeek,
        escalated: false,
        note: "Put back in the pool -- open to anyone.",
      });
      await logHistory(client, task.id, req.person!.id, "to_pool", {});
      return updated;
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

const escalateSchema = z.object({ escalatedTo: z.string().uuid().optional() });

tasksRouter.post("/:id/escalate", async (req, res, next) => {
  try {
    const body = parseBody(escalateSchema, req.body);
    const result = await withTransaction(async (client) => {
      const task = await loadForUpdate(client, req.params.id);
      await assertIsProjectLead(client, task, req.person!.id);
      if (!["declined", "pool"].includes(task.status)) throw badRequest("Only unresourced work can be escalated.");
      const currentWeek = await getCurrentWeek(client);
      const subjectId = task.escalated_subject_id ?? task.declined_by_id ?? task.owner_id;

      let escalatedTo = body.escalatedTo;
      if (!escalatedTo && subjectId) {
        const { rows } = await client.query<{ reports_to: string | null }>(
          "select reports_to from people where id = $1",
          [subjectId]
        );
        escalatedTo = rows[0]?.reports_to ?? undefined;
      }
      if (!escalatedTo) {
        const { rows } = await client.query<{ reports_to: string | null }>(
          "select p.reports_to from projects pr join people p on p.id = pr.lead_id where pr.id = $1",
          [task.project_id]
        );
        escalatedTo = rows[0]?.reports_to ?? undefined;
      }
      if (!escalatedTo) {
        throw badRequest("Could not work out who to escalate to -- pass escalatedTo explicitly.");
      }

      const updated = await applyTaskUpdate(client, task.id, expectedVersionFrom(req), {
        escalated: true,
        escalated_by_id: req.person!.id,
        escalated_to_id: escalatedTo,
        escalated_subject_id: subjectId,
        escalated_week: currentWeek,
      });
      await logHistory(client, task.id, req.person!.id, "escalated", { to: escalatedTo, subject: subjectId });
      return updated;
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

tasksRouter.post("/:id/unescalate", async (req, res, next) => {
  try {
    const result = await withTransaction(async (client) => {
      const task = await loadForUpdate(client, req.params.id);
      await assertIsProjectLead(client, task, req.person!.id);
      const updated = await applyTaskUpdate(client, task.id, expectedVersionFrom(req), {
        escalated: false,
        escalated_to_id: null,
        escalated_week: null,
      });
      await logHistory(client, task.id, req.person!.id, "unescalated", {});
      return updated;
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/* ── team lead: allocation meeting ───────────────────────── */

const allocateSchema = z.object({
  ownerId: z.string().uuid(),
  reason: z.string().min(1, "A reason is required -- that's the whole point of recording the override."),
  version: z.number().int().optional(),
});

tasksRouter.post("/:id/allocate", async (req, res, next) => {
  try {
    const body = parseBody(allocateSchema, req.body);
    const result = await withTransaction(async (client) => {
      const task = await loadForUpdate(client, req.params.id);
      assertIsEscalationTarget(task, req.person!.id);
      const currentWeek = await getCurrentWeek(client);
      const updated = await applyTaskUpdate(client, task.id, expectedVersionFrom(req), {
        owner_id: body.ownerId,
        effort_owner: null,
        status: "allocated",
        escalated: false,
        bounced: false,
        posted_week: null,
        escalated_to_id: null,
        escalated_week: null,
        allocated_by_id: req.person!.id,
        allocated_week: currentWeek,
        alloc_reason: body.reason,
        note: "",
      });
      await logHistory(client, task.id, req.person!.id, "allocated", { to: body.ownerId, reason: body.reason });
      return updated;
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

const parkSchema = z.object({ reason: z.string().min(1), version: z.number().int().optional() });

tasksRouter.post("/:id/park", async (req, res, next) => {
  try {
    const body = parseBody(parkSchema, req.body);
    const result = await withTransaction(async (client) => {
      const task = await loadForUpdate(client, req.params.id);
      assertIsEscalationTarget(task, req.person!.id);
      const currentWeek = await getCurrentWeek(client);
      const updated = await applyTaskUpdate(client, task.id, expectedVersionFrom(req), {
        owner_id: null,
        status: "pool",
        posted_week: currentWeek,
        escalated: false,
        bounced: false,
        escalated_to_id: null,
        escalated_week: null,
        note: body.reason,
      });
      await logHistory(client, task.id, req.person!.id, "parked", { reason: body.reason });
      return updated;
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/* ── anyone: claim from the pool ───────────────────────── */

const claimSchema = z.object({ effortOwner: EFFORT, version: z.number().int().optional() });

tasksRouter.post("/:id/claim", async (req, res, next) => {
  try {
    const body = parseBody(claimSchema, req.body);
    const result = await withTransaction(async (client) => {
      const task = await loadForUpdate(client, req.params.id);
      if (task.status !== "pool") throw badRequest("Only pool tasks can be claimed.");
      const updated = await applyTaskUpdate(client, task.id, expectedVersionFrom(req), {
        owner_id: req.person!.id,
        effort_owner: body.effortOwner,
        status: "signed",
        posted_week: null,
      });
      await logHistory(client, task.id, req.person!.id, "claimed", {});
      return updated;
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});
