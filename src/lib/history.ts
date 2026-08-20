import { PoolClient } from "pg";

export async function logHistory(
  client: PoolClient,
  taskId: string,
  actorId: string | null,
  event: string,
  detail: Record<string, unknown> = {}
): Promise<void> {
  await client.query(
    `insert into task_history (task_id, actor_id, event, detail) values ($1, $2, $3, $4)`,
    [taskId, actorId, event, detail]
  );
}
