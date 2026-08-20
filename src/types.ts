export type Horizon = "week" | "month" | "quarter";
export type Pillar = "product" | "scale" | "perovskite" | "barrier";
export type TaskStatus =
  | "pool" | "proposed" | "allocated" | "signed" | "prog"
  | "blocked" | "declined" | "await" | "done";

export interface Person {
  id: string;
  name: string;
  email: string | null;
  entra_object_id: string | null;
  reports_to: string | null;
  team: string | null;
}

export interface Project {
  id: string;
  name: string;
  lead_id: string;
  pillar: Pillar;
}

export interface Task {
  id: string;
  title: string;
  project_id: string;
  pillar: Pillar;
  horizon: Horizon;
  owner_id: string | null;
  source: "self" | "lead";
  created_by_id: string;
  effort_assigner: number | null;
  effort_owner: number | null;
  status: TaskStatus;
  note: string;
  priority: number | null;
  posted_week: number | null;
  declined_by_id: string | null;
  escalated: boolean;
  escalated_by_id: string | null;
  escalated_to_id: string | null;
  escalated_subject_id: string | null;
  escalated_week: number | null;
  bounced: boolean;
  allocated_by_id: string | null;
  allocated_week: number | null;
  alloc_reason: string | null;
  done_owner_week: number | null;
  done_lead_week: number | null;
  done_week: number | null;
  version: number;
  updated_at: string;
  created_at: string;
}

export const HORIZON_CAPS: Record<Horizon, number> = { week: 1, month: 2, quarter: 3 };
export const EFFORT_BUCKETS = [0, 25, 50, 100];

export function effort(t: Pick<Task, "effort_assigner" | "effort_owner">): number {
  if (t.effort_assigner != null && t.effort_owner != null) return (t.effort_assigner + t.effort_owner) / 2;
  if (t.effort_owner != null) return t.effort_owner;
  if (t.effort_assigner != null) return t.effort_assigner;
  return 0;
}

export const OPEN_STATUSES: TaskStatus[] = ["proposed", "allocated", "signed", "prog", "blocked"];
export const isOpen = (t: Pick<Task, "status">) => OPEN_STATUSES.includes(t.status);
export const needsSignup = (t: Pick<Task, "status">) => t.status === "proposed" || t.status === "allocated";
