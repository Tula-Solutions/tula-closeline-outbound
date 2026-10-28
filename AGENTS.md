# tula-closeline-outbound

campaigns across email, LinkedIn and messaging

Kind: **service**. Common standards for every Closeline repo are in `.claude/COMMON.md`, synced
from the hub (`tula-closeline`). This file holds only what is specific to this repo. Keep it under
200 lines: put detail in a path-scoped rule under `.claude/rules/` or a decision record in the hub.

## Commands

| Command | Use |
| --- | --- |
| `bun install` | install, including the tagged `tula-closeline-*` libraries |
| `bun run verify` | the full gate, exactly what CI runs |
| `bun run verify:changed` | the quick gate the Stop hook runs |
| `bun test` | tests |
| `bun run bench` | the benchmarks and their budgets |
| `bun run openapi` | rewrite `openapi.json` after a route or schema change |

Other scripts are in `package.json`.

## Layout

The shape in `.claude/COMMON.md` is built; add modules under `src/modules/<name>/`.

- `src/container.ts` is the only composition root: env, kit logger, clock, readiness checks,
  `lifecycle`, and `reportError`. `src/testing.ts` builds the same container from in-memory doubles.
- `reportError(error, context)` is the one seam for unexpected errors (5xx only). It logs through
  the kit today; the error tracker is wired in there and nowhere else. It must not throw. Call
  `reportSafely`, never it directly.
- `src/http/` is the middleware stack in `createBaseApp`: request id, error guard, body limit,
  error handler, 404. Modules build routes with `createRouter()` and `errorResponse(...)` so every
  route is described for OpenAPI and failures take the contract's `area.reason` codes.
- Readiness: add a `ReadinessCheck` to `readinessChecks` when a dependency arrives. `/readyz` runs
  them concurrently, each with `READINESS_TIMEOUT_MS`, and never returns the failure reason.
  `/healthz` checks nothing.
- Shutdown (`src/shutdown.ts`): on SIGTERM `/readyz` goes 503, `SHUTDOWN_GRACE_MS` passes, the
  server stops accepting, `SHUTDOWN_TIMEOUT_MS` bounds the drain, then it exits. A second signal
  over a second later exits at once.
- Log errors with `describeError`, never the raw error.
- `openapi.json` is generated: `bun run openapi`; `verify` fails if it is stale. No database yet:
  add `tula-closeline-db` when the first table is needed.

## Env keys (`src/env.ts`, mirrored in `.env.example`)

`ENVIRONMENT` (required, no default), `PORT`, `LOG_LEVEL`, `READINESS_TIMEOUT_MS`,
`SHUTDOWN_TIMEOUT_MS`, `SHUTDOWN_GRACE_MS`, `MAX_REQUEST_BODY_BYTES`, `CORE_URL`,
`CORE_INTERNAL_SECRET` (core's Prospect read and write-back go over HTTP when `CORE_URL` is set or
outside `local`; the adapter is `src/adapters/http/core.ts`), `CORE_CALL_TIMEOUT_MS`,
`CORE_CALL_MAX_TRIES`, and for Mailboxes `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`,
`GOOGLE_AUTH_URL`, `GOOGLE_TOKEN_URL`, `GOOGLE_REVOKE_URL`, `GMAIL_API_BASE_URL`,
`MICROSOFT_CLIENT_ID`/`MICROSOFT_CLIENT_SECRET`, `MICROSOFT_AUTH_URL`, `MICROSOFT_TOKEN_URL`,
`GRAPH_API_BASE_URL`,
`MAIL_OAUTH_REDIRECT_URI`, `MAIL_STATE_SECRET` (required outside `local`), `MAIL_SECRET_BOX_KEY`
(a local-only key, refused in staging and prod), `MAIL_CALL_TIMEOUT_MS`, `MAIL_CALL_MAX_TRIES`,
`MAIL_RETRY_BASE_MS`, and for enrichment vendors `APOLLO_BASE_URL`, `ZEROBOUNCE_BASE_URL`,
`PROVIDER_CIRCUIT_FAILURES`, `PROVIDER_CIRCUIT_OPEN_MS`, and for Research Briefs
`RESEARCH_WEB_DEADLINE_MS`, `RESEARCH_MODEL_TIMEOUT_MS`, `RESEARCH_MODEL_MAX_TRIES`,
`RESEARCH_RETRY_BASE_MS`, `RESEARCH_BRIEF_TTL_SECONDS`. Add a key in both files.

