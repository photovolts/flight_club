import { Pool, PoolClient } from "pg";

type Queryable = Pool | PoolClient;

export async function getCurrentWeek(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ current_week: number }>(
    "select current_week from cycle_config where singleton = true"
  );
  if (!rows.length) throw new Error("cycle_config is not seeded");
  return rows[0].current_week;
}

export async function advanceWeek(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ current_week: number }>(
    "update cycle_config set current_week = current_week + 1 where singleton = true returning current_week"
  );
  return rows[0].current_week;
}
