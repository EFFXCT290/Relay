# Relay — Monorepo Architecture (Source of Truth)

This document defines the canonical file structure for the Relay codebase.

Designed for:
- Scalable realtime messaging
- Feature isolation
- Clean domain boundaries
- Long-term maintainability

---

## Root Structure

```
Relay/
├── .env
├── .env.example
├── .gitignore
├── docker-compose.yml
├── docker-compose.lean.yml
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── tsconfig.base.json
│
├── Documentation/
│   ├── API_DOCUMENTATION.md
│   ├── ARCHITECTURE.md          ← this file
│   └── RELAY_API_ADDENDUM_v1.1.md
│
├── apps/
│   ├── api/
│   ├── web/
│   └── worker/
│
├── packages/
│   ├── contracts/      ← single source of truth (types + schemas + event names + payloads)
│   ├── database/
│   ├── events/         ← generic typed event bus
│   ├── config/
│   ├── ui/
│   ├── utils/
│   ├── types/          ← (reserved for non-contract types)
│   └── validation/     ← (reserved for non-contract schemas)
│
└── infrastructure/
    ├── docker/
    ├── nginx/
    └── scripts/
```

---

## apps/api — Fastify Backend

```
apps/api/
├── Dockerfile
├── package.json
├── tsconfig.json
│
├── prisma/
│   ├── schema.prisma
│   └── migrations/
│
├── scripts/
│   ├── seed-alerts.ts
│   └── clear-alerts.ts
│
└── src/
    ├── server.ts               ← entry point (listen)
    ├── app.ts                  ← app factory (Fastify setup)
    ├── types.ts
    │
    ├── modules/                ← domain modules
    │   ├── auth/
    │   ├── users/
    │   ├── conversations/
    │   ├── messages/
    │   ├── notifications/
    │   ├── media/
    │   ├── presence/
    │   ├── security/
    │   ├── health/
    │   └── dev/
    │
    ├── sockets/                ← realtime event handlers
    │   ├── index.ts
    │   ├── auth.socket.ts
    │   ├── conversation.socket.ts
    │   ├── message.socket.ts
    │   ├── notification.socket.ts
    │   ├── presence.socket.ts
    │   └── sync.socket.ts
    │
    ├── plugins/                ← Fastify plugins
    │   ├── auth.ts
    │   ├── prisma.ts
    │   ├── redis.ts
    │   └── socket.ts
    │
    ├── backend-core/           ← system internals, split into strict layers
    │   ├── auth/               ← cookies, JWT, refresh tokens
    │   │   ├── cookies.ts
    │   │   └── tokens.ts
    │   ├── crypto/             ← password hashing, future signing
    │   │   └── passwords.ts
    │   ├── http/               ← HTTP-shaped utilities
    │   │   └── errors.ts
    │   ├── runtime/            ← env, format registry
    │   │   ├── env.ts
    │   │   └── formats.ts
    │   └── logging/            ← (reserved)
    │
    ├── jobs/
    └── queues/
```

### Module Structure (Backend Domain Standard)

Each module follows this pattern:

```
modules/messages/
├── message.routes.ts        ← HTTP API handlers
├── message.service.ts       ← business logic
├── message.socket.ts        ← realtime event handlers
├── message.repository.ts    ← DB access (Prisma only here)
├── message.schema.ts        ← TypeBox request/response schemas
├── message.types.ts         ← module-local TypeScript types
├── message.utils.ts
└── message.permissions.ts
```

**Rules:**
- `routes` = HTTP API
- `socket` = realtime events, no business logic
- `service` = business logic
- `repository` = DB access — never query Prisma directly in routes/sockets

---

## apps/web — Next.js Frontend

Frontend is **feature-based**, not component-based.

```
apps/web/
├── next.config.ts
├── components.json
├── package.json
│
└── src/
    ├── app/
    │   ├── globals.css
    │   ├── layout.tsx
    │   ├── page.tsx
    │   ├── sign-in/
    │   ├── sign-up/
    │   └── (app)/
    │       ├── layout.tsx
    │       ├── conversations/
    │       ├── alerts/
    │       └── profile/
    │
    ├── features/              ← one folder per domain
    │   ├── auth/
    │   ├── conversations/
    │   ├── messages/
    │   ├── notifications/
    │   ├── media/
    │   └── profile/
    │
    ├── shared/                ← cross-feature shared code
    │   ├── ui/                ← shadcn primitives
    │   ├── components/        ← layout / chrome components
    │   ├── hooks/
    │   └── utils/
    │
    ├── frontend-core/         ← frontend system logic
    │   ├── api.ts
    │   ├── socket.ts
    │   ├── utils.ts
    │   └── api-client/        ← domain-split HTTP clients
    │       ├── http.ts
    │       ├── conversations.ts
    │       └── messages.ts
    │
    ├── stores/
    └── providers/
```