## Campaigns (`src/modules/campaign`)

Campaigns and their Sequence versions (`/v1/campaigns`). The store port is `ports/campaign-store.ts`
(memory and Postgres adapters). A Rep sees their own Campaigns, a Manager their Team's, an Admin
and owner all; outside the view a Campaign is `campaign.not_found`. Saving a Sequence writes a new
version after graph and variant-weight checks (`campaign.invalid_sequence` names the Step); a
running Campaign accepts it and the version applies to new Steps only. Every mutating call needs an
`Idempotency-Key`. The Rep's membership id comes from `CoreAccess.membershipIdOf`, which is a fake
mapping until core exposes it; the database has no column for automatic variant promotion, so only
`promotion.mode: 'manual'` is accepted.

Enrollments and the audience check (`enrollment.ts`, `audience.ts`; stores `ports/enrollment-store.ts`,
memory and Postgres). `POST .../enrollments` takes up to 100 Prospect ids into a running or paused
Campaign, judged one by one: out of view is `not_found`, a Prospect in another active Campaign or
this one is `already_active`, and the kit `ContactGuard` (core's Contact Check, channel email,
`agent_initiated`) decides the rest. `consent.suppressed` stops the Enrollment as `suppressed`; any
other denial, including core being unreachable, stops it as `no_consent` (fails closed, no setting
skips it). Each Prospect has one row per Campaign, so a re-run makes no duplicate. The audience
check (`audience.check_page` queue message) walks core's Prospects 100 at a time, one message per
page carrying the running counts, so no request or job holds the whole list. `CoreAudience` and the
audience-check store are memory adapters only (core has no internal list route and the db no check
table; the shortcut comments say when to upgrade), so outside `local` the service warns.
`enrollment.stopped` is logged by id only; there is no event bus yet.

## Mailboxes (`src/modules/mailbox`)

Connect, list and disconnect Gmail and Outlook Mailboxes (`/v1/mailboxes`); `deps.transports` is
keyed by provider. Ports: `mail-transport.ts` (memory, Gmail and Graph adapters, one shared behaviour
suite; `adapters/provider-call.ts` is their shared timeout/retry), `mailbox-store.ts` (memory and Postgres) and
`secret-box.ts` (tokens are sealed with the Organization, Mailbox and purpose as context; the AES
adapter takes a local key, KMS comes with infra). Start returns the consent URL with a signed,
expiring `state` (HMAC, bound to Organization and user, no table); complete verifies it, exchanges
the code with a derived PKCE verifier and stores the Mailbox under an id derived from the attempt,
so a repeat answers the same Mailbox with 200. Tokens never appear in a response, log or error
report. A revoked grant (`MailTransportError('grant_invalid')`) disconnects the Mailbox with reason
`auth_revoked`, deletes its tokens and publishes `mailbox.state_changed` through `deps.events`
(logged only until the service has an event bus). `accessTokenFor` and `sendThrough` are the
functions the send path uses; sending is never retried after an unknown outcome. A Rep sees their
own Mailboxes, a Manager their Team's, an Owner or Admin all; shared Mailboxes are Owner/Admin only.
A live Gmail test runs only when `GMAIL_LIVE_REFRESH_TOKEN` is set.
Outlook (`adapters/graph`): OAuth with PKCE on tenant `common`, identity from Graph `/me`. A send is
create-draft from MIME (so Exchange threads by the headers and returns the message and conversation
ids) then `/send`; the draft call retries on 5xx, the send step only on 429/503, never after a
timeout. Microsoft has no per-app revoke, so `revoke` is a no-op and disconnecting deletes the
tokens; `interaction_required` and `invalid_grant` both mean `grant_invalid`. Not run against real
Microsoft yet.

## LinkedIn (`src/modules/linkedin`)

- Routes: `POST /v1/linkedin/accounts/connection` (Rep only, Idempotency-Key, answers the provider's
  hosted login), `GET /v1/linkedin/accounts[/{accountId}]`, `DELETE /v1/linkedin/accounts/{accountId}`.
  Visibility is the Mailbox rule: Owner and Admin all, Manager self plus their Team's Reps, Rep self.
