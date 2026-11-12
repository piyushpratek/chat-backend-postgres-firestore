import { FieldPath, FieldValue, Timestamp, type DocumentSnapshot, type Transaction } from 'firebase-admin/firestore';
import { col, firestore } from '../../firebase/firestore';
import { AppError } from '../../utils/AppError';
import { assertChatExists, requireMember, touchChat } from '../chats/chats.service';

/** Shape of a message document in Firestore. */
interface MessageDoc {
  seq: number;
  senderId: string;
  text: string | null;
  createdAt: Timestamp;
  editedAt: Timestamp | null;
  deletedAt: Timestamp | null;
  deletedBy: string | null;
  /** userId -> when that user read the message */
  readBy: Record<string, Timestamp>;
}

interface LastSeenDoc {
  messageId: string;
  seq: number;
  updatedAt: Timestamp;
}

export interface Message {
  messageId: string;
  chatId: string;
  seq: number;
  senderId: string;
  text: string | null;
  createdAt: string | null;
  editedAt: string | null;
  deleted: boolean;
  deletedAt: string | null;
  readBy: Record<string, string>;
}

export interface LastSeen {
  chatId: string;
  userId: string;
  messageId: string;
  seq: number;
  updatedAt: string | null;
}

const iso = (t: Timestamp | null | undefined): string | null => (t ? t.toDate().toISOString() : null);

function toMessage(chatId: string, snap: DocumentSnapshot): Message {
  const d = snap.data() as MessageDoc;
  return {
    messageId: snap.id,
    chatId,
    seq: d.seq,
    senderId: d.senderId,
    text: d.deletedAt ? null : d.text,
    createdAt: iso(d.createdAt),
    editedAt: iso(d.editedAt),
    deleted: Boolean(d.deletedAt),
    deletedAt: iso(d.deletedAt),
    readBy: Object.fromEntries(Object.entries(d.readBy ?? {}).map(([u, t]) => [u, iso(t)!])),
  };
}

function toLastSeen(chatId: string, userId: string, d: LastSeenDoc): LastSeen {
  return { chatId, userId, messageId: d.messageId, seq: d.seq, updatedAt: iso(d.updatedAt) };
}

// ---------------------------------------------------------------------------
// API 2: Send Message
// ---------------------------------------------------------------------------

/**
 * Ordering: every message gets a per-chat sequence number (1, 2, 3, ...) assigned
 * inside a Firestore transaction on the chat document. Two messages sent at the same
 * millisecond still get distinct, gap-free positions, and ordering never depends on
 * clocks. createdAt is the Firestore server timestamp, kept for display.
 */
export async function sendMessage(chatId: string, senderId: string, text: string): Promise<Message> {
  await requireMember(chatId, senderId);

  const chatRef = col.chat(chatId);
  const msgRef = col.messages(chatId).doc();

  await firestore.runTransaction(async (tx) => {
    const chatSnap = await tx.get(chatRef);
    const seq = ((chatSnap.get('lastSeq') as number | undefined) ?? 0) + 1;
    const now = FieldValue.serverTimestamp();

    tx.create(msgRef, {
      seq,
      senderId,
      text,
      createdAt: now,
      editedAt: null,
      deletedAt: null,
      deletedBy: null,
      readBy: {},
    });
    tx.set(
      chatRef,
      {
        lastSeq: seq,
        lastMessage: { messageId: msgRef.id, senderId, text, seq, createdAt: now, deleted: false },
        updatedAt: now,
      },
      { merge: true },
    );
    // Whoever sends a message has obviously seen the chat up to that message.
    tx.set(col.lastSeen(chatId).doc(senderId), { messageId: msgRef.id, seq, updatedAt: now });
  });

  // Keep "list my chats" sorted by activity. A failure here must not fail the send,
  // because the message is already safely stored.
  touchChat(chatId).catch((err: unknown) => console.error('[chat] failed to bump updated_at', err));

  return toMessage(chatId, await msgRef.get());
}

// ---------------------------------------------------------------------------
// API 3: Get Messages
// ---------------------------------------------------------------------------

/**
 * Returns the latest `limit` messages in chronological order (oldest first), which is
 * what a chat screen renders. Pass `before=<seq>` (the returned nextCursor) to page back
 * through older history.
 */
export async function getMessages(
  chatId: string,
  opts: { limit: number; before?: number | undefined; userId?: string | undefined },
): Promise<{ chatId: string; messages: Message[]; hasMore: boolean; nextCursor: number | null }> {
  if (opts.userId) await requireMember(chatId, opts.userId);
  else await assertChatExists(chatId);

  let q = col.messages(chatId).orderBy('seq', 'desc');
  if (opts.before !== undefined) q = q.where('seq', '<', opts.before);
  // Fetch one extra to know whether older messages exist.
  const snap = await q.limit(opts.limit + 1).get();

  const hasMore = snap.docs.length > opts.limit;
  const messages = snap.docs
    .slice(0, opts.limit)
    .map((d) => toMessage(chatId, d))
    .reverse();

  return { chatId, messages, hasMore, nextCursor: hasMore ? (messages[0]?.seq ?? null) : null };
}

// ---------------------------------------------------------------------------
// API 4: Mark Message Read
// ---------------------------------------------------------------------------

