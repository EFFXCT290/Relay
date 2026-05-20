# Relay — Secure Direct Messaging API
> Version: 1.0.0 | Last Updated: 2026-02-19

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Security Model](#security-model)
3. [Tech Stack](#tech-stack)
4. [Environment Configuration](#environment-configuration)
5. [Database Schema](#database-schema)
6. [Authentication](#authentication)
7. [Users](#users)
8. [Conversations](#conversations)
9. [Messages](#messages)
10. [Media](#media)
11. [Screen Capture Detection](#screen-capture-detection)
12. [Notifications](#notifications)
13. [WebSocket Events](#websocket-events)
14. [Error Codes](#error-codes)
15. [Rate Limiting](#rate-limiting)
16. [Deployment Notes](#deployment-notes)
17. [Honest Security Caveats](#honest-security-caveats)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Client (Browser)                           │
│  HTTPOnly Cookie (JWT) + SameSite=Strict + Secure + HSTS           │
└────────────────────────────┬────────────────────────────────────────┘
                             │ HTTPS only
┌────────────────────────────▼────────────────────────────────────────┐
│                     Fastify API Server (Node.js)                    │
│  JWT HS256 · Argon2id + SHA-256 + 32-byte salt · Rate Limiting     │
└──────┬────────────────┬──────────────┬─────────────────────────────┘
       │                │              │
┌──────▼──────┐  ┌──────▼──────┐  ┌───▼──────────────────────────────┐
│  PostgreSQL  │  │    Redis    │  │         MinIO (S3-compat)        │
│  (Prisma)   │  │  Sessions   │  │  Encrypted media blobs           │
│  Core data  │  │  Pub/Sub    │  │  Signed expiring URLs            │
└─────────────┘  │  Rate Limit │  └──────────────────────────────────┘
                 │  WS state   │
                 └─────────────┘
```

**Runtime**: Node.js 22 LTS  
**Framework**: Fastify 4.x (faster than Express, built-in schema validation)  
**ORM**: Prisma 5.x  
**Real-time**: Socket.IO 4.x over WSS  

---

## Security Model

### Password Hashing Pipeline

Every password goes through a two-phase hardening process before storage:

```
plaintext password
        │
        ▼
┌───────────────────────────────────────────────────────┐
│  Phase 1 — SHA-256 pre-hash                           │
│  Reason: Argon2 has a 72-character input limit on     │
│  some implementations. SHA-256 normalises any         │
│  length to a fixed 32-byte hex string safely.         │
│                                                       │
│  sha256Input = SHA-256( userSalt + plaintext )        │
└───────────────────────────────┬───────────────────────┘
                                │
                                ▼
┌───────────────────────────────────────────────────────┐
│  Phase 2 — Argon2id                                   │
│  storedHash = Argon2id( sha256Input )                 │
│                                                       │
│  Parameters (OWASP 2024 recommended):                 │
│    memoryCost : 65536 (64 MB)                         │
│    timeCost   : 3 iterations                          │
│    parallelism: 4                                     │
│    hashLength : 32 bytes                              │
│    type       : argon2id (side-channel + GPU hardened)│
└───────────────────────────────────────────────────────┘
```

**Salt spec**: Each user receives a unique 32-byte (256-bit) salt generated via `crypto.randomBytes(32)` and stored in hex (64 chars). This matches SHA-256's output width, providing maximum entropy with no performance penalty.

### JWT Spec

| Property | Value |
|---|---|
| Algorithm | HS256 |
| Expiry | 15 minutes (access token) |
| Refresh | 7 days (stored in separate HTTPOnly cookie) |
| Payload | `{ sub: userId, jti: tokenId, iat, exp }` |
| **No PII in payload** | No email, username, or roles in JWT |
| Secret rotation | Via `JWT_SECRET` env var; old tokens invalidated via `jti` blocklist in Redis |

### Cookie Security

```
Set-Cookie: accessToken=<jwt>; HttpOnly; SameSite=Strict; Secure; Path=/api; Max-Age=900
Set-Cookie: refreshToken=<jwt>; HttpOnly; SameSite=Strict; Secure; Path=/api/auth/refresh; Max-Age=604800
```

- `HttpOnly` — JavaScript cannot access the cookie (XSS mitigation)
- `SameSite=Strict` — Cookie not sent on cross-origin requests (CSRF mitigation)
- `Secure` — Cookie only transmitted over HTTPS
- `Path` scoping — Refresh token only sent to its dedicated refresh endpoint

### HSTS

```
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
```

Applied via Fastify helmet plugin. Disabled on `NODE_ENV=development` (localhost).

---

## Tech Stack

```
Runtime         Node.js 22 LTS
Framework       Fastify 4.x
ORM             Prisma 5.x
Database        PostgreSQL 16
Cache / Pub-Sub Redis 7.x
Object Storage  MinIO (S3-compatible)
Real-time       Socket.IO 4.x
Auth            argon2 (npm), crypto (built-in), jsonwebtoken
Security        @fastify/helmet, @fastify/rate-limit, @fastify/cookie
Media           @aws-sdk/client-s3, @aws-sdk/s3-request-presigner
Validation      Zod (runtime) + Fastify JSON Schema (compile-time)
Logging         Pino (structured JSON logs)
Testing         Vitest + Supertest
```

---

## Environment Configuration

```env
# ─── Server ────────────────────────────────────────────────
NODE_ENV=development          # development | production
PORT=3000
HOST=localhost                # 0.0.0.0 in production (behind reverse proxy)
BASE_URL=https://yourdomain.com

# ─── Database ──────────────────────────────────────────────
DATABASE_URL=postgresql://user:password@localhost:5432/relay

# ─── Redis ─────────────────────────────────────────────────
REDIS_URL=redis://localhost:6379

# ─── JWT ───────────────────────────────────────────────────
JWT_SECRET=<min-64-char-random-hex>          # openssl rand -hex 64
JWT_REFRESH_SECRET=<min-64-char-random-hex>  # openssl rand -hex 64
JWT_ACCESS_EXPIRY=900                        # seconds (15 min)
JWT_REFRESH_EXPIRY=604800                    # seconds (7 days)

# ─── MinIO ─────────────────────────────────────────────────
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_USE_SSL=false           # true in production
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET_MEDIA=relay-media

# ─── Media ─────────────────────────────────────────────────
MEDIA_SIGNED_URL_EXPIRY=30    # seconds (short window for 1x-5x media)
MEDIA_MAX_SIZE_MB=100         # per upload

# ─── Security ──────────────────────────────────────────────
BCRYPT_PEPPER=                # leave blank — we use per-user salts with Argon2id
COOKIE_SECRET=<32-char-random>
```

---

## Database Schema

```prisma
// prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id            String   @id @default(uuid())
  username      String   @unique @db.VarChar(30)
  passwordHash  String   // Argon2id output
  passwordSalt  String   @db.Char(64) // 32 bytes hex
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  // Relations
  sentMessages     Message[]       @relation("SentMessages")
  conversations    Participant[]
  notifications    Notification[]
  accessLogs       MediaAccessLog[]

  @@index([username])
}

model Conversation {
  id        String   @id @default(uuid())
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  participants Participant[]
  messages     Message[]
}

model Participant {
  id             String       @id @default(uuid())
  userId         String
  conversationId String
  joinedAt       DateTime     @default(now())

  user         User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  conversation Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)

  @@unique([userId, conversationId])
  @@index([conversationId])
}

model Message {
  id             String      @id @default(uuid())
  conversationId String
  senderId       String
  type           MessageType // TEXT | IMAGE | VIDEO | AUDIO
  body           String?     // text content (nullable for media-only messages)
  replyToId      String?     // direct reply reference
  isEdited       Boolean     @default(false)
  editedAt       DateTime?
  isDeleted      Boolean     @default(false)  // soft delete (undo)
  deletedAt      DateTime?
  viewConfig     Json?        // { viewLimit: 1-5 | null (unlimited), viewCount: 0 }
  createdAt      DateTime    @default(now())

  conversation   Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  sender         User         @relation("SentMessages", fields: [senderId], references: [id])
  replyTo        Message?     @relation("Replies", fields: [replyToId], references: [id])
  replies        Message[]    @relation("Replies")
  media          Media[]
  viewEvents     ViewEvent[]

  @@index([conversationId, createdAt])
  @@index([senderId])
}

enum MessageType {
  TEXT
  IMAGE
  VIDEO
  AUDIO
}

model Media {
  id          String    @id @default(uuid())
  messageId   String
  minioKey    String    @unique // path in MinIO bucket
  mimeType    String
  sizeBytes   BigInt
  durationMs  Int?      // video/audio
  width       Int?
  height      Int?
  createdAt   DateTime  @default(now())

  message     Message    @relation(fields: [messageId], references: [id], onDelete: Cascade)
  accessLogs  MediaAccessLog[]
}

model ViewEvent {
  id          String   @id @default(uuid())
  messageId   String
  viewerId    String
  viewedAt    DateTime @default(now())
  viewNumber  Int      // which view this is (1, 2, 3...)

  message     Message @relation(fields: [messageId], references: [id], onDelete: Cascade)

  @@index([messageId, viewerId])
}

model MediaAccessLog {
  id          String          @id @default(uuid())
  mediaId     String
  userId      String
  action      MediaAction     // VIEW | SCREENSHOT_ATTEMPT | RECORD_ATTEMPT
  detectedAt  DateTime        @default(now())
  metadata    Json?           // { toolHint, userAgent, platform }

  media       Media  @relation(fields: [mediaId], references: [id], onDelete: Cascade)
  user        User   @relation(fields: [userId], references: [id])

  @@index([mediaId])
  @@index([userId])
}

enum MediaAction {
  VIEW
  SCREENSHOT_ATTEMPT
  RECORD_ATTEMPT
}

model Notification {
  id         String           @id @default(uuid())
  userId     String
  type       NotificationType
  payload    Json             // flexible data blob
  isRead     Boolean          @default(false)
  createdAt  DateTime         @default(now())

  user       User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, isRead])
}

enum NotificationType {
  SYSTEM_ALERT          // capture detection
  MESSAGE_RECEIVED
  VIEW_COUNT_UPDATE
  MEDIA_EXPIRED
}

model JtiBlocklist {
  jti       String   @id  // JWT ID to revoke
  expiresAt DateTime

  @@index([expiresAt])
}
```

---

## Authentication

### POST /api/auth/register

Creates a new user account.

**Request Body**
```json
{
  "username": "string (3-30 chars, alphanumeric + underscore)",
  "password": "string (min 12 chars)"
}
```

**Password hashing (server-side)**
```javascript
// 1. Generate unique 32-byte salt
const salt = crypto.randomBytes(32).toString('hex'); // 64 hex chars

// 2. SHA-256 pre-hash  (salt prepended to normalise any password length)
const sha256Input = salt + password;
const preHash = crypto.createHash('sha256').update(sha256Input).digest('hex');

// 3. Argon2id final hash
const passwordHash = await argon2.hash(preHash, {
  type: argon2.argon2id,
  memoryCost: 65536,   // 64 MB
  timeCost: 3,
  parallelism: 4,
  hashLength: 32,
  raw: false,          // include encoded params in output string
});

// 4. Store: { passwordHash, passwordSalt: salt }
```

**Response `201 Created`**
```json
{
  "userId": "uuid",
  "username": "string"
}
```

Sets `accessToken` and `refreshToken` HTTPOnly cookies.

**Response `409 Conflict`** — username taken  
**Response `422 Unprocessable`** — validation failure

---

### POST /api/auth/login

**Request Body**
```json
{
  "username": "string",
  "password": "string"
}
```

**Verification (server-side)**
```javascript
// 1. Fetch user (do NOT reveal whether username exists — use constant-time response)
// 2. Reconstruct pre-hash with stored salt
const sha256Input = user.passwordSalt + password;
const preHash = crypto.createHash('sha256').update(sha256Input).digest('hex');

// 3. Argon2id verify
const valid = await argon2.verify(user.passwordHash, preHash);
```

**JWT generation**
```javascript
// Access token — short lived, no PII
const jti = crypto.randomUUID();
const accessToken = jwt.sign(
  { sub: user.id, jti },
  process.env.JWT_SECRET,
  { algorithm: 'HS256', expiresIn: '15m' }
);

// Refresh token
const refreshJti = crypto.randomUUID();
const refreshToken = jwt.sign(
  { sub: user.id, jti: refreshJti },
  process.env.JWT_REFRESH_SECRET,
  { algorithm: 'HS256', expiresIn: '7d' }
);
```

**Response `200 OK`**
```json
{
  "userId": "uuid",
  "username": "string"
}
```

Sets cookies (see Cookie Security section above).

**Response `401 Unauthorized`** — invalid credentials (same message regardless of which field is wrong)

---

### POST /api/auth/refresh

Uses the `refreshToken` cookie to issue a new access token.

**No request body required** (reads from cookie automatically).

**Response `200 OK`**
```json
{ "ok": true }
```

Rotates both cookies. Old refresh token's `jti` added to Redis blocklist.

**Response `401 Unauthorized`** — expired or revoked refresh token

---

### POST /api/auth/logout

Revokes current tokens.

**Auth**: Required (access token cookie)

**Response `204 No Content`**

Clears both cookies. Adds both `jti`s to Redis blocklist (TTL = remaining token lifetime).

---

### GET /api/auth/me

Returns the authenticated user's profile. Validates JWT without exposing payload data.

**Auth**: Required

**Response `200 OK`**
```json
{
  "userId": "uuid",
  "username": "string",
  "createdAt": "ISO8601"
}
```

---

## Users

### GET /api/users/search?q={query}

Search users by username prefix (for starting new conversations).

**Auth**: Required  
**Query Params**: `q` (min 2 chars), `limit` (default 20, max 50)

**Response `200 OK`**
```json
{
  "users": [
    { "userId": "uuid", "username": "string" }
  ]
}
```

---

### GET /api/users/:userId

Get a public user profile.

**Auth**: Required

**Response `200 OK`**
```json
{
  "userId": "uuid",
  "username": "string",
  "createdAt": "ISO8601"
}
```

---

## Conversations

### POST /api/conversations

Start or retrieve a direct conversation with another user.

**Auth**: Required

**Request Body**
```json
{
  "participantId": "uuid"
}
```

Idempotent — returns existing conversation if one already exists between the two users.

**Response `200 OK` or `201 Created`**
```json
{
  "conversationId": "uuid",
  "participant": {
    "userId": "uuid",
    "username": "string"
  },
  "createdAt": "ISO8601"
}
```

---

### GET /api/conversations

List all conversations for the authenticated user, ordered by most recent message.

**Auth**: Required  
**Query Params**: `cursor` (UUID for pagination), `limit` (default 20, max 50)

**Response `200 OK`**
```json
{
  "conversations": [
    {
      "conversationId": "uuid",
      "participant": { "userId": "uuid", "username": "string" },
      "lastMessage": {
        "messageId": "uuid",
        "type": "TEXT | IMAGE | VIDEO | AUDIO",
        "preview": "string | null",
        "sentAt": "ISO8601"
      },
      "updatedAt": "ISO8601"
    }
  ],
  "nextCursor": "uuid | null"
}
```

---

### GET /api/conversations/:conversationId

Get conversation details and confirm membership.

**Auth**: Required

**Response `200 OK`**
```json
{
  "conversationId": "uuid",
  "participant": { "userId": "uuid", "username": "string" },
  "createdAt": "ISO8601"
}
```

**Response `403 Forbidden`** — caller is not a participant

---

## Messages

### GET /api/conversations/:conversationId/messages

Fetch message history (cursor-based pagination, newest first).

**Auth**: Required  
**Query Params**: `cursor` (messageId), `limit` (default 30, max 100)

**Response `200 OK`**
```json
{
  "messages": [
    {
      "messageId": "uuid",
      "senderId": "uuid",
      "senderUsername": "string",
      "type": "TEXT | IMAGE | VIDEO | AUDIO",
      "body": "string | null",
      "replyTo": {
        "messageId": "uuid",
        "preview": "string | null",
        "type": "string"
      } ,
      "isEdited": false,
      "editedAt": "ISO8601 | null",
      "isDeleted": false,
      "viewConfig": {
        "viewLimit": 3,
        "viewCount": 1,
        "hasExpired": false
      },
      "media": [
        {
          "mediaId": "uuid",
          "mimeType": "image/jpeg",
          "width": 1080,
          "height": 1920
        }
      ],
      "createdAt": "ISO8601"
    }
  ],
  "nextCursor": "uuid | null"
}
```

> **Note**: Media URLs are NOT included in this response. A separate authenticated request to `/api/media/:mediaId/url` is required to get a short-lived signed URL. This prevents link sharing and enforces view limits.

---

### POST /api/conversations/:conversationId/messages

Send a text message.

**Auth**: Required

**Request Body**
```json
{
  "body": "string (max 4000 chars)",
  "replyToId": "uuid | null"
}
```

**Response `201 Created`**
```json
{
  "messageId": "uuid",
  "conversationId": "uuid",
  "senderId": "uuid",
  "type": "TEXT",
  "body": "string",
  "replyTo": null,
  "createdAt": "ISO8601"
}
```

Triggers WebSocket event `message:new` to all conversation participants.

---

### PATCH /api/messages/:messageId

Edit a text message. Only the original sender may edit. Media messages cannot be edited.

**Auth**: Required

**Request Body**
```json
{
  "body": "string (max 4000 chars)"
}
```

**Response `200 OK`**
```json
{
  "messageId": "uuid",
  "body": "string",
  "isEdited": true,
  "editedAt": "ISO8601"
}
```

**Response `403 Forbidden`** — not the sender  
**Response `422 Unprocessable`** — media-type message or expired view-limited message

Triggers WebSocket event `message:edited`.

---

### DELETE /api/messages/:messageId

Soft-delete (undo) a message. Only the original sender. Undo is permanent after 7 days (hard delete via cron).

**Auth**: Required

**Response `204 No Content`**

Triggers WebSocket event `message:deleted`.

---

### POST /api/messages/:messageId/react

Add or toggle an emoji reaction. (Instagram-style, single reaction per user per message.)

**Auth**: Required

**Request Body**
```json
{
  "emoji": "❤️"
}
```

**Response `200 OK`**
```json
{
  "messageId": "uuid",
  "reactions": {
    "❤️": 3,
    "😂": 1
  },
  "myReaction": "❤️ | null"
}
```

Triggers WebSocket event `message:reaction`.

---

## Media

### POST /api/media/upload

Upload a photo or video. The file is stored in MinIO. Returns a `mediaUploadId` that is then attached to a message via `POST /api/conversations/:id/messages/media`.

**Auth**: Required  
**Content-Type**: `multipart/form-data`

**Form Fields**

| Field | Type | Description |
|---|---|---|
| `file` | binary | Image (JPEG/PNG/WEBP/HEIC) or Video (MP4/MOV/WEBM) |
| `viewLimit` | integer | `1`–`5` for ephemeral, `0` for unlimited. Default `0`. |

**Processing pipeline**
```
1. Validate MIME type via file-type (magic bytes, NOT extension)
2. Stream directly to MinIO — never write to local disk
3. Generate a random MinIO object key: media/{uuid}/{uuid}.{ext}
4. Strip EXIF metadata from images (sharp library)
5. Create Media record in PostgreSQL
6. Return mediaUploadId
```

**Response `201 Created`**
```json
{
  "mediaUploadId": "uuid",
  "mimeType": "image/jpeg",
  "sizeBytes": 1048576,
  "width": 1080,
  "height": 1920,
  "durationMs": null
}
```

**Response `413 Payload Too Large`** — exceeds `MEDIA_MAX_SIZE_MB`  
**Response `415 Unsupported Media Type`** — invalid MIME

---

### POST /api/conversations/:conversationId/messages/media

Send a previously uploaded media item as a message.

**Auth**: Required

**Request Body**
```json
{
  "mediaUploadId": "uuid",
  "replyToId": "uuid | null",
  "viewLimit": 1
}
```

`viewLimit` here overwrites the one set during upload (last write wins). Validated server-side to be 0–5.

**Response `201 Created`**
```json
{
  "messageId": "uuid",
  "conversationId": "uuid",
  "senderId": "uuid",
  "type": "IMAGE",
  "viewConfig": {
    "viewLimit": 1,
    "viewCount": 0,
    "hasExpired": false
  },
  "createdAt": "ISO8601"
}
```

---

### GET /api/media/:mediaId/url

Request a short-lived signed URL to view a media item. This endpoint enforces view limits and logs the access.

**Auth**: Required

**View Limit Logic (server-side)**
```
1. Fetch Media + parent Message + viewConfig
2. If viewLimit > 0:
   a. Count ViewEvent rows for (messageId, viewerId)
   b. If count >= viewLimit → 403 Media Expired
   c. Otherwise → INSERT ViewEvent, increment viewCount
3. Generate MinIO presigned GET URL (TTL = MEDIA_SIGNED_URL_EXPIRY seconds, default 30s)
4. Return URL
```

**Response `200 OK`**
```json
{
  "url": "https://...",
  "expiresAt": "ISO8601",
  "viewsUsed": 1,
  "viewsAllowed": 3,
  "isLastView": false
}
```

**Response `403 Forbidden`** — not a conversation participant  
**Response `410 Gone`** — viewLimit reached (media expired for this user)

> **Design note**: The 30-second signed URL window means even if a URL leaks, it expires almost immediately. The URL is unique per request and single-use from MinIO's perspective.

---

## Screen Capture Detection

### What the Web Platform Can and Cannot Do

> **Honest engineering note — read this carefully before building the frontend.**
>
> Web browsers run in userspace and cannot intercept OS-level screenshot or screen recording tools (Snipping Tool, Win+Shift+S, Cmd+Shift+3/4, OBS, etc.). Any claim that a web app "blocks" these is false. What we **can** do:
>
> 1. **Detect** the `visibilitychange` event and clear the DOM immediately when the tab loses focus
> 2. **Detect** the Page Visibility API / document hidden state
> 3. **Use Canvas-based rendering** (not `<img>` tags) so the media is never present as a raw DOM element that devtools can inspect
> 4. **Inject forensic watermarks** (invisible steganographic user ID watermark baked into the served image/video frame) — this doesn't prevent saving but enables identification after the fact
> 5. **Log access patterns** — every signed URL fetch is logged with timestamp, user agent, and platform
> 6. **Client-side JS signals** — the frontend reports `visibilitychange` bursts, Capture API detection attempts, and `print` events via the report endpoint below
> 7. **For video**: Use the Media Capture and Streams API's `MediaStream.active` listener and pause on blur
>
> For true hardware-level protection you would need a native app with DRM (Widevine L1/PlayReady SL3). This is noted in the roadmap.

---

### POST /api/media/:mediaId/capture-report

The frontend client calls this when it detects a potential capture event. The server logs it and notifies the original sender.

**Auth**: Required

**Request Body**
```json
{
  "eventType": "SCREENSHOT_ATTEMPT | RECORD_ATTEMPT",
  "metadata": {
    "trigger": "visibilitychange | print | captureapi_detected | devtools_open",
    "userAgent": "string",
    "platform": "string",
    "timestamp": "ISO8601"
  }
}
```

**Server Logic**
```
1. Validate reporterId is a conversation participant
2. Insert MediaAccessLog row
3. Fetch original message sender
4. If sender != reporterId:
   a. Create Notification for sender:
      type: SYSTEM_ALERT
      payload: {
        capturedBy: { userId, username },
        eventType,
        trigger,
        timestamp,
        mediaId,
        thumbnailUrl: <signed 60s URL to the media>
      }
   b. Push notification via Socket.IO to sender's room
5. Return 204
```

**Response `204 No Content`**

---

### Watermarking Strategy (Implementation Guide)

All media served to users is invisibly watermarked on-the-fly before the signed URL is generated:

```
For images:
  - Use sharp to composite an invisible LSB (Least Significant Bit)
    steganographic watermark encoding: userId + mediaId + timestamp
  - Stored in MinIO as the watermarked version per-viewer
  - MinIO key: media/{mediaId}/wm_{viewerId}_{timestamp}.jpg

For video (future):
  - Frame-level watermarking using FFmpeg
  - Unique per-viewer per-view stream
```

This means if a screenshot is shared anywhere, the userId can be recovered forensically.

---

## Notifications

### GET /api/notifications

Get paginated notifications for the authenticated user.

**Auth**: Required  
**Query Params**: `cursor`, `limit` (default 20), `unreadOnly` (boolean)

**Response `200 OK`**
```json
{
  "notifications": [
    {
      "notificationId": "uuid",
      "type": "SYSTEM_ALERT",
      "isRead": false,
      "payload": {
        "capturedBy": { "userId": "uuid", "username": "alice" },
        "eventType": "SCREENSHOT_ATTEMPT",
        "trigger": "visibilitychange",
        "timestamp": "ISO8601",
        "mediaId": "uuid",
        "thumbnailUrl": "https://..."
      },
      "createdAt": "ISO8601"
    }
  ],
  "unreadCount": 3,
  "nextCursor": "uuid | null"
}
```

---

### PATCH /api/notifications/:notificationId/read

Mark a notification as read.

**Auth**: Required  
**Response `204 No Content`**

---

### PATCH /api/notifications/read-all

Mark all notifications as read.

**Auth**: Required  
**Response `204 No Content`**

---

## WebSocket Events

Connect via Socket.IO at `wss://yourdomain.com` with `{ withCredentials: true }`. The server authenticates the socket using the same HTTPOnly access token cookie.

### Connection Auth Flow

```javascript
// Server middleware (Socket.IO)
io.use(async (socket, next) => {
  const token = socket.request.headers.cookie
    // parse the accessToken cookie (no JS access — done server-side)
    ?.split(';')
    .find(c => c.trim().startsWith('accessToken='))
    ?.split('=')[1];

  if (!token) return next(new Error('Unauthorized'));
  
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    // Check jti not in Redis blocklist
    const blocked = await redis.get(`jti:${payload.jti}`);
    if (blocked) return next(new Error('Token revoked'));
    socket.userId = payload.sub;
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});
```

On connect, the server automatically joins the socket to `user:{userId}` room.

---

### Events — Server → Client

| Event | Payload | Description |
|---|---|---|
| `message:new` | `{ message }` | New message in a conversation |
| `message:edited` | `{ messageId, body, editedAt }` | Message was edited |
| `message:deleted` | `{ messageId }` | Message was soft-deleted |
| `message:reaction` | `{ messageId, reactions, actorId }` | Reaction added/removed |
| `media:view_update` | `{ messageId, viewCount, hasExpired }` | View count changed |
| `notification:new` | `{ notification }` | New notification (e.g., capture alert) |
| `typing:start` | `{ conversationId, userId }` | User started typing |
| `typing:stop` | `{ conversationId, userId }` | User stopped typing |

### Events — Client → Server

| Event | Payload | Description |
|---|---|---|
| `conversation:join` | `{ conversationId }` | Join a conversation room |
| `conversation:leave` | `{ conversationId }` | Leave a conversation room |
| `typing:start` | `{ conversationId }` | Broadcast typing indicator |
| `typing:stop` | `{ conversationId }` | Stop typing indicator |

---

## Error Codes

All errors follow RFC 9457 (Problem Details):

```json
{
  "type": "https://yourdomain.com/errors/unauthorized",
  "title": "Unauthorized",
  "status": 401,
  "detail": "Access token is missing or invalid.",
  "instance": "/api/conversations/abc123"
}
```

| Status | Code | Meaning |
|---|---|---|
| 400 | `bad_request` | Malformed request body |
| 401 | `unauthorized` | Missing or invalid JWT |
| 403 | `forbidden` | Valid JWT but insufficient permission |
| 404 | `not_found` | Resource does not exist |
| 409 | `conflict` | Username already taken |
| 410 | `gone` | Media view limit reached |
| 413 | `payload_too_large` | File exceeds size limit |
| 415 | `unsupported_media_type` | Invalid file type |
| 422 | `validation_error` | Schema validation failure |
| 429 | `rate_limited` | Too many requests |
| 500 | `internal_error` | Server error (details logged, not exposed) |

---

## Rate Limiting

Implemented via `@fastify/rate-limit` backed by Redis.

| Route Group | Limit | Window |
|---|---|---|
| `POST /api/auth/login` | 5 requests | 15 minutes (per IP) |
| `POST /api/auth/register` | 3 requests | 1 hour (per IP) |
| `POST /api/auth/refresh` | 10 requests | 15 minutes (per IP) |
| `POST /api/media/upload` | 20 requests | 1 minute (per user) |
| `POST /api/conversations/*/messages` | 60 requests | 1 minute (per user) |
| All other authenticated routes | 300 requests | 1 minute (per user) |

Failed login attempts are tracked separately: 10 consecutive failures triggers a 30-minute soft lockout for that username (stored in Redis).

---

## Deployment Notes

### Local Development

```bash
# Start dependencies
docker compose up -d postgres redis minio

# Apply migrations
npx prisma migrate dev

# Seed buckets
node scripts/seed-minio.js

# Start server (HTTP on localhost — HSTS disabled in dev)
npm run dev
```

### Production

```nginx
# Nginx reverse proxy config
server {
  listen 443 ssl http2;
  server_name yourdomain.com;

  ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
  ssl_protocols       TLSv1.3;
  ssl_prefer_server_ciphers off;

  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
  add_header X-Content-Type-Options nosniff always;
  add_header X-Frame-Options DENY always;
  add_header Content-Security-Policy "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' wss://yourdomain.com" always;
  add_header Referrer-Policy no-referrer always;
  add_header Permissions-Policy "camera=(self), microphone=(self), display-capture=()" always;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}

# Redirect HTTP → HTTPS
server {
  listen 80;
  return 301 https://$host$request_uri;
}
```

**Key headers**:
- `Permissions-Policy: display-capture=()` — instructs the browser to block `getDisplayMedia()` from this origin (Screen Capture API). This is enforced by the browser for its own APIs but cannot block OS-level tools.
- `Content-Security-Policy` — restricts media loading to `blob:` URIs only (served from canvas/MSE, not direct `<img src>`)

### PostgreSQL Hardening

```sql
-- Create least-privilege app user
CREATE ROLE relay_app LOGIN PASSWORD 'strong-password';
GRANT CONNECT ON DATABASE relay TO relay_app;
GRANT USAGE ON SCHEMA public TO relay_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO relay_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO relay_app;

-- Deny direct access to sensitive columns via row-level security (optional hardening)
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
```

### MinIO Bucket Policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::relay-media/*"
    }
  ]
}
```

All objects are private. Access is exclusively via server-generated presigned URLs.

---

## Honest Security Caveats

These limitations should be communicated to users and documented internally:

| Threat | Our Mitigation | Hard Limitation |
|---|---|---|
| Screenshot (OS hotkey) | `visibilitychange` clear + forensic watermark + client report | **Cannot be blocked on web.** Requires native app + DRM. |
| Screen recording (OBS, etc.) | Pause on `visibilitychange` + watermark + report | **Cannot be blocked on web.** |
| Snipping Tool / Snip & Sketch | DOM cleared on blur, no raw `<img>` tags | **Cannot be blocked on web.** |
| Browser DevTools inspection | Canvas rendering (no DOM image element), blob: URLs | Determined user can still use DevTools |
| Download via link sharing | 30-second signed URL TTL, per-user URLs | Short window greatly reduces risk |
| Proxy / MITM | TLS 1.3 + HSTS + cert pinning (future native app) | Cannot control user's own network proxy |
| Forensic identification | Steganographic per-viewer watermark in every served media item | Identifies attacker after the fact, does not prevent |
| XSS | HTTPOnly cookies, strict CSP | Eliminates JS-based token theft |
| CSRF | SameSite=Strict cookies | Eliminates cross-origin form submissions |

> **Bottom line**: On the web platform, the best achievable protection for ephemeral media is detection + forensic identification + friction, not true prevention. For genuine hardware-level DRM you need a native mobile/desktop app with OS-level Widevine L1 or PlayReady SL3 integration. This is the same reason Netflix and Spotify require native apps for their highest-quality content.

---

## Roadmap (Post-MVP)

- [ ] End-to-end encryption (Signal Protocol) for message bodies
- [ ] Native iOS/Android apps with Widevine DRM for true screen-record blocking
- [ ] Group conversations (3+ participants)
- [ ] Story-style media (24-hour expiry)
- [ ] Disappearing messages (timer-based deletion)
- [ ] Read receipts
- [ ] Media compression pipeline (FFmpeg on upload)
- [ ] CDN edge caching for watermarked thumbnails
- [ ] PayloadCMS integration for admin dashboard

---

*Document maintained by the Relay engineering team. All security decisions should be reviewed by a qualified security engineer before production deployment.*
