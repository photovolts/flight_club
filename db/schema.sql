-- Flight Plan schema.
-- Names in the original prototype were the foreign key; here every reference
-- is a uuid and `name`/`email` are just display/login fields.

create extension if not exists pgcrypto;

create table if not exists people (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text unique,
  entra_object_id text unique,
  reports_to uuid references people(id) on delete set null,
  team text,
  created_at timestamptz not null default now()
);

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  lead_id uuid not null references people(id),
  pillar text not null check (pillar in ('product','scale','perovskite','barrier')),
  created_at timestamptz not null default now()
);

-- Singleton row. Replaces the hard-coded WEEK_NOW in the prototype.
create table if not exists cycle_config (
  singleton boolean primary key default true,
  current_week int not null,
  constraint cycle_config_singleton check (singleton)
);
insert into cycle_config (current_week)
  values (true, 34)
  on conflict (singleton) do nothing;

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  project_id uuid not null references projects(id),
  pillar text not null check (pillar in ('product','scale','perovskite','barrier')),
  horizon text not null check (horizon in ('week','month','quarter')),
  owner_id uuid references people(id),
  source text not null check (source in ('self','lead')),
  created_by_id uuid not null references people(id),

  effort_assigner smallint check (effort_assigner in (0,25,50,100)),
  effort_owner smallint check (effort_owner in (0,25,50,100)),

  status text not null check (status in
    ('pool','proposed','allocated','signed','prog','blocked','declined','await','done')),
  note text not null default '',
  priority smallint,

  -- pool
  posted_week int,

  -- decline / lead triage
  declined_by_id uuid references people(id),

  -- escalation / allocation meeting
  escalated boolean not null default false,
  escalated_by_id uuid references people(id),
  escalated_to_id uuid references people(id),
  escalated_subject_id uuid references people(id),
  escalated_week int,
  bounced boolean not null default false,
  allocated_by_id uuid references people(id),
  allocated_week int,
  alloc_reason text,

  -- close-out: both sides must tick before status becomes 'done'
  done_owner_week int,
  done_lead_week int,
  done_week int,

  -- optimistic concurrency
  version int not null default 1,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists tasks_owner_idx on tasks(owner_id);
create index if not exists tasks_project_idx on tasks(project_id);
create index if not exists tasks_status_idx on tasks(status);

create table if not exists task_help (
  task_id uuid not null references tasks(id) on delete cascade,
  person_id uuid not null references people(id),
  hours numeric not null,
  primary key (task_id, person_id)
);

-- Append-only audit trail. Every workflow transition writes one row here;
-- this replaces the ad hoc `hist` string array the prototype built by hand.
create table if not exists task_history (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  at timestamptz not null default now(),
  actor_id uuid references people(id),
  event text not null,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists task_history_task_idx on task_history(task_id);

create table if not exists ghost_log (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id),
  what text not null,
  hours numeric not null,
  week int not null,
  created_at timestamptz not null default now()
);
