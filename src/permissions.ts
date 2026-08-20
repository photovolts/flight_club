import { PoolClient } from "pg";
import { Task } from "./types";
import { forbidden } from "./errors";

/**
 * These checks are the server-side replacement for the prototype's
 * client-side "who am I" trust model -- every workflow endpoint calls one
 * of these against the *session* identity, never a client-supplied one.
 */

export function assertIsOwner(task: Pick<Task, "owner_id">, actorId: string): void {
  if (task.owner_id !== actorId) throw forbidden("You are not the owner of this task.");
}

export async function assertIsProjectLead(
  client: PoolClient,
  task: Pick<Task, "project_id">,
  actorId: string
): Promise<void> {
  const { rows } = await client.query<{ lead_id: string }>(
    "select lead_id from projects where id = $1",
    [task.project_id]
  );
  if (!rows.length || rows[0].lead_id !== actorId) {
    throw forbidden("You do not lead this task's project.");
  }
}

/** The allocation-meeting queue is scoped to whoever a task was escalated to. */
export function assertIsEscalationTarget(task: Pick<Task, "escalated_to_id">, actorId: string): void {
  if (task.escalated_to_id !== actorId) {
    throw forbidden("This task was not escalated to you.");
  }
}