### Feature Structure (Frontend Standard)

Each feature is self-contained:

```
features/messages/
├── components/
│   ├── message-bubble.tsx
│   ├── chat-composer.tsx
│   └── reaction-picker.tsx
│
├── hooks/
│   ├── use-messages.ts
│   └── use-send-message.ts
│
├── api/
│   └── messages.api.ts
│
├── sockets/
│   └── message.events.ts
│
├── stores/
├── types/
├── utils/
└── validators/
```

---

## packages — Shared Logic

### packages/contracts (CRITICAL — single source of truth)

Owns **everything** that crosses the api ↔ web boundary: HTTP request/response
schemas, runtime types, socket event names, AND socket event payload shapes.

```
packages/contracts/
├── src/
│   ├── auth.contract.ts
│   ├── conversations.contract.ts       ← Conversation, CONVERSATION_EVENTS, *Event
│   ├── messages.contract.ts            ← Message, MESSAGE_EVENTS, REACTION_EVENTS, *Event
│   ├── notifications.contract.ts       ← Notification, NOTIFICATION_EVENTS, *Event
│   ├── presence.contract.ts            ← Presence, PRESENCE_EVENTS, *Event
│   ├── users.contract.ts
│   └── index.ts
└── package.json
```

Each contract co-locates **types + schema + event names + event payloads** for its
domain. Both api and web import from `@relay/contracts` — event strings are never
hardcoded, types are never duplicated.

### packages/events

Generic typed event bus (transport-agnostic). Used for cross-cutting wiring
between sockets, services, and worker jobs.

```
packages/events/
└── src/
    ├── bus.ts
    └── index.ts
```

### packages/database

Shared Prisma client singleton.

```
packages/database/
├── prisma/
└── src/
    ├── client.ts
    └── index.ts
```

### packages/config

Cross-app policy constants (token TTLs, bcrypt rounds, etc).

```
packages/config/
└── src/
    ├── auth.ts
    └── index.ts
```

### packages/utils

Framework-agnostic helpers: `date.ts`, `strings.ts`, `crypto.ts`, `paginate.ts`.

### packages/ui

Shared shadcn/ui component wrappers used across web and future apps.

### packages/types / packages/validation

Reserved namespaces for types/schemas that **don't** belong in a domain contract
(e.g. generated types from external services, infrastructure schemas). Most
domain code should use `@relay/contracts` instead.

---

## apps/worker — Background Jobs

```
apps/worker/
└── src/
    ├── jobs/
    ├── queues/
    ├── processors/
    └── workers/
```

Used for: media compression, push notifications, cleanup jobs, scheduled tasks.

---

## infrastructure/

```
infrastructure/
├── docker/
│   ├── api.Dockerfile
│   ├── web.Dockerfile
│   └── worker.Dockerfile
├── nginx/
│   └── relay.conf
└── scripts/
    ├── deploy.sh
    ├── seed.sh
    └── backup.sh
```

---

## Core Architectural Rules

1. **Feature-first frontend** — everything belongs to a feature, not a global folder.
2. **Module-first backend** — no global routes/services split; everything belongs to a domain module.
3. **Contracts are the single source of truth** — types, schemas, event names, and
   event payloads all live in `@relay/contracts`. Never hardcode event strings,
   never duplicate types between api and web, never define a request schema in
   one app that the other has to mirror.
4. **No business logic in sockets** — handlers receive event → call service → emit result.
5. **DB access only in repositories** — never query Prisma directly inside sockets or routes.
6. **Packages are pure** — no app imports, no framework code, no route imports.
   Anything reusable lives here; anything app-specific stays in the app.
7. **Features are frontend boundaries** — never share logic across features
   directly; promote to `shared/` or a feature-owned hook instead.

## Naming discipline

- `apps/api/src/backend-core/` = backend system internals.
- `apps/web/src/frontend-core/` = frontend system logic.
- These names are **deliberately distinct** — there is no shared meaning between
  the two and they never import from each other. The verbose names exist
  precisely to prevent the "which core?" ambiguity.
