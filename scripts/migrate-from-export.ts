/**
 * One-time importer for a JSON file produced by the prototype's
 * "Export JSON" button (name-keyed people/projects/tasks/ghost arrays).
 * Everything downstream of this script uses uuids, so its whole job is
 * building a name -> uuid lookup and rewriting references through it.
 *
 * Usage: tsx scripts/migrate-from-export.ts path/to/flight-plan-export.json [--week=34]
 */
import "dotenv/config";
import { readFileSync } from "fs";
import { Pool } from "pg";

interface LegacyTask {
  title: string;
  project: string;
  pillar: string;
  horizon: string;
  owner: string | null;
  source: string;
  by: string;
  ea: number | null;
  eo: number | null;
  status: string;
  note?: string;
  prio?: number | null;
  posted?: number | null;
  declinedBy?: string | null;
  escalated?: boolean;
  escalatedBy?: string | null;
  escalatedTo?: string | null;
  escalatedSubject?: string | null;
  escalatedWk?: number | null;
  bounced?: boolean;
  allocatedBy?: string | null;
  allocatedAt?: number | null;
  allocReason?: string | null;
  dOwner?: number | null;
  dLead?: number | null;
  done?: number | null;
  help?: { who: string; hrs: number }[];
  hist?: string[];
}

interface LegacyExport {
  people: { name: string; reportsTo: string | null; team?: string }[];
  projects: { name: string; lead: string; pillar: string }[];
  tasks: LegacyTask[];
  ghost: { who: string; what: string; hrs: number; wk: number }[];
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: tsx scripts/migrate-from-export.ts <export.json> [--week=34]");
    process.exit(1);
  }
  const weekArg = process.argv.find((a) => a.startsWith("--week="));
  const currentWeek = weekArg ? Number(weekArg.split("=")[1]) : undefined;

  const data: LegacyExport = JSON.parse(readFileSync(file, "utf8"));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const idByName = new Map<string, string>();
    for (const p of data.people) {
      const { rows } = await client.query<{ id: string }>(
        `insert into people (name, team) values ($1, $2) returning id`,
        [p.name, p.team ?? null]
      );
      idByName.set(p.name, rows[0].id);
    }
    // second pass: reports_to may reference a person inserted after it
    for (const p of data.people) {
      if (p.reportsTo) {
        await client.query(`update people set reports_to = $1 where id = $2`, [
          idByName.get(p.reportsTo),
          idByName.get(p.name),
        ]);
      }
    }

    const projectIdByName = new Map<string, string>();
    for (const pr of data.projects) {
      const leadId = idByName.get(pr.lead);
      if (!leadId) throw new Error(`Project "${pr.name}" has unknown lead "${pr.lead}"`);
      const { rows } = await client.query<{ id: string }>(
        `insert into projects (name, lead_id, pillar) values ($1, $2, $3) returning id`,
        [pr.name, leadId, pr.pillar]
      );
      projectIdByName.set(pr.name, rows[0].id);
    }

    const personId = (n: string | null | undefined) => (n ? idByName.get(n) ?? null : null);

    for (const t of data.tasks) {
      const projectId = projectIdByName.get(t.project);
      if (!projectId) throw new Error(`Task "${t.title}" references unknown project "${t.project}"`);
      const createdBy = personId(t.by) ?? personId(t.owner);
      if (!createdBy) throw new Error(`Task "${t.title}" has no resolvable creator ("by": ${t.by})`);

      const { rows } = await client.query<{ id: string }>(
        `insert into tasks (
           title, project_id, pillar, horizon, owner_id, source, created_by_id,
           effort_assigner, effort_owner, status, note, priority, posted_week,
           declined_by_id, escalated, escalated_by_id, escalated_to_id, escalated_subject_id,
           escalated_week, bounced, allocated_by_id, allocated_week, alloc_reason,
           done_owner_week, done_lead_week, done_week
         ) values (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26
         ) returning id`,
        [
          t.title, projectId, t.pillar, t.horizon, personId(t.owner), t.source, createdBy,
          t.ea ?? null, t.eo ?? null, t.status, t.note ?? "", t.prio ?? null, t.posted ?? null,
          personId(t.declinedBy), !!t.escalated, personId(t.escalatedBy), personId(t.escalatedTo),
          personId(t.escalatedSubject), t.escalatedWk ?? null, !!t.bounced, personId(t.allocatedBy),
          t.allocatedAt ?? null, t.allocReason ?? null, t.dOwner ?? null, t.dLead ?? null, t.done ?? null,
        ]
      );
      const taskId = rows[0].id;

      for (const h of t.help ?? []) {
        const helperId = personId(h.who);
        if (helperId) {
          await client.query(
            `insert into task_help (task_id, person_id, hours) values ($1,$2,$3) on conflict do nothing`,
            [taskId, helperId, h.hrs]
          );
        }
      }
      // legacy free-text history lines don't map to a structured event;
      // keep them verbatim rather than losing them.
      for (const line of t.hist ?? []) {
        await client.query(`insert into task_history (task_id, event, detail) values ($1, 'legacy_note', $2)`, [
          taskId,
          JSON.stringify({ text: line }),
        ]);
      }
    }

    for (const g of data.ghost) {
      const who = idByName.get(g.who);
      if (!who) throw new Error(`Ghost log entry references unknown person "${g.who}"`);
      await client.query(`insert into ghost_log (person_id, what, hours, week) values ($1,$2,$3,$4)`, [
        who,
        g.what,
        g.hrs,
        g.wk,
      ]);
    }

    if (currentWeek != null) {
      await client.query(`update cycle_config set current_week = $1 where singleton = true`, [currentWeek]);
    }

    await client.query("COMMIT");
    console.log(
      `Migrated ${data.people.length} people, ${data.projects.length} projects, ` +
        `${data.tasks.length} tasks, ${data.ghost.length} ghost-log entries.`
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
