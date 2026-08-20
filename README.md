# flight_club

Backend for **Flight Plan** — Rayleigh Solar Tech's deliverable-tracking tool.
This repo currently holds the API/database scaffold that replaces the
original single-file, `localStorage`-only prototype (`flight-plan_3.html`)
with a real multi-user backend. See `docs/architecture.md` for the design
this scaffold implements, and the rationale for the choices below.

## What's here

```
db/schema.sql                  Postgres schema
scripts/migrate-from-export.ts One-time import of the prototype's "Export JSON" file
src/server.ts                  Express app entrypoint
src/auth.ts                    Session + Microsoft Entra ID (Azure AD) SSO, with a dev-only fallback
src/permissions.ts             Server-side authorization checks (owner / project lead / escalation target)
src/routes/                    REST endpoints -- one per resource, plus one per task-lifecycle action
src/lib/                       Shared helpers (current week, audit log, request validation)
```

Every task-lifecycle action from the prototype's `data-act` handlers
(sign up, decline, tick-done, reassign, escalate, allocate, park, claim, ...)
has a corresponding `POST /api/tasks/:id/<action>` endpoint that runs as a
single DB transaction: check permission against the *session* identity (not
a client-supplied one), check the current status allows the transition,
mutate, write a `task_history` audit row, commit.

## Running it locally

Requires Node 20+ and a Postgres instance. Node isn't installed on the
machine this scaffold was written on, so none of this has been executed yet
-- treat first run as a shakeout, not as "already verified."

```bash
npm install
createdb flight_plan   # or point DATABASE_URL at any Postgres instance
psql "$DATABASE_URL" -f db/schema.sql
cp .env.example .env   # then fill in DATABASE_URL / SESSION_SECRET
npm run dev
```

With `ENTRA_TENANT_ID` / `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET` unset, the
API runs in **dev-auth mode** (only while `NODE_ENV=development`): identify
yourself by sending an `X-Dev-User-Email` header matching a row in `people`,
e.g.

```bash
curl -c cookies.txt -b cookies.txt \
  -H "X-Dev-User-Email: brogan.obrien@rayleighsolartech.com" \
  http://localhost:4000/api/me
```

The cookie jar carries the session for subsequent requests, same as a
browser would.

## Migrating existing demo/prototype data

The prototype's **Export JSON** button produces a name-keyed JSON blob.
This schema uses uuids and real foreign keys instead, so the importer's job
is entirely building a name→uuid lookup and rewriting references through it:

```bash
npm run migrate:import -- path/to/flight-plan-export.json --week=34
```

## What's intentionally not done yet

- **Frontend integration.** The existing `flight-plan_3.html` still reads
  and writes `localStorage`. Pointing it at this API means replacing the
  `load()`/`save()` pair with `fetch()` calls; the rendering code barely
  changes, since it already treats `S` as an in-memory snapshot.
- **Entra ID app registration.** `src/auth.ts` is wired for it (OIDC via
  `openid-client`), but needs real tenant/client credentials in `.env`
  before SSO login actually works. Dev-auth mode is a stand-in until then.
- **Realtime updates.** Deliberately left as a client-side polling concern
  (e.g. `GET /api/tasks` every 30-60s) rather than WebSockets/SSE -- this
  tool's own rhythm is a weekly meeting, not live collaborative editing.
- **Hosting.** Not deployed anywhere. See the architecture notes for the
  recommendation (managed Postgres + a small Node service on Render/Fly.io).