- `infrastructure/` at the repo root is **deployment infrastructure** only
  (docker, nginx, scripts) — separate concern from either app's core.

## Module discipline

Every domain module (`auth`, `messages`, `conversations`, etc.) owns its full
stack — routes, service, repository, socket. The empty domain modules
(`media`, `presence`, `security`) are pre-scaffolded with the standard pattern
files (`{name}.routes.ts`, `{name}.service.ts`, `{name}.repository.ts`,
`{name}.socket.ts`) so the layout enforces the rules:

- HTTP handlers go in `{name}.routes.ts`, never inline business logic.
- Business logic goes in `{name}.service.ts`.
- DB/Redis access goes **only** in `{name}.repository.ts`.
- Realtime handlers go in `{name}.socket.ts`, delegating to the service.

## Socket discipline

Files in `apps/api/src/sockets/` and module-level `{name}.socket.ts` are
**transport only**. Every handler is the same shape:

```ts
socket.on(EVENT_NAME, withAck(socket, async (env) => {
  // 1. (validate via TypeBox if needed)
  // 2. call service
  // 3. let service emit downstream
}));
```

**Forbidden inside socket files:**
- Prisma / Redis access
- Business rules (who can do what, when)
- Payload transformations
- Direct `io.emit()` calls — emission policy lives in the service

Sockets in `apps/api/src/sockets/` are thin wiring/registration; if a domain
needs handler logic it lives in `modules/{name}/{name}.socket.ts` and the
top-level file just re-exports the `register{Name}Socket` function. The
single entry point `apps/api/src/sockets/index.ts` exposes
`registerAllSocketHandlers(socket, fastify, userId)` which `plugins/socket.ts`
calls once per connection.

## Presence — service-driven by design

Presence is the easiest module to accidentally couple to the socket layer
(connect = online, disconnect = offline). To prevent that:

- **`PresenceService`** owns all state transitions, all broadcast policy, and
  is fully testable without a socket — call `markOnline(userId)` from any
  context (HTTP heartbeat, background job, etc.) and the right things happen.
- **`PresenceRepository`** keeps state in Redis (with TTL-based dead-connection
  cleanup) — never in Postgres, never in module-local memory.
- **`presence.socket.ts`** has exactly two lines of logic: call
  `service.markOnline(userId)` on connect, `service.markOffline(userId)` on
  disconnect. Nothing else.

If a module needs schemas or types beyond what `@relay/contracts` provides, add
`{name}.schema.ts` / `{name}.types.ts` — but cross-app concerns belong in
contracts, not the module.

---

## Realtime reliability layer

Every realtime event flows through an envelope so it can be ACK'd, retried,
and replayed after disconnect. The wire format lives in
`packages/contracts/src/realtime.contract.ts` and is used identically by api,
web, and (future) worker.

```
EventEnvelope<T> = { eventId, eventName, payload: T, timestamp, attempts? }
Ack              = { eventId, status: "ok" | "error", error? }
```

### Pieces

| Concern             | Location                                                    |
| ------------------- | ----------------------------------------------------------- |
| Envelope / Ack / replay shapes | `packages/contracts/src/realtime.contract.ts`    |
| Server ACK helper   | `apps/api/src/sockets/ack.ts` (`withAck`, `emitEnvelope`)   |
| Event outbox        | `apps/api/src/modules/sync/sync.repository.ts` (Prisma `EventOutbox`) |
| Replay service      | `apps/api/src/modules/sync/sync.service.ts`                 |
| Replay HTTP route   | `apps/api/src/modules/sync/sync.routes.ts` (`POST /api/sync/replay`) |
| Replay socket       | `apps/api/src/modules/sync/sync.socket.ts` (`SYNC_EVENTS.REPLAY_REQUEST`) |
| Client emitter      | `apps/web/src/frontend-core/reliable.ts` (`emitReliable`)   |
| Client ACK listener | `apps/web/src/frontend-core/reliable.ts` (`bindAckListener`) |
| Reconnect replay    | `apps/web/src/frontend-core/reliable.ts` (`bindReconnectReplay`) |

### Flow — happy path

1. Client calls `emitReliable("message:new", { ... })`.
2. Wrapper creates `EventEnvelope` with new `eventId`, sends, starts ACK timer.
3. Server handler is wrapped in `withAck(socket, async (env) => { ... })`.
4. Server records the envelope in `EventOutbox` (per recipient) and emits to
   each recipient's socket via `emitEnvelope`.
