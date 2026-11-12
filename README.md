# Chat Backend: PostgreSQL + Firebase Firestore

A chat backend built with Node.js and TypeScript (strict mode). It supports 1:1 chats, sending messages, ordering, read receipts and last-seen tracking. Group chats and message edit/delete, the two bonus items, are also included.

- **PostgreSQL** stores **users, chats and chat members**. These are relational data that need constraints and joins.
- **Firebase Firestore** stores **messages, read receipts and last-seen pointers**. This is high-volume, append-heavy data that a real-time client would subscribe to.

The two stores share one id: a chat's PostgreSQL UUID is also its Firestore document id.

## Quick start

```bash
npm install
cp .env.example .env     # add DATABASE_URL and your Firebase service-account values
npm run seed             # creates the tables and 4 demo users with fixed ids
npm run dev              # http://localhost:4000
```

Then import `docs/postman_collection.json` into Postman and run the requests from top to bottom. The collection saves `chatId` and `messageId` automatically. The demo users are:

| Name | id |
|---|---|
| Aarav | `00000000-0000-4000-8000-000000000001` |
| Bhavna | `00000000-0000-4000-8000-000000000002` |
| Chirag | `00000000-0000-4000-8000-000000000003` |
| Diya | `00000000-0000-4000-8000-000000000004` |

**No Firebase project?** Run `npm run emulator` in a second terminal, then set `FIREBASE_PROJECT_ID=demo-chat` and `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080` in `.env`. The emulator needs Java 11 or newer.

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 20+, TypeScript `strict` + `noUncheckedIndexedAccess` | The brief asks for strict typing, and indexed-access checks catch unchecked `rows[0]`-style bugs. |
| HTTP | Express 5 | Small and well known. Version 5 forwards errors from async handlers by itself, so no wrapper is needed. |
| Relational DB | PostgreSQL via `pg` with plain SQL | The SQL stays visible and reviewable. Constraints do the real work: `UNIQUE(direct_key)`, `CHECK` and foreign keys. |
| Messages | Firebase Firestore via `firebase-admin` | Subcollections per chat, transactions for ordering and receipts, and real-time listeners for future clients. |
| Validation | Zod | A single schema gives runtime validation, field-level error messages and TS types. |
| Tests | Vitest + Supertest against real PostgreSQL and the Firestore emulator | The tests exercise real constraints and real Firestore transactions, not mocks. |

## Data model

### PostgreSQL ([`src/db/schema.sql`](src/db/schema.sql))

```
users                     chats                                   chat_members
-----                     -----                                   ------------
id          UUID PK       id          UUID PK                     chat_id   UUID FK -> chats  ┐ PK
name        TEXT          type        'direct' | 'group'          user_id   UUID FK -> users  ┘
email       TEXT UNIQUE   name        TEXT (groups only)          role      'admin' | 'member'
created_at                direct_key  TEXT UNIQUE (1:1 only)      joined_at
                          created_by  UUID FK -> users
                          created_at, updated_at
```

- `direct_key` is `"<smaller user id>:<larger user id>"`. Because it is `UNIQUE`, a pair of users can only ever have **one** 1:1 chat, whatever order the ids arrive in and even when requests are concurrent.
- A `CHECK` constraint makes sure a direct chat always has a `direct_key` and a group always has a name.
- `chat_members(user_id)` is indexed for "list my chats". `chats.updated_at` is bumped on every message, so that list is sorted by latest activity.
- Tables are created on start-up (`CREATE TABLE IF NOT EXISTS`), so a fresh database works with no manual step.

### Firestore ([`src/firebase/firestore.ts`](src/firebase/firestore.ts))

```
chats/{chatId}                          lastSeq, lastMessage { messageId, senderId, text, seq, createdAt, deleted }, updatedAt
chats/{chatId}/messages/{messageId}     seq, senderId, text, createdAt, editedAt, deletedAt, deletedBy,
                                        readBy { <userId>: <timestamp> }
chats/{chatId}/lastSeen/{userId}        messageId, seq, updatedAt
```

## API reference

All request and response bodies are JSON. User and chat ids are UUIDs. Message ids are Firestore document ids.

Errors always have the same shape:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Request validation failed",
             "details": [{ "field": "userBId", "message": "must be a valid UUID" }] } }
```

| Status | When |
|---|---|
| 400 | Invalid input, or an action that makes no sense (chat with yourself, group action on a 1:1 chat) |
| 403 | The user is not a member of the chat, or lacks the right (not the sender, not a group admin) |
| 404 | The user, chat or message does not exist |
| 409 | Conflict (duplicate email, editing a deleted message) |

### 1. Create or get chat: `POST /chat/create`

```json
// request
{ "userAId": "00000000-0000-4000-8000-000000000001", "userBId": "00000000-0000-4000-8000-000000000002" }
// response: 201 when created, 200 when the chat already existed
{ "chatId": "b6b7b04d-a473-433f-9c6e-4fc7ef26cefb", "created": true }
```

### 2. Send message: `POST /chat/:chatId/message/send`

```json
// request
{ "senderId": "00000000-0000-4000-8000-000000000001", "text": "Hi Bhavna!" }
// response 201
{ "messageId": "dKPRzJh8UBs3QuUwZ6Fc", "chatId": "b6b7b04d-…", "seq": 1,
  "senderId": "00000000-0000-4000-8000-000000000001", "text": "Hi Bhavna!",
  "createdAt": "2026-11-12T14:04:31.048Z", "editedAt": null, "deleted": false, "deletedAt": null, "readBy": {} }
