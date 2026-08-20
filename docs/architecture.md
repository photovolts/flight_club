# Flight Plan backend architecture

Rayleigh Solar Tech's Flight Plan tool started as a single HTML file storing
everything in one browser's `localStorage`, with "who am I" a client-side
dropdown and permissions enforced only by hiding UI. This document is the
design for turning it into a real, multi-user backend. The scaffold in this
repo implements it.

## Requirements

- ~30-50 users, low request volume, no need for multi-region HA.
- Auth tied to real identity, not a name picker.
- Server-side enforcement of the three permission scopes the prototype only
  enforced cosmetically: self (task owner), project lead (their projects),
  team lead (their direct reports / escalation target).
- Concurrent editing without silent clobbers.
- An audit trail for status changes, escalations, and allocations.
- Cost-conscious, low-ops hosting appropriate for an internal tool built and
  run by a small team.
- A migration path from the existing `localStorage` export format.

## Shape

```
[Existing HTML/JS frontend]  ->  fetch()  ->  [Express API]  ->  [Postgres]
         (rendering logic unchanged --                              (source of truth,
          S becomes "last API response")                            audit history)
                                                   ^
                                           Microsoft Entra ID
                                       (SSO login + org-chart sync)
```

**Why a custom Node API over Supabase/PostgREST+RLS:** the workflow rules
(swap-on-duplicate-priority, both-sides-must-tick-to-close, escalation
routing) are business logic beyond row CRUD. Writing them as imperative
TypeScript maps almost 1:1 onto the prototype's existing `data-act`
dispatch, which is the fastest path for a team already reading that code.
RLS would enforce permissions more strongly (DB-level, unbypassable even by
a buggy client) but trades that for a new paradigm (SQL policies) for
logic this small a team will maintain solo. Revisit if the team grows.

## Data model

Names were the foreign key in the prototype (`owner: "Michelle Pellerin"`).
Real schema uses uuids; `db/schema.sql` has the full DDL. Two notable
departures from a literal translation:

- **`priority` stays a plain nullable column**, not a uniqueness constraint.
  "Setting #1 bumps whoever held it" is a swap, not a rejected duplicate --
  enforcing it as a DB constraint would fight the actual business rule.
- **`cycle_config` is a real, advanceable row** instead of a hard-coded
  `WEEK_NOW`. `POST /api/cycle/advance` is gated on an `ADMIN_EMAILS` env
  var -- the one place in this app that needed a role with no natural owner
  (no project or team to scope it to). Every other permission check derives
  from data already on the task or the org chart.

## Permissions

Re-derived server-side on every request from the session, never trusted
from the client:

| Action class | Rule |
|---|---|
| Self-service (sign, decline, tick, claim) | `session.person.id === task.owner_id` |
| Project-lead (reassign, escalate, lead-tick) | `session.person.id === project.lead_id` for the task's project |
| Team-lead (allocate, park) | `session.person.id === task.escalated_to_id` |

The team-lead check is intentionally the *recorded* escalation target, not
a live recursive walk of the org chart on every request -- who a task was
escalated to is decided once, at escalation time (defaulting to the
subject's direct manager via `people.reports_to`), and stored on the task.
That is simpler and more auditable than re-deriving it on every subsequent
action.

## Concurrency & audit

Every task carries a `version` column. Mutating endpoints accept an
optional `version` in the request body and update
`... where id = $1 and version = $2`; zero rows updated means someone else
changed it first, and the client gets a 409 instead of silently clobbering
a concurrent decline/allocate. `task_history` is an append-only audit log
written inside the same transaction as every state change -- it replaces
the ad hoc `hist` string array the prototype built by hand, and answers
"who did what, when" without re-deriving it from current field values.

## Auth

Microsoft Entra ID (Azure AD) OIDC, on the assumption Rayleigh is on
Microsoft 365 -- confirm this before wiring real credentials. Session
cookie backed by a Postgres-stored session (`connect-pg-simple`), not a
JWT: revocation is a `DELETE` instead of a TTL wait, and there's no reason
to be stateless at this scale. The prototype's "Superuser" sandbox toggle
does not exist server-side; a real impersonation feature, if ever needed,
would be a separate, audited endpoint restricted to a specific role, not a
self-service checkbox.

**Free win once SSO is wired up:** Entra ID already has the org's manager
relationships. A periodic Microsoft Graph sync
(`GET /users/{id}?$select=manager`) can keep `people.reports_to` current
automatically, instead of hand-maintaining it on the People & Roles tab --
removing exactly the kind of stale-data risk the tool's own copy already
warns about ("Two things were inferred, not given"). Not implemented in
this scaffold; worth doing once login works.

## Hosting recommendation

- **Database:** Neon or Supabase Postgres, smallest tier. A few hundred
  rows of data; cost is nominal. Turn on automated backups once this
  becomes the only record of who owns what.
- **API:** this Express service, deployed to Render or Fly.io. No
  Kubernetes/ECS -- that's infrastructure for a scale this tool will never
  reach.
- **Frontend:** the existing static HTML/JS, served from the same host or
  a static host (Netlify/Vercel). Swap `localStorage.getItem/setItem` for
  `fetch()`; the `view*()` render functions barely change.
- **CI/CD:** GitHub Actions, deploy on push to main.

## What I'd revisit as it grows

- Realtime push (SSE/WebSocket) instead of client polling, if the tool's
  cadence ever stops being "checked in a weekly meeting."
- Redis for session storage/caching, if Postgres-backed sessions become a
  bottleneck (unlikely at this scale).
- A real role/permission table, if a use case shows up that doesn't fit
  "owner / project lead / escalation target" (e.g. HR-style admin access
  broader than the one `ADMIN_EMAILS` gate).

None of that is needed at launch scale.