5. Recipient ACKs back; server confirms; original sender's `emitReliable`
   promise resolves.

### Flow — flaky network / disconnect

- If no Ack within `ACK_TIMEOUT_MS + backoff`, sender retries (up to
  `ACK_MAX_ATTEMPTS`). The server's `eventId` deduplication (TODO: enforce in
  `withAck`) keeps retries idempotent.
- On reconnect, `bindReconnectReplay(getCursor, onEnvelope)` emits
  `SYNC_EVENTS.REPLAY_REQUEST` with the last processed timestamp. Server
  streams missed envelopes from `EventOutbox`. Client dispatches each through
  the same handler it would have used live.

### Pending work to make this fully live

- Add the `EventOutbox` Prisma model (sample shown in `sync.repository.ts`)
  and run a migration.
- Wire `withAck` into each existing module socket handler (`message.socket.ts`,
  `conversation.socket.ts`, `notification.socket.ts`).
- Have each emitter (e.g. message send) call `syncService.record(envelope, recipientId)`
  immediately before/after emit.
- Choose a cursor-persistence strategy on the client (localStorage key per user).

---

## Safeguards (enforceable rules)

The five rules below are how this architecture stays coherent under team
pressure. Each has an audit command you can run before a PR ships.

### Safeguard 1 — Contracts are the REAL API layer

If a value crosses the api ↔ web boundary in any way (HTTP, socket, JWT
claim), it MUST live in `@relay/contracts`. No backend types outside contracts.
No frontend duplicate interfaces. No socket payload defined anywhere else.

Audit:
```sh
# Any inline TypeBox Type.Object() inside a route file is a smell —
# route should import its schema from @relay/contracts.
grep -rn "Type\.Object(" apps/api/src/modules --include="*.ts"

# Any wire-shape interface in apps/web outside @relay/contracts is a violation.
# (Local UI types like `type Props` are fine.)
grep -rn "^export type\|^export interface" apps/web/src --include="*.ts" --include="*.tsx"
```

### Safeguard 2 — Sockets are transport-only

Socket files MUST be: receive event → call service → emit result. Nothing
else. No Prisma, no Redis, no `io.emit()`, no business rules, no payload
transformations.

Audit:
```sh
# Any socket file that imports @prisma/client or fastify.io is a violation.
grep -rn "@prisma/client\|fastify\.io\|\.prisma\.\|\.redis\." \
  apps/api/src/sockets apps/api/src/modules/*/*.socket.ts --include="*.ts"
```

### Safeguard 3 — backend-core stays "system-level only"

Every file in `apps/api/src/backend-core/{auth,crypto,http,runtime,logging}`
must answer "yes" to: "is this system-level behavior?" If it's domain logic,
it belongs in `modules/`.

Examples that BELONG: JWT signing, password hashing, cookie shape, env
parsing, format registry.
Examples that DON'T: `notify()` (creates a Notification — domain) was moved
to `modules/notifications/notification.service.ts`.

Audit: scan `backend-core/` quarterly for files that import from `modules/`
or that contain domain vocabulary (Notification, Message, Conversation,
Reaction, etc.).

### Safeguard 4 — sync module is independent

The sync module is the reconciliation engine — it controls message recovery,
offline replay, and (future) multi-device consistency. It MUST NOT depend on
socket internals, frontend logic, or other domain modules.

Audit:
```sh
# sync may only import: contracts, prisma, typebox, fastify, socket.io
# (Socket type), backend-core/http (ProblemError), and its own files.
grep -rn "^import" apps/api/src/modules/sync --include="*.ts" \
  | grep -v "@relay/contracts\|@prisma/client\|@sinclair/typebox\|@fastify\|backend-core/http\|\./sync\.\|from \"fastify\"\|from \"socket\.io\""
```

Result must be empty — any other import means the reconciliation engine has
acquired a cross-module dependency, which makes it impossible to reason
about as the system of record for replay.

### Safeguard 5 — `reliable.ts` mirrors `withAck` exactly

Client retry policy in `apps/web/src/frontend-core/reliable.ts` and server
dedup window in `apps/api/src/sockets/ack.ts` are a single coupled system.
If you change one without the other, you get duplicate deliveries / ghost
events. Both files carry `SAFEGUARD 5 — load-bearing` headers.

Audit checklist when touching either file:
- Are `ACK_TIMEOUT_MS`, `ACK_MAX_ATTEMPTS`, `ACK_BACKOFF_BASE` still sourced
  from `@relay/contracts`? (They must be.)