```

The text is trimmed and must be 1 to 4,000 characters. The sender must be a member of the chat.

### 3. Get messages: `GET /chat/:chatId/messages?limit=50`

Returns the **latest** `limit` messages in **chronological order** (oldest first), ready to render.

| Query | Default | Notes |
|---|---|---|
| `limit` | 50 | 1 to 100 |
| `before` | none | Pass the previous response's `nextCursor` to load older messages |
| `userId` | none | If given, the user must be a member (403 otherwise) |

```json
{ "chatId": "b6b7b04d-…",
  "messages": [
    { "messageId": "dKPRzJh8UBs3QuUwZ6Fc", "seq": 1, "senderId": "…0001", "text": "Hi Bhavna!",
      "createdAt": "2026-11-12T14:04:31.048Z", "readBy": { "…0002": "2026-11-12T14:04:31.267Z" }, "deleted": false, … },
    { "messageId": "2gHZ2yNBhye2W4ledjTC", "seq": 2, "senderId": "…0002", "text": "Hey Aarav", "readBy": {}, … }
  ],
  "hasMore": false, "nextCursor": null }
```

### 4. Mark message read: `POST /chat/:chatId/message/:messageId/read`

```json
// request
{ "userId": "00000000-0000-4000-8000-000000000002" }
// response 200
{ "chatId": "…", "messageId": "dKPRzJh8UBs3QuUwZ6Fc", "userId": "…0002",
  "readAt": "2026-11-12T14:04:31.267Z", "readBy": { "…0002": "2026-11-12T14:04:31.267Z" } }
```

The call is idempotent: repeat calls keep the **first** read time. Senders are not marked as readers of their own messages (`readAt: null`).

### 5. Update last seen message: `POST /chat/:chatId/lastseen`

```json
// request
{ "userId": "00000000-0000-4000-8000-000000000002", "messageId": "2gHZ2yNBhye2W4ledjTC" }
// response 200
{ "chatId": "…", "userId": "…0002", "messageId": "2gHZ2yNBhye2W4ledjTC", "seq": 2,
  "updatedAt": "2026-11-12T14:04:31.227Z", "updated": true }
```

The pointer **only moves forward**. If an older `messageId` arrives late, for example from a slow network or a second device, the newer position is kept and `updated` is `false`. Sending a message also moves the sender's own last-seen pointer to that message. `GET /chat/:chatId/lastseen` returns every member's pointer.

### 6. List user chats: `GET /user/:userId/chats`

```json
{ "userId": "…0001",
  "chats": [
    { "chatId": "b6b7b04d-…", "type": "direct", "name": null,
      "memberIds": ["…0001", "…0002"],
      "createdAt": "2026-11-12T14:04:30.004Z", "updatedAt": "2026-11-12T14:04:31.236Z" }
  ] }