- Start needs the channel enabled (`linkedin.channel_disabled`) and the current risk wording accepted
  (`linkedin.risk_not_accepted`); the Admin switch and acceptance routes are the next ticket, and the
  store only reads them.
- Disconnect is for the owning Rep, or an Owner or Admin for a leaver; anyone else gets
  `linkedin.not_account_owner`. `closeline_outbound` cannot delete rows, so disconnect sets the status
  and a reconnect reuses the row, its id and its limits. A repeat is a no-op.
- `ports/linkedin-provider.ts` has only the memory adapter: the vendor is undecided. With no provider
  (anything but `ENVIRONMENT=local`) start answers `server.unavailable`.
- `completeConnection` (service) records a finished hosted login; no route calls it until the
  provider webhook ticket. The provider's account reference is stored and never returned or logged.

## Brand voice (`src/modules/brand-voice`)

The Organization's Brand Voice (`/v1/brand-voice`): `GET` the current one (any role,
`voice.not_found` before the first save), `PUT` to save a new version (Owner and Admin, needs an
`Idempotency-Key`), `GET /versions` for the history, newest first (Owner and Admin, as the contract
says). Store port `ports/brand-voice-store.ts` (memory and Postgres); a save runs under a per-
Organization advisory lock, so `expectedVersion` decides and the loser gets `voice.version_conflict`.
Every version keeps its own id (derived from Organization and version) and stays readable, since a
Draft names the exact version it used. The body is checked by the service, not the router, so an
empty or oversized value, an unknown field or a banned phrase that is also preferred answers
`voice.invalid`. A repeat of the last save answers that version. The contract and database have no
default-language field, so there is none yet.

## Research Briefs (`src/modules/research`)

