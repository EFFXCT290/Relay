# Relay API — Addendum v1.1
> Extends `API_DOCUMENTATION.md` v1.0.0 | Updated: 2026-05-16
>
> **Covers**: Media compression pipeline (FFmpeg), Read receipts, Last seen

---

## Table of Contents

1. [Schema Changes](#schema-changes)
2. [Media Pipeline](#media-pipeline)
3. [Read Receipts](#read-receipts)
4. [Last Seen](#last-seen)
5. [Updated WebSocket Events](#updated-websocket-events)
6. [Updated Environment Variables](#updated-environment-variables)
7. [Roadmap — Removals](#roadmap-removals)

---

## Schema Changes

### Media Model (replaces v1.0 Media model entirely)

```prisma
model Media {
  id            String        @id @default(uuid())
  messageId     String
  minioKey      String        @unique   // media/{uuid}/file.{ext} — one file, always
  quality       MediaQuality            // ORIGINAL | COMPRESSED — sender's choice, immutable
  mimeType      String
  sizeBytes     BigInt                  // final file size (set once READY)
  status        MediaStatus   @default(READY)
  durationMs    Int?                    // video/audio only
  width         Int?                    // image/video only
  height        Int?                    // image/video only
  createdAt     DateTime      @default(now())

  message       Message       @relation(fields: [messageId], references: [id], onDelete: Cascade)
  accessLogs    MediaAccessLog[]
}

enum MediaQuality {
  ORIGINAL     // file stored exactly as received — no processing of any kind
  COMPRESSED   // file processed through FFmpeg pipeline before storage
}

enum MediaStatus {
  PROCESSING   // FFmpeg job running — file not yet in MinIO (COMPRESSED only)
  READY        // file is in MinIO and fully servable
  FAILED       // FFmpeg job failed — no file in MinIO, sender must retry
}
```

> **Note**: The v1.0 `minioKey` column is retained but the key format changes from
> `media/{uuid}/{uuid}.{ext}` to `media/{uuid}/file.{ext}`. Run a data migration to
> update existing rows if you have any. The new format is simpler — one canonical path
> per media record, no ambiguity.

### New Models

```prisma
// ─── Read Receipts ────────────────────────────────────────────────────────────

model MessageRead {
  id          String   @id @default(uuid())
  messageId   String
  readerId    String
  readAt      DateTime @default(now())

  message     Message  @relation(fields: [messageId], references: [id], onDelete: Cascade)
  reader      User     @relation(fields: [readerId], references: [id])

  @@unique([messageId, readerId])   // one receipt per user per message
  @@index([messageId])
  @@index([readerId])
}

// ─── Last Seen ────────────────────────────────────────────────────────────────

model UserPresence {
  userId      String   @id
  lastSeenAt  DateTime @updatedAt
  isOnline    Boolean  @default(false)

  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

### Updated Existing Models

```prisma
model Message {
  // ... all existing fields unchanged ...
  reads       MessageRead[]   // add
}

model User {
  // ... all existing fields unchanged ...
  reads       MessageRead[]   // add
  presence    UserPresence?   // add
}
```

### Migration

```bash
npx prisma migrate dev --name "media_quality_read_receipts_last_seen"
```

---

## Media Pipeline

### Design Principles

- The sender chooses quality at upload time: **lossless** (`original`) or **compressed**.
- The server stores exactly **one file** per media item — whichever the sender chose.
- If the sender chooses `original`, the file is streamed directly to MinIO with **zero modification** — no FFmpeg, no resizing, no metadata stripping, nothing. The exact bytes received are the exact bytes stored.
- If the sender chooses `compressed`, FFmpeg processes a temporary copy first, the compressed output is stored as the final file, and the temporary copy is deleted. Only the compressed file ever persists.
- The recipient has no quality toggle. They receive exactly what the sender chose to send.

---

### Quality Flows

#### `quality=original` — Lossless path

```
Client uploads file (quality=original)
        │
        ▼
┌───────────────────────────────────────────────────────┐
│  Validate MIME type via magic bytes                   │
│  Stream file directly to MinIO (no buffering)         │
│  → media/{uuid}/file.{ext}                            │
│  Create Media record:                                 │
│    quality = ORIGINAL                                 │
│    status  = READY                                    │
│    sizeBytes, width, height populated immediately     │
│  Return mediaUploadId                                 │
└───────────────────────────────────────────────────────┘
```

The file is not touched. No sharp, no FFmpeg, no EXIF stripping. The upload handler is a pure passthrough from the multipart stream to MinIO.

---

#### `quality=compressed` — FFmpeg path

```
Client uploads file (quality=compressed)
        │
        ▼
┌───────────────────────────────────────────────────────┐
│  Validate MIME type via magic bytes                   │
│  Stream file to MinIO as temp                         │
│  → media/{uuid}/tmp.{ext}   ← never served           │
│  Create Media record:                                 │
│    quality = COMPRESSED                               │
│    status  = PROCESSING                               │
│    minioKey = media/{uuid}/file.{compressedExt}       │
│               (final path, set now, file not yet there)│
│  Enqueue FFmpeg job in Redis (BullMQ)                 │
│  Return mediaUploadId immediately                     │
└───────────────────────────────────────────────────────┘
        │
        ▼  async — BullMQ worker picks up the job
┌───────────────────────────────────────────────────────┐
│  Download media/{uuid}/tmp.{ext} from MinIO to /tmp   │
│  Run FFmpeg (see targets table below)                 │
│  Upload compressed output to media/{uuid}/file.{ext}  │
│  Delete media/{uuid}/tmp.{ext} from MinIO             │
│  Delete /tmp working files                            │
│  Update Media record:                                 │
│    status    = READY                                  │
│    sizeBytes = compressed file size                   │
│    width, height populated (if image/video)           │
│  Emit media:ready WS event to sender                  │
└───────────────────────────────────────────────────────┘

        On FFmpeg failure:
┌───────────────────────────────────────────────────────┐
│  Delete media/{uuid}/tmp.{ext} from MinIO             │
│  Delete /tmp working files                            │
│  Update Media: status = FAILED                        │
│  Emit media:failed WS event to sender                 │
└───────────────────────────────────────────────────────┘
```

At every point, MinIO contains either zero files (PROCESSING/FAILED) or exactly one file (READY) per media record. No duplicates at any stage.

---

### FFmpeg Compression Targets

| Input | Output format | Parameters |
|---|---|---|
| JPEG / WEBP / HEIC | JPEG | Max 1920px long edge, `-q:v 2` (≈85% quality) |
| PNG | PNG | Max 1920px long edge, lossless resize only |
| MP4 / MOV / WEBM | MP4 (H.264) | Max 1080p, 30fps, CRF 28, AAC 128kbps, `+faststart` |
| MP3 / AAC / WAV / OGG | AAC (.m4a) | 128kbps |

**FFmpeg commands:**

```bash
# JPEG / WEBP / HEIC → JPEG
ffmpeg -i input \
  -vf "scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease" \
  -q:v 2 -frames:v 1 output.jpg

# PNG → PNG (resize only, no re-encode)
ffmpeg -i input.png \
  -vf "scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease" \
  output.png

# Video → MP4
ffmpeg -i input \
  -vf "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease,fps=30" \
  -c:v libx264 -crf 28 -preset fast -movflags +faststart \
  -c:a aac -b:a 128k \
  output.mp4

# Audio → AAC
ffmpeg -i input -c:a aac -b:a 128k output.m4a
```

---

### POST /api/media/upload *(replaces v1.0)*

**Auth**: Required
**Content-Type**: `multipart/form-data`

**Form Fields**

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | binary | ✅ | Image (JPEG/PNG/WEBP/HEIC), Video (MP4/MOV/WEBM), Audio (MP3/AAC/WAV/OGG) |
| `viewLimit` | integer | ❌ | `1`–`5` ephemeral, `0` unlimited. Default `0`. |
| `quality` | string | ✅ | `"original"` or `"compressed"` |

**Server Logic**

```typescript
if (quality === 'original') {
  // Pure passthrough — stream directly to MinIO, no processing
  const key = `media/${uuid}/file${ext}`;
  await s3.upload({ Bucket: BUCKET, Key: key, Body: fileStream });
  await prisma.media.create({
    data: { minioKey: key, quality: 'ORIGINAL', status: 'READY', sizeBytes, mimeType, width, height }
  });
  return res.status(201).json({ mediaUploadId, quality: 'original', status: 'ready', sizeBytes, width, height });
}

if (quality === 'compressed') {
  // Upload temp copy, enqueue FFmpeg, return immediately
  const tmpKey = `media/${uuid}/tmp${ext}`;
  const finalExt = isVideo ? '.mp4' : isAudio ? '.m4a' : '.jpg';
  const finalKey = `media/${uuid}/file${finalExt}`;
  await s3.upload({ Bucket: BUCKET, Key: tmpKey, Body: fileStream });
  await prisma.media.create({
    data: { minioKey: finalKey, quality: 'COMPRESSED', status: 'PROCESSING', mimeType }
    // sizeBytes, width, height are null until READY
  });
  await compressionQueue.add('compress', { mediaId, tmpKey, mimeType });
  return res.status(201).json({ mediaUploadId, quality: 'compressed', status: 'processing' });
}
```

**Response `201 Created` — original**
```json
{
  "mediaUploadId": "uuid",
  "quality": "original",
  "status": "ready",
  "mimeType": "image/jpeg",
  "sizeBytes": 8388608,
  "width": 4032,
  "height": 3024,
  "durationMs": null
}
```

**Response `201 Created` — compressed**
```json
{
  "mediaUploadId": "uuid",
  "quality": "compressed",
  "status": "processing",
  "mimeType": "image/jpeg",
  "sizeBytes": null,
  "width": null,
  "height": null,
  "durationMs": null
}
```

> `sizeBytes`, `width`, and `height` are `null` while `status=processing`. They are
> populated once FFmpeg finishes and the `media:ready` WebSocket event fires with the
> final values.

**Errors**

| Status | Condition |
|---|---|
| `400 Bad Request` | `quality` field missing or not `"original"` / `"compressed"` |
| `413 Payload Too Large` | File exceeds `MEDIA_MAX_SIZE_MB` |
| `415 Unsupported Media Type` | MIME type not in the allowed list |

---

### POST /api/conversations/:conversationId/messages/media *(updated)*

Attach a processed upload to a message. The server enforces that `status=READY` before the message is created — a recipient will never receive a message pointing to a file that doesn't exist.

**Auth**: Required

**Request Body**
```json
{
  "mediaUploadId": "uuid",
  "replyToId": "uuid | null",
  "viewLimit": 1
}
```

**Error responses added:**

| Status | Condition |
|---|---|
| `409 Conflict` | `status=PROCESSING` — sender must wait for `media:ready` before sending |
| `410 Gone` | `status=FAILED` — sender must re-upload |

**Response `201 Created`** — same shape as v1.0, with `quality` added:
```json
{
  "messageId": "uuid",
  "conversationId": "uuid",
  "senderId": "uuid",
  "type": "IMAGE",
  "quality": "original",
  "viewConfig": {
    "viewLimit": 1,
    "viewCount": 0,
    "hasExpired": false
  },
  "createdAt": "ISO8601"
}
```

---

### GET /api/media/:mediaId/status *(new)*

Poll compression status. Use as a fallback if the `media:ready` WebSocket event is missed.

**Auth**: Required

**Response `200 OK`**
```json
{
  "mediaId": "uuid",
  "quality": "compressed",
  "status": "processing | ready | failed",
  "sizeBytes": null
}
```

`sizeBytes` is `null` while `status=processing`, populated once `status=ready`.

---

### GET /api/media/:mediaId/url *(updated)*

No `?quality=` parameter — there is only one file to serve. Returns a signed URL for whatever is stored at `minioKey`.

**Response `200 OK`**
```json
{
  "url": "https://...",
  "expiresAt": "ISO8601",
  "quality": "original",
  "sizeBytes": 8388608,
  "viewsUsed": 1,
  "viewsAllowed": 3,
  "isLastView": false
}
```

| Status | Condition |
|---|---|
| `409 Conflict` | `status=PROCESSING` (guarded — should not be reachable post-send) |
| `410 Gone` | View limit reached |

---

### BullMQ Worker

**Install:**
```bash
npm install bullmq fluent-ffmpeg @ffmpeg-installer/ffmpeg
```

```typescript
// workers/compression.worker.ts
import { Worker } from 'bullmq';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { prisma } from '../lib/prisma';
import { s3 } from '../lib/minio';
import { io } from '../lib/socket';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const BUCKET = process.env.MINIO_BUCKET_MEDIA!;

const worker = new Worker('media-compression', async (job) => {
  const { mediaId, tmpKey, mimeType } = job.data;

  const isVideo = mimeType.startsWith('video/');
  const isAudio = mimeType.startsWith('audio/');
  const outputExt = isVideo ? '.mp4' : isAudio ? '.m4a' : '.jpg';

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-'));
  const inputPath = path.join(tmpDir, `input${path.extname(tmpKey)}`);
  const outputPath = path.join(tmpDir, `output${outputExt}`);

  // finalKey matches what was written to media.minioKey at upload time
  const finalKey = tmpKey.replace(/\/tmp\.[^.]+$/, `/file${outputExt}`);

  try {
    // 1. Download temp file from MinIO
    const obj = await s3.getObject({ Bucket: BUCKET, Key: tmpKey });
    await fs.writeFile(inputPath, obj.Body as Buffer);

    // 2. Run FFmpeg
    await new Promise<void>((resolve, reject) => {
      const cmd = ffmpeg(inputPath);

      if (isVideo) {
        cmd
          .videoFilters(
            "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease,fps=30"
          )
          .videoCodec('libx264')
          .addOption('-crf', '28')
          .addOption('-preset', 'fast')
          .addOption('-movflags', '+faststart')
          .audioCodec('aac')
          .audioBitrate('128k');
      } else if (isAudio) {
        cmd.audioCodec('aac').audioBitrate('128k');
      } else {
        // Images
        cmd
          .videoFilters(
            "scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease"
          )
          .addOption('-q:v', '2')
          .frames(1);
      }

      cmd.save(outputPath).on('end', resolve).on('error', reject);
    });

    // 3. Upload compressed output to MinIO at final key
    const compressedData = await fs.readFile(outputPath);
    const contentType = isVideo ? 'video/mp4' : isAudio ? 'audio/aac' : 'image/jpeg';
    await s3.putObject({ Bucket: BUCKET, Key: finalKey, Body: compressedData, ContentType: contentType });

    // 4. Delete the temp file — original is gone, only compressed remains
    await s3.deleteObject({ Bucket: BUCKET, Key: tmpKey });

    // 5. Update Media record
    await prisma.media.update({
      where: { id: mediaId },
      data: {
        status: 'READY',
        sizeBytes: BigInt(compressedData.byteLength),
        // width/height: read from outputPath with sharp/ffprobe before deletion if needed
      },
    });

    // 6. Notify sender
    const media = await prisma.media.findUnique({
      where: { id: mediaId },
      include: { message: true },
    });
    io.to(`user:${media!.message.senderId}`).emit('media:ready', {
      mediaId,
      sizeBytes: compressedData.byteLength,
    });

  } catch (err) {
    // Clean up temp from MinIO — leave no orphaned files
    await s3.deleteObject({ Bucket: BUCKET, Key: tmpKey }).catch(() => {});

    await prisma.media.update({ where: { id: mediaId }, data: { status: 'FAILED' } });

    const media = await prisma.media.findUnique({
      where: { id: mediaId },
      include: { message: true },
    }).catch(() => null);

    if (media) {
      io.to(`user:${media.message.senderId}`).emit('media:failed', { mediaId });
    }

    throw err; // rethrow so BullMQ marks job as failed and can retry
  } finally {
    // Always clean up /tmp regardless of success or failure
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}, {
  connection: { url: process.env.REDIS_URL },
  concurrency: parseInt(process.env.COMPRESSION_CONCURRENCY ?? '3'),
});

export default worker;
```

**Add to `ecosystem.config.js`:**
```json
{
  "name": "relay-compression-worker",
  "script": "dist/workers/compression.worker.js",
  "instances": 1,
  "env": { "NODE_ENV": "production" }
}
```

---

## Read Receipts

### Behaviour

- A receipt is created when the recipient opens a conversation, not on message delivery.
- Only unread messages sent by the other participant are marked — never your own messages.
- Soft-deleted messages are excluded.
- The sender receives a real-time `message:read` WebSocket event.
- `createMany` with `skipDuplicates: true` handles the race condition of rapid re-opens.

---

### POST /api/conversations/:conversationId/read *(new)*

Mark all unread messages in a conversation as read.

**Auth**: Required
**No request body.**

**Server Logic:**
```typescript
// 1. Verify caller is a participant in conversationId

// 2. Find all unread messages from the other participant
const unread = await prisma.message.findMany({
  where: {
    conversationId,
    senderId: { not: callerId },
    isDeleted: false,
    reads: { none: { readerId: callerId } },
  },
  select: { id: true, senderId: true },
});

if (unread.length === 0) return reply.code(204).send();

const readAt = new Date();

// 3. Bulk insert receipts (skipDuplicates handles race conditions)
await prisma.messageRead.createMany({
  data: unread.map((m) => ({ messageId: m.id, readerId: callerId, readAt })),
  skipDuplicates: true,
});

// 4. Notify each unique sender
const senderIds = [...new Set(unread.map((m) => m.senderId))];
for (const senderId of senderIds) {
  const messageIds = unread.filter((m) => m.senderId === senderId).map((m) => m.id);
  io.to(`user:${senderId}`).emit('message:read', {
    conversationId,
    readBy: callerId,
    messageIds,
    readAt: readAt.toISOString(),
  });
}
```

**Response `204 No Content`**

---

### GET /api/conversations/:conversationId/messages *(updated)*

Each message now includes `readBy`. Only populated on messages the calling user sent — omitted for received messages.

```json
{
  "messages": [
    {
      "messageId": "uuid",
      "senderId": "uuid",
      "senderUsername": "string",
      "type": "TEXT",
      "body": "string",
      "quality": null,
      "readBy": [
        { "userId": "uuid", "readAt": "ISO8601" }
      ],
      "isEdited": false,
      "isDeleted": false,
      "viewConfig": null,
      "media": [],
      "createdAt": "ISO8601"
    }
  ],
  "nextCursor": "uuid | null"
}
```

---

### GET /api/conversations/:conversationId/read-status *(new)*

Returns the last-read message per participant. Useful on initial load to render receipt indicators without scanning full message history.

**Auth**: Required

**Response `200 OK`**
```json
{
  "participants": [
    {
      "userId": "uuid",
      "username": "string",
      "lastReadMessageId": "uuid | null",
      "lastReadAt": "ISO8601 | null"
    }
  ]
}
```

---

## Last Seen

### Behaviour (shipped)

Implemented in `apps/api/src/modules/presence/` — heartbeat-driven, **not** the request-hook design sketched below. See `docs/task-5-presence.md` for the end-to-end flow.

- **Online** = a Redis `presence:heartbeat:{userId}` key exists (`EX 30s`, refreshed by the client's `presence:ping` every 10s). Existence ⇒ online; never a stored boolean.
- **`lastSeenAt`** is durable in Postgres `UserPresence`, written **only** by the presence service (throttled on heartbeats, flushed on the offline transition) — there is no `onRequest` hook updating it.
- Events are `presence:online {userId}` / `presence:offline {userId, lastSeen}`, broadcast via `io.emit` to all clients.
- ⚠️ **Not yet implemented:** per-conversation visibility gating, targeted (`user:<id>`-room) fan-out, the single `presence:update` event, and `GET /api/users/:userId/presence`. The code blocks below are the original aspirational sketch, retained for reference only.

---

### Fastify Hook *(superseded sketch — not implemented)*

```typescript
// plugins/presence.ts
fastify.addHook('onRequest', async (request) => {
  if (!request.userId) return; // skip unauthenticated routes
  // Fire-and-forget — never blocks the request
  prisma.userPresence.upsert({
    where: { userId: request.userId },
    create: { userId: request.userId, lastSeenAt: new Date(), isOnline: false },
    update: { lastSeenAt: new Date() },
  }).catch(() => {});
});
```

### Socket.IO Presence

```typescript
io.on('connection', async (socket) => {
  const userId = socket.userId;
  socket.join(`user:${userId}`);

  const connectedAt = new Date();
  await prisma.userPresence.upsert({
    where: { userId },
    create: { userId, isOnline: true, lastSeenAt: connectedAt },
    update: { isOnline: true, lastSeenAt: connectedAt },
  });

  const partners = await getConversationPartners(userId); // fetch from DB once on connect
  for (const partnerId of partners) {
    io.to(`user:${partnerId}`).emit('presence:update', {
      userId, isOnline: true, lastSeenAt: connectedAt.toISOString(),
    });
  }

  socket.on('disconnect', async () => {
    const seenAt = new Date();
    await prisma.userPresence.update({
      where: { userId },
      data: { isOnline: false, lastSeenAt: seenAt },
    });
    for (const partnerId of partners) {
      io.to(`user:${partnerId}`).emit('presence:update', {
        userId, isOnline: false, lastSeenAt: seenAt.toISOString(),
      });
    }
  });
});
```

---

### GET /api/users/:userId/presence *(new)*

**Auth**: Required

Returns `403 Forbidden` if the caller shares no conversation with the target user.

**Response `200 OK`**
```json
{
  "userId": "uuid",
  "isOnline": false,
  "lastSeenAt": "ISO8601"
}
```

---

### GET /api/conversations/:conversationId *(updated)*

Participant now includes presence data:

```json
{
  "conversationId": "uuid",
  "participant": {
    "userId": "uuid",
    "username": "string",
    "isOnline": true,
    "lastSeenAt": "ISO8601"
  },
  "createdAt": "ISO8601"
}
```

---

## Updated WebSocket Events

### Server → Client

| Event | Payload | Description |
|---|---|---|
| `message:new` | `{ message }` | New message in a conversation |
| `message:edited` | `{ messageId, body, editedAt }` | Message was edited |
| `message:deleted` | `{ messageId }` | Message was soft-deleted |
| `message:reaction` | `{ messageId, reactions, actorId }` | Reaction added/removed |
| `message:read` | `{ conversationId, readBy, messageIds, readAt }` | Your messages were read *(new)* |
| `media:view_update` | `{ messageId, viewCount, hasExpired }` | View count changed |
| `media:ready` | `{ mediaId, sizeBytes }` | FFmpeg compression complete *(new)* |
| `media:failed` | `{ mediaId }` | FFmpeg compression failed — sender must retry *(new)* |
| `notification:new` | `{ notification }` | New notification (capture alert) |
| `presence:update` | `{ userId, isOnline, lastSeenAt }` | Partner came online/offline *(new)* |
| `typing:start` | `{ conversationId, userId }` | User started typing |
| `typing:stop` | `{ conversationId, userId }` | User stopped typing |

### Client → Server (unchanged from v1.0)

| Event | Payload | Description |
|---|---|---|
| `conversation:join` | `{ conversationId }` | Join a conversation room |
| `conversation:leave` | `{ conversationId }` | Leave a conversation room |
| `typing:start` | `{ conversationId }` | Broadcast typing indicator |
| `typing:stop` | `{ conversationId }` | Stop typing indicator |

---

## Updated Environment Variables

Add to `.env`:

```env
# ─── Compression ───────────────────────────────────────────────
COMPRESSION_CONCURRENCY=3       # parallel FFmpeg jobs the worker runs simultaneously
COMPRESSION_MAX_INPUT_MB=500    # files above this size cannot use quality=compressed
FFMPEG_PATH=                    # leave blank — auto-detected via @ffmpeg-installer
```

---

## Roadmap — Removals

Remove from the roadmap in `API_DOCUMENTATION.md`:

- ~~Read receipts~~
- ~~Media compression pipeline (FFmpeg on upload)~~

Remaining:

- [ ] End-to-end encryption (Signal Protocol)
- [ ] Native iOS/Android apps with Widevine DRM
- [ ] Group conversations (3+ participants)
- [ ] Story-style media (24-hour expiry)
- [ ] Disappearing messages (timer-based deletion)
- [ ] CDN edge caching for watermarked thumbnails
- [ ] PayloadCMS integration for admin dashboard

---

*Addendum maintained alongside `API_DOCUMENTATION.md`. Merge into main doc on next major version bump.*