```

Chats are sorted by most recent activity. The list comes from a single SQL query (two joins on `chat_members` plus `array_agg`), so there is no N+1 problem.

### Bonus: group chats

| Endpoint | Body | Who can call it |
|---|---|---|
| `POST /chat/group/create` | `{ creatorId, name, memberIds[] }` | Anyone. The creator becomes an admin |
| `GET /chat/:chatId` | `?userId=` optional | Members, with roles and join dates |
| `PATCH /chat/:chatId` | `{ userId, name }` | Group admins (rename) |
| `POST /chat/:chatId/members/add` | `{ userId, memberIds[] }` | Group admins. Already-members are skipped |
| `POST /chat/:chatId/members/remove` | `{ userId, memberId }` | Admins remove anyone. Any member can remove themselves (leave) |
| `POST /chat/:chatId/members/role` | `{ userId, memberId, role }` | Group admins |

Group messages use the same send, read and last-seen endpoints as 1:1 chats. A group is never left without an admin. If the last admin leaves, the longest-standing member is promoted, and demoting the last admin is rejected. These changes run inside a transaction with the member rows locked, so two concurrent removals cannot both skip the promotion.

### Bonus: edit and delete

| Endpoint | Body | Rules |
|---|---|---|
| `PATCH /chat/:chatId/message/:messageId` | `{ userId, text }` | Sender only. Sets `editedAt`. A deleted message cannot be edited (409) |
| `DELETE /chat/:chatId/message/:messageId` | `{ userId }` | Sender, or a group admin. Soft delete, idempotent |

A deleted message keeps its document and its `seq`, so ordering, receipts and last-seen pointers that reference it stay valid. Its text is removed and it is returned as `"deleted": true, "text": null`. The chat's `lastMessage` preview is kept in sync on edit and delete.

### Helper endpoints

`POST /users` `{ name, email? }`, `GET /users`, `GET /user/:userId` and `GET /health` exist so a reviewer can create test users and check the service. The brief does not ask for them.

## Design decisions

**Ordering uses a per-chat sequence number, not only timestamps.** Each message is written in a Firestore transaction that reads `chats/{chatId}.lastSeq`, writes the message with `seq = lastSeq + 1` and stores the new `lastSeq`. Two messages sent in the same millisecond, or from servers whose clocks differ, still get distinct, gap-free positions. `GET /messages` orders by `seq`, and `createdAt` (the Firestore server timestamp) is kept for display. A test sends 12 messages concurrently and checks that they get exactly 1 to 12. The trade-off is that every message writes the chat document, which caps one chat at roughly one sustained write per second under Firestore's guidance. That is fine for human chat. A very busy group would need a sharded counter or ordering by `(createdAt, messageId)`.

**Create-or-get is race-safe.** A fast-path `SELECT` handles the common "get" case. Creation is `INSERT … ON CONFLICT (direct_key) DO NOTHING RETURNING id` inside a transaction, so concurrent requests for the same pair resolve to one chat. A test fires 10 parallel requests and checks that exactly one chat row exists.

**Read receipts live on the message.** `readBy` is a map of `userId -> timestamp`, updated with a `FieldPath` (so UUIDs with dashes are safe keys) inside a transaction. One document read then gives the message and all its receipts, which suits 1:1 chats and normal-sized groups. For very large groups I would move receipts to a `messages/{id}/receipts/{userId}` subcollection to stay far from the 1 MiB document limit.

**Last seen is separate from read receipts.** Read receipts answer "who has read this message?". Last seen answers "how far has this user got in the chat?", which is what an unread badge needs (`lastSeq - lastSeen.seq`). The two are kept separate, as the brief lists them as separate APIs.

**Membership is checked in PostgreSQL before every Firestore operation.** The relational DB is the source of truth for who belongs to a chat, and one indexed lookup returns 404 (no chat) or 403 (not a member).

**Consistency across two databases.** Every operation writes to one database only, with one deliberate exception. After a message is stored in Firestore, `chats.updated_at` in PostgreSQL is bumped as a best-effort step. If that update fails, the message is still saved, and the only effect is a slightly stale sort order in the chat list. No step needs a distributed transaction.

**Firestore security rules deny all client access** ([`firestore.rules`](firestore.rules)). All access goes through this API with the Admin SDK, so nobody can write messages around the membership checks.

**Authentication is out of scope.** Following the brief, the acting user is passed in the body (`senderId` / `userId`). In production, that id would come from a verified token (for example a Firebase Auth ID token checked with `verifyIdToken`), and the body field would be dropped.

## Running the tests

```bash
npm test
```

`npm test` starts the Firestore emulator (Java 11+ needed), runs Vitest against it, then stops it. PostgreSQL tests use `TEST_DATABASE_URL`, a separate database that the tests truncate. The tests refuse to run without the emulator, so they can never delete data in a real Firebase project.

28 tests cover all 6 APIs and both bonus features. They include concurrent chat creation, concurrent sends, pagination, idempotent receipts, the forward-only last-seen pointer, permissions (403/404) and validation errors.

```
 ✓ tests/chats.test.ts     (8 tests)
 ✓ tests/messages.test.ts  (11 tests)
 ✓ tests/bonus.test.ts     (9 tests)
 Test Files  3 passed (3)
      Tests  28 passed (28)
```

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Start with reload on change |
| `npm run build` / `npm start` | Compile to `dist/` and run it |
| `npm run seed` | Create the tables and 4 demo users |
| `npm run migrate` | Create the tables only |
| `npm run emulator` | Run the Firestore emulator locally |
| `npm test` | Run all tests on the emulator |
| `npm run typecheck` | Type-check the source, scripts and tests |

## Project structure

```
src/
  config/env.ts            # env vars validated with zod at start-up
  db/                      # pg pool, transaction helper, schema.sql, migrate
  firebase/firestore.ts    # Admin SDK init (service account, file, or emulator) + collection paths
  modules/
    users/                 # helper user endpoints + API 6 route
    chats/                 # API 1, membership checks, group chats (PostgreSQL)
    messages/              # APIs 2–5, edit/delete (Firestore)
  middleware/errorHandler.ts
  utils/                   # AppError, zod parse helper, id schemas
scripts/seed.ts            # demo users
tests/                     # integration tests (Vitest + Supertest)
docs/postman_collection.json
```

## What I would add next

- Authentication with Firebase Auth ID tokens, replacing `userId` in the body.
- Unread counts in `GET /user/:userId/chats`, read in a single `getAll` call from the `lastSeen` docs.
- Real-time delivery: clients subscribe to `chats/{chatId}/messages` with Firestore listeners, or the server pushes over WebSockets.
- Rate limiting on message send, and an OpenAPI spec.