- Does `withAck`'s dedup window cover all client retry attempts? (Currently
  1024 eventIds × 3 attempts per envelope = ~340 unique envelopes before
  rotation. Raise `DEDUP_WINDOW` (in `@relay/contracts`) if traffic warrants.)
- Does every server-initiated emit also record to the `EventOutbox` so a
  client that misses the emit can recover via replay?

### Safeguard 6 — Contracts contain SHAPE only, never behavior

Each contract file declares its category in a header comment:

| Category   | Files                                                              |
| ---------- | ------------------------------------------------------------------ |
| identity   | `auth.contract.ts`, `users.contract.ts`                             |
| domain     | `messages`, `conversations`, `notifications`, `presence` `.contract.ts` |
| transport  | `realtime.contract.ts`                                              |

Contracts may export: TypeBox schemas, `Static`-derived types, protocol
constants. They MUST NOT export functions, classes, branching logic, or
anything that runs at evaluation time beyond the schema definitions.

Audit:
```sh
# Any function/class in contracts/ is a violation of Safeguard 6.
grep -rn "^export function\|^export class\|^export async\|^function \|^class " \
  packages/contracts/src --include="*.ts"
```

Result must be empty.

### Safeguard 7 — `reliable.ts` and `ack.ts` evolve as one unit

These two files implement the same protocol from opposite ends. They both
import all timing constants from `@relay/contracts` (`ACK_TIMEOUT_MS`,
`ACK_MAX_ATTEMPTS`, `ACK_BACKOFF_BASE`, `DEDUP_WINDOW`) so changing the
protocol means changing the contract, not the consumers.

**Process rule**: any PR that touches one MUST touch the other (or
explicitly state why drift is intentional and reviewed). Both files carry
explicit `SAFEGUARD 5 — load-bearing` headers with cross-references.

Audit:
```sh
# DEDUP_WINDOW or ACK_* defined locally outside contracts is a violation.
grep -rn "^const DEDUP_WINDOW\|^const ACK_" \
  apps/api/src apps/web/src --include="*.ts" --include="*.tsx" \
  | grep -v "import\|@relay/contracts"
```

Result must be empty — all reliability constants live in contracts only.

### Safeguard 8 — ACK is the immutable truth source for sync

The `EventOutbox` row written when an envelope is emitted carries
`ackedAt: null`. Only the recipient confirming via `ACK_EVENT` flips it to a
timestamp. **Replay returns ONLY rows where `ackedAt IS NULL`** — events the
ACK protocol confirms were delivered are never re-emitted, regardless of
cursor position. This is what prevents sync and ack from disagreeing about
what's been delivered.

End-to-end flow:
1. Service emits envelope, calls `syncService.record(envelope, recipientId)` first.
2. Client processes envelope, sends `Ack{eventId, status: "ok"}`.
3. `registerSyncSocket`'s ACK listener calls `syncService.markAcked(eventId, recipientId)`.
4. Future `replayFor()` calls skip this eventId forever — ackedAt is non-null.

If `record()` is skipped before an emit, OR if `markAcked()` is skipped
after an ACK, the invariant breaks. Both pairings are enforced in the
sync module's docstring.

Audit:
```sh
# Any emit-shaped function in api code that fails to call syncService.record
# before/after is suspicious. (Hand audit — no clean grep for absence.)
# But: any direct INSERT into EventOutbox outside sync.repository.ts is a violation.
grep -rn "eventOutbox\.create\|EventOutbox.*create" \
  apps/api/src --include="*.ts" | grep -v "sync/sync.repository.ts"
```

Result must be empty.

### Safeguard 9 — Presence is a UI signal, NOT system truth

`PresenceService` answers "is this user's socket currently connected?".
That's it. The following are **forbidden** uses of presence anywhere in the
codebase:

- Gating message delivery on "is the recipient online"
- Deciding what gets replayed on reconnect
- Mutating unread counts based on presence
- Authorization / permission checks

System truth lives in `modules/messages/`, `modules/sync/`, and the
`EventOutbox`. Presence is a hint for UIs (the green dot, "active now"
labels) — never the basis for a state transition.

Audit:
```sh
# Any non-presence module reading PresenceService is a smell. Hand-review.
grep -rn "PresenceService\|presence\.service\|modules/presence" \
  apps/api/src --include="*.ts" \
  | grep -v "modules/presence/\|sockets/presence\."
```

Result should be empty (or only registration calls in `sockets/index.ts`).