/**
 * Records readBy.<userId> = server timestamp on the message. Idempotent: reading a
 * message twice keeps the first read time. A sender's own message is not marked.
 */
export async function markMessageRead(
  chatId: string,
  messageId: string,
  userId: string,
): Promise<{ chatId: string; messageId: string; userId: string; readAt: string | null; readBy: Record<string, string> }> {
  await requireMember(chatId, userId);
  const ref = col.message(chatId, messageId);

  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw AppError.notFound(`Message ${messageId} not found in chat ${chatId}`);
    const d = snap.data() as MessageDoc;
    if (d.senderId === userId || d.readBy?.[userId]) return;
    tx.update(ref, new FieldPath('readBy', userId), FieldValue.serverTimestamp());
  });

  const message = toMessage(chatId, await ref.get());
  return { chatId, messageId, userId, readAt: message.readBy[userId] ?? null, readBy: message.readBy };
}

// ---------------------------------------------------------------------------
// API 5: Update Last Seen Message
// ---------------------------------------------------------------------------

/**
 * Stores, per user per chat, the latest message they have seen. The pointer only moves
 * forward: if a client sends an older messageId (e.g. requests arrive out of order),
 * the newer position is kept and `updated` is false.
 */
export async function updateLastSeen(
  chatId: string,
  userId: string,
  messageId: string,
): Promise<LastSeen & { updated: boolean }> {
  await requireMember(chatId, userId);
  const msgRef = col.message(chatId, messageId);
  const seenRef = col.lastSeen(chatId).doc(userId);

  const updated = await firestore.runTransaction(async (tx) => {
    const [msgSnap, seenSnap] = await Promise.all([tx.get(msgRef), tx.get(seenRef)]);
    if (!msgSnap.exists) throw AppError.notFound(`Message ${messageId} not found in chat ${chatId}`);
    const seq = (msgSnap.data() as MessageDoc).seq;
    const current = seenSnap.data() as LastSeenDoc | undefined;
    if (current && current.seq >= seq) return false;
    tx.set(seenRef, { messageId, seq, updatedAt: FieldValue.serverTimestamp() });
    return true;
  });

  const after = (await seenRef.get()).data() as LastSeenDoc;
  return { ...toLastSeen(chatId, userId, after), updated };
}

export async function getLastSeen(chatId: string, userId?: string): Promise<LastSeen[]> {
  if (userId) await requireMember(chatId, userId);
  else await assertChatExists(chatId);
  const snap = await col.lastSeen(chatId).get();
  return snap.docs.map((d) => toLastSeen(chatId, d.id, d.data() as LastSeenDoc));
}

// ---------------------------------------------------------------------------
// Bonus: edit / delete
// ---------------------------------------------------------------------------

/** Keeps the chat's lastMessage preview in sync when the latest message changes. */
function syncLastMessage(
  tx: Transaction,
  chatSnap: DocumentSnapshot,
  messageId: string,
  patch: Record<string, unknown>,
): void {
  if (chatSnap.get('lastMessage.messageId') !== messageId) return;
  const update: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) update[`lastMessage.${k}`] = v;
  tx.update(chatSnap.ref, update);
}

export async function editMessage(chatId: string, messageId: string, userId: string, text: string): Promise<Message> {
  await requireMember(chatId, userId);
  const ref = col.message(chatId, messageId);

  await firestore.runTransaction(async (tx) => {
    const [snap, chatSnap] = await Promise.all([tx.get(ref), tx.get(col.chat(chatId))]);
    if (!snap.exists) throw AppError.notFound(`Message ${messageId} not found in chat ${chatId}`);
    const d = snap.data() as MessageDoc;
    if (d.senderId !== userId) throw AppError.forbidden('Only the sender can edit a message');
    if (d.deletedAt) throw AppError.conflict('A deleted message cannot be edited');
    tx.update(ref, { text, editedAt: FieldValue.serverTimestamp() });
    syncLastMessage(tx, chatSnap, messageId, { text });
  });

  return toMessage(chatId, await ref.get());
}

/**
 * Soft delete: the document stays (so ordering, receipts and last-seen pointers stay
 * valid) but the text is wiped and the message shows as deleted. The sender can delete
 * their own message; group admins can delete any message in their group.
 */
export async function deleteMessage(chatId: string, messageId: string, userId: string): Promise<Message> {
  const { type, role } = await requireMember(chatId, userId);
  const ref = col.message(chatId, messageId);

  await firestore.runTransaction(async (tx) => {
    const [snap, chatSnap] = await Promise.all([tx.get(ref), tx.get(col.chat(chatId))]);
    if (!snap.exists) throw AppError.notFound(`Message ${messageId} not found in chat ${chatId}`);
    const d = snap.data() as MessageDoc;
    if (d.deletedAt) return; // already deleted: idempotent
    const isGroupAdmin = type === 'group' && role === 'admin';
    if (d.senderId !== userId && !isGroupAdmin) {
      throw AppError.forbidden('Only the sender or a group admin can delete a message');
    }
    tx.update(ref, { text: null, deletedAt: FieldValue.serverTimestamp(), deletedBy: userId });
    syncLastMessage(tx, chatSnap, messageId, { text: null, deleted: true });
  });

  return toMessage(chatId, await ref.get());
}