`POST /v1/prospects/{prospectId}/briefs` builds a Brief from the Prospect's fields, fresh Signals, a
bounded web search (at most 10 pages, `RESEARCH_WEB_DEADLINE_MS`) and the Organization's Playbook
search. The model gets fixed instructions and the material as numbered sources (`s1`...) in a
separate data channel; a statement whose `sourceId` is not one of them, or that fails the contract's
schema, is dropped and counted in `droppedCount`. A web timeout answers `research.timeout` with
`details.sources` (the pages that had arrived, marked `partial`) and keeps nothing. A Brief is reused
(200) while the Prospect's `updatedAt` is the one it was built from and it has not expired (core's
enrichment-input route serves no `updatedAt` yet, so over HTTP every call builds); `refresh: true`
builds a new one (201). The `Idempotency-Key` is stored on the Brief (`request_key`, unique per
Organization): a replay answers that Brief (200), the key for another Prospect is
`request.idempotency_key_reused`, and of two racing requests one insert wins and the other answers
its Brief. `BriefStore` is Postgres (`outbound.briefs`, `outbound.brief_statements`) with a memory
twin for tests; `Model`, `WebSearch` and `PlaybookSearch` have memory adapters only (the vendor is
undecided, #290): outside `local` the model is null and a Brief answers `draft.model_unavailable`.
Logs carry ids and counts only.

## Signals and fit (`src/modules/signal`, `src/modules/fit`)

- A Signal is untrusted data: shown to the Rep and to the research brief, never obeyed, never
  logged. `Signals.ingest` is the one write path (provider adapters, notes, the webhook).
- Fresh means `expiresAt > now`; the default window is 30 days (`DEFAULT_FRESHNESS_DAYS`).
  `Signals.listFresh` is what the research brief reads. A kind switched off in the Organization's
  settings is refused with `signal.invalid`.
- The webhook (`POST /v1/public/signals/webhook/{organizationId}`) is signed over the raw body (HMAC,
  constant-time compare, timestamp window), so it reads the body itself, is mounted before token
  authentication, and its body is not declared in OpenAPI. The secret is sealed with the secret box and rotated by `rotate` (no replay store).
- Fit is scored lazily on `getProspectFit` and stored; a change emits `prospect.fit_changed`.
  Criteria edits do not rescore in the background, so `listFitScores` can be stale until read.
- `findProspectIdByEmail` is not served by core's HTTP yet (the adapter returns null).
## Send

`modules/send/service.ts` `send(deps, org, request)` decides and sends one email. The request
carries what the caller resolved (Campaign, Prospect, key `enrollmentId:step:attemptEpoch`,
recipient and `verified`, Mailbox ids, subject and text); there is no Draft or Enrollment module
to read from yet. Checks run in this order and each outcome is stored under the key in
`mail_messages` before anything leaves: Campaign running, window (the Prospect's zone when
`windowZone` says so), address verified, Contact Check (`guard`, email, `agent_initiated`;
fails closed, no setting turns it off), a usable Mailbox, then the limits. A refusal or deferral
returns the stored record and sends nothing; a settled key throws `send.duplicate`; a deferred
key is decided again and keeps its row. `REASON_CODES` maps a reason to its error code.

Limits: `SendStore.reserve` takes a per-Organization advisory lock, counts `sending` and `sent`
rows (UTC day, clock hour) and inserts the `sending` row in one transaction, so parallel sends
cannot pass a limit. Order: gap, hour, day, then `MAIL_ORG_DAILY_CAP` (Organization, no limits
table yet). Rotation picks the Mailbox with the fewest sends today, then the longest idle; a
follow-up stays on the first message's Mailbox and thread. Campaign `dailyCap` is not enforced.

Failure: the provider is called after the row is `sending`. A timeout, or a failed settle, leaves
the row `sending` (it still counts) and never sends again; `reconcile` settles rows older than
ten minutes as `sent` with no provider ids, since the provider has no lookup. Any other provider
error settles `failed`, final for the key (a retry needs a new `attemptEpoch`). Every message
carries `List-Unsubscribe` (one-click) and a signed link from `MAIL_UNSUBSCRIBE_URL`
(`unsubscribe.ts`, 30 days); the route behind it is not built. `GET /v1/mail/capacity` shows
remaining sends and the next send time per Mailbox (`capacity.ts`). No internal `submitSend` HTTP
route yet (no inbound shared-secret auth).
## Enrichment providers and settings (`src/adapters/providers`, `src/modules/enrichment/settings*.ts`)

Apollo (person, company) and ZeroBounce (email verifier) are the two adapters. Each takes an
injected `fetch`, so the contract tests in `providers.test.ts` run on fixtures with no network; the
live tests there run only when `APOLLO_LIVE_KEY` / `ZEROBOUNCE_LIVE_KEY` are set. An adapter never
retries: the waterfall's `callWithRetry` owns timeout and retry. Errors carry fixed words, never a
URL or vendor text (ZeroBounce takes its key in the query string). `circuit.ts` opens after
`PROVIDER_CIRCUIT_FAILURES` consecutive outage-like failures per provider and lets one trial through
after `PROVIDER_CIRCUIT_OPEN_MS`; a rejected key does not count. It is in this process, not shared.

Settings routes: `GET /v1/enrichment/providers`, `PUT /v1/enrichment/providers/{provider}` (key is
write-only, sealed by the secret box bound to Organization and provider; omitted keeps, null removes),
`GET`/`PUT /v1/enrichment/waterfall`. The db has no version column, so the waterfall `version` is
derived from the stored order (0 while none is stored); a stale `expectedVersion` is
`enrichment.version_conflict`, and a replay of the same order is accepted. Outside `local` the
secret box needs `MAIL_SECRET_BOX_KEY`-style configuration; unconfigured, setting a key answers
`server.unavailable`.

## Hot paths

`POST /v1/enrichment-runs` (`bench/enrichment.bench.test.ts`): O(k) in the Prospects named (at most
500), never in the Organization's size. One visibility check, one idempotency lookup, one insert and
the queue publish in batches of ten. The waterfall itself runs from the queue, off the request path.
The per-request middleware stack (`createBaseApp`) and `/healthz` keep the budgets in `bench/`.

A benchmark times `measure(operation)`: a warm-up, then several batches, gated on the fastest, so a
noisy runner cannot fail it but a real regression (every batch slower) does. Budget is about 5x the
typical best batch, written in the file. `bun run bench` is part of `verify`. Add a benchmark and
name the function here when a new hot path appears.

## Issues

All tickets live in the hub: `gh issue list -R Tula-Solutions/tula-closeline --label repo:outbound`.
