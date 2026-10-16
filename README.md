# SyncUp Backend

The API behind [SyncUp](https://github.com/Prakharpan-dey/SyncUp), a student
productivity app: tasks and repeating habits, attendance tracking, friends and
groups, a shared activity feed, and push notifications.

Fastify 5 on Node 22, Postgres through Drizzle, Redis for queues and rate
limits. TypeScript throughout, ES modules, deployed on Railway at
`https://api.zeusdotdev.app`.

## How it runs

Two processes share one codebase, one database and one Redis:

| Process | Entry point | Start with | Does |
|---|---|---|---|
| API | `src/main.ts` | `npm run dev` / `npm start` | Serves HTTP on `PORT` |
| Workers | `src/workers/index.ts` | `npm run dev:worker` / `npm run worker` | Drains queues, runs timers |

The API only ever enqueues; nothing long-running happens in a request. If the
worker process is not running, jobs queue up in Redis and nothing is delivered —
no emails, no push notifications, no feed items.

The workers are:

- **email** — verification and password-reset mail, over Resend's HTTP API
  (SMTP ports are blocked on most PaaS hosts, Railway included).
- **feed** — fans a completed task out to friends, and to one row per group the
  author belongs to.
- **notifications** — writes the notification row, then pushes through FCM if
  Firebase credentials are present and the recipient has not muted that type.
- **cleanup** and **reminders** — plain `setInterval` timers rather than queues,
  because a handful of jobs a day costs less than a scheduled queue on a
  per-command Redis plan. Cleanup prunes expired tokens and feed items older
  than 30 days, in batches of 10,000.

## Getting started

Requires Node 22+ and a Postgres and Redis you can reach.

```bash
npm install
cp .env.example .env    # then fill it in
npm run db:migrate
npm run dev             # API on http://localhost:3000
npm run dev:worker      # in a second terminal
```

`docker compose up postgres redis` brings up both dependencies locally; the
compose file also builds the API itself if you want the whole stack in Docker.
`GET /health` answers `{"status":"ok"}` once the API is up.

## Configuration

Every variable is validated by `src/core/config/env.ts` at startup, and the
process refuses to boot on a missing or malformed one. `.env.example` documents
all of them; the essentials:

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | On Neon, use the **pooled** connection string |
| `REDIS_URL` | yes | Queues and rate limiting |
| `JWT_ACCESS_SECRET` | yes | 32 characters minimum |
| `PUBLIC_APP_URL` | in production | Emailed links are built from it, so a localhost value would be dead for whoever receives it |
| `RESEND_API_KEY` / `SMTP_*` | for email | Needed by the **worker**, not the API |
| `FIREBASE_SERVICE_ACCOUNT` | for push | Service account JSON on one line. Worker only |
| `REPORTS_EMAIL` | no | Support inbox that in-app reports are mailed to. Unset, reports are stored but not mailed |
| `DATABASE_POOL_MAX` | no | Per instance, default 10 |

Without Firebase credentials notifications are still stored, just not pushed.
Without email credentials the email jobs are consumed and skipped. Both cases
warn loudly at worker startup rather than failing silently.

## Layout

```
src/
  app.ts               Fastify instance: plugins, error handler, route registration
  main.ts              API entry point
  core/
    config/            Env schema
    db/                Drizzle client and schema (one file per table)
    queues/            BullMQ producers
    middleware/        authGuard, requireVerifiedEmail, error handler
    security/          Rate limit keying
  modules/<name>/      routes → service → schema, one folder per feature
  workers/             Queue consumers and timers
db/migrations/         Generated SQL, applied in order
tests/                 unit/ and integration/, plus helpers and fixtures
```

Each module is three files: `*.routes.ts` declares endpoints and validates
params, `*.service.ts` holds the logic and the only database access, and
`*.schema.ts` is the Zod contract for request bodies.

## Endpoints

All prefixes are registered in `src/app.ts`. Everything requires a bearer token
except where noted.

| Prefix | Covers |
|---|---|
| `/auth` | Signup, login, refresh, sessions, devices, email verification, password reset, change email/password, account deletion |
| `/account` | **Public** web account-deletion form — the Play Store requires a URL that works without installing the app |
| `/legal` | **Public** privacy policy |
| `/users` | Profile, search, export, block |
| `/tasks` | Tasks, completion toggle, stats |
| `/task-series` | Repeating rules; occurrences themselves are ordinary tasks |
| `/subjects` | Attendance subjects and sessions |
| `/friends` | Requests, responses, unfriend, blocked list, unblock |
| `/groups` | Groups, members, invites, join requests |
| `/feed` | Friends and groups feed, daily plan sharing, reactions |
| `/notifications` | List, mark read, delete, clear, unread count |
| `/reports` | Report a person or a post. Stored in `reports` and mailed to `REPORTS_EMAIL` |

`/feed`, `/friends` and `/groups` additionally require a verified email.

### Auth model

Access tokens are JWTs, short-lived (15 minutes by default). Refresh tokens are
random strings stored only as hashes, rotated on every use, and valid for 30
days. Passwords are bcrypt at cost 12.

Brute force is bounded on several axes at once (`src/modules/auth/login-guard.ts`):
10 failures per email+IP per 15 minutes, 100 per email per hour, 50 per IP per
15 minutes, and 10 signups per IP per hour. Every counter fails open if Redis is
unavailable. The global limit is 100 requests a minute, keyed per account when
signed in and per address otherwise.

`trustProxy` is on because Railway terminates every connection at its proxy;
without it every IP-keyed limit would be a single bucket shared by all users.

## Database

Drizzle owns the schema. After changing anything in `src/core/db/schema/`:

```bash
npm run db:generate    # writes a migration into db/migrations
npm run db:migrate     # applies it
```

Migrations are applied in order and committed to the repo. `npm run db:studio`
opens Drizzle Studio against whatever `DATABASE_URL` points at.

Two notes that have caused real bugs:

- `${table.column}` inside a raw `sql` fragment within `select()` renders as a
  bare column name, which is ambiguous once a query has joins. Write the
  qualified name (`"users"."id"`) by hand there.
- A `.desc()` index renders as `DESC NULLS LAST`, so a query has to order the
  same way to use it.

At scale, index changes on `feed_items` must be hand-written as
`CREATE INDEX CONCURRENTLY` outside a migration transaction.

## Tests

```bash
npm test                 # everything
npm run test:unit
npm run test:integration
npm run lint             # tsc --noEmit
```

Vitest, with no database required: `tests/helpers/db-mock.ts` stands in for the
Drizzle client by queueing result sets in call order, so a service issuing three
queries is described by three queued sets. Integration tests build the real
Fastify app with that mock underneath and assert on response shapes and
limits.

## Deployment

Railway builds the `Dockerfile` (multi-stage, production dependencies only) and
runs `node dist/main.js`. The worker runs the same image with `npm run worker`
as its command, so it scales separately from request traffic. Both processes
need the same environment; email and push credentials matter only to the worker.

Migrations are not run automatically on deploy — apply them yourself before
releasing code that depends on them.
