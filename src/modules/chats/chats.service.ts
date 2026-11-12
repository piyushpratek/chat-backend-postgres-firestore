import { pool, query, withTransaction, type Queryable } from '../../db/postgres';
import { AppError } from '../../utils/AppError';
import { assertUsersExist } from '../users/users.service';

export type ChatType = 'direct' | 'group';
export type MemberRole = 'admin' | 'member';

export interface ChatSummary {
  chatId: string;
  type: ChatType;
  name: string | null;
  memberIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ChatMember {
  userId: string;
  role: MemberRole;
  joinedAt: string;
}

export interface ChatDetails extends Omit<ChatSummary, 'memberIds'> {
  createdBy: string | null;
  members: ChatMember[];
}

interface ChatRow {
  id: string;
  type: ChatType;
  name: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Same pair of users always gives the same key, whichever order they are passed in. */
export const directKey = (a: string, b: string): string => [a, b].sort().join(':');

// ---------------------------------------------------------------------------
// 1:1 chats
// ---------------------------------------------------------------------------

/**
 * API 1. Returns the existing 1:1 chat for the pair, or creates it.
 * Race-safe: the UNIQUE(direct_key) constraint plus ON CONFLICT DO NOTHING means two
 * simultaneous requests for the same pair both end up with the same chat id.
 */
export async function createOrGetDirectChat(
  userAId: string,
  userBId: string,
): Promise<{ chatId: string; created: boolean }> {
  if (userAId === userBId) throw AppError.badRequest('userAId and userBId must be different users');
  const key = directKey(userAId, userBId);

  // Fast path: most calls are "get", so avoid opening a transaction.
  const existing = await query<{ id: string }>('SELECT id FROM chats WHERE direct_key = $1', [key]);
  if (existing[0]) return { chatId: existing[0].id, created: false };

  await assertUsersExist([userAId, userBId]);

  return withTransaction(async (tx) => {
    const inserted = await query<{ id: string }>(
      `INSERT INTO chats (type, direct_key, created_by) VALUES ('direct', $1, $2)
       ON CONFLICT (direct_key) DO NOTHING RETURNING id`,
      [key, userAId],
      tx,
    );
    if (inserted[0]) {
      await query(
        `INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
        [inserted[0].id, userAId, userBId],
        tx,
      );
      return { chatId: inserted[0].id, created: true };
    }
    // Another request created it between our SELECT and INSERT.
    const rows = await query<{ id: string }>('SELECT id FROM chats WHERE direct_key = $1', [key], tx);
    return { chatId: rows[0]!.id, created: false };
  });
}

// ---------------------------------------------------------------------------
// Reading chats
// ---------------------------------------------------------------------------

/** API 6. Every chat the user belongs to, with all member ids, most recently active first. */
export async function listUserChats(userId: string): Promise<ChatSummary[]> {
  await assertUsersExist([userId]);
  const rows = await query<ChatRow & { member_ids: string[] }>(
    `SELECT c.id, c.type, c.name, c.created_by, c.created_at, c.updated_at,
            array_agg(m.user_id ORDER BY m.joined_at, m.user_id) AS member_ids
       FROM chats c
       JOIN chat_members me ON me.chat_id = c.id AND me.user_id = $1
       JOIN chat_members m  ON m.chat_id = c.id
      GROUP BY c.id
      ORDER BY c.updated_at DESC, c.id`,
    [userId],
  );
  return rows.map((r) => ({
    chatId: r.id,
    type: r.type,
    name: r.name,
    memberIds: r.member_ids,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  }));
}

export async function getChat(chatId: string, db: Queryable = pool): Promise<ChatDetails> {
  const chats = await query<ChatRow>(
    'SELECT id, type, name, created_by, created_at, updated_at FROM chats WHERE id = $1',
    [chatId],
    db,
  );
  const chat = chats[0];
  if (!chat) throw AppError.notFound(`Chat ${chatId} not found`);
  const members = await query<{ user_id: string; role: MemberRole; joined_at: Date }>(
    'SELECT user_id, role, joined_at FROM chat_members WHERE chat_id = $1 ORDER BY joined_at, user_id',
    [chatId],
    db,
  );
  return {
    chatId: chat.id,
    type: chat.type,
    name: chat.name,
    createdBy: chat.created_by,
    createdAt: chat.created_at.toISOString(),
    updatedAt: chat.updated_at.toISOString(),
    members: members.map((m) => ({ userId: m.user_id, role: m.role, joinedAt: m.joined_at.toISOString() })),
  };
}

export async function assertChatExists(chatId: string): Promise<void> {
  const rows = await query('SELECT 1 FROM chats WHERE id = $1', [chatId]);
  if (rows.length === 0) throw AppError.notFound(`Chat ${chatId} not found`);
}

/**
 * The permission check used by every message endpoint: the chat must exist (404)
 * and the user must be a member of it (403). Returns the chat type and the user's role.
 */
export async function requireMember(
  chatId: string,
  userId: string,
  db: Queryable = pool,
): Promise<{ type: ChatType; role: MemberRole }> {
  const rows = await query<{ type: ChatType; role: MemberRole | null }>(
    `SELECT c.type, m.role
       FROM chats c
       LEFT JOIN chat_members m ON m.chat_id = c.id AND m.user_id = $2
      WHERE c.id = $1`,
    [chatId, userId],
    db,
  );
  const row = rows[0];
  if (!row) throw AppError.notFound(`Chat ${chatId} not found`);
  if (!row.role) throw AppError.forbidden(`User ${userId} is not a member of chat ${chatId}`);
  return { type: row.type, role: row.role };
}

/** Called after a message is sent so chat lists sort by latest activity. */
export async function touchChat(chatId: string): Promise<void> {
  await query('UPDATE chats SET updated_at = now() WHERE id = $1', [chatId]);
}

// ---------------------------------------------------------------------------
// Group chats (bonus)
// ---------------------------------------------------------------------------

export async function createGroupChat(input: {
  creatorId: string;
  name: string;
  memberIds: string[];
}): Promise<ChatDetails> {
  const others = [...new Set(input.memberIds)].filter((id) => id !== input.creatorId);
  if (others.length === 0) throw AppError.badRequest('A group needs at least one member besides the creator');
  await assertUsersExist([input.creatorId, ...others]);

  return withTransaction(async (tx) => {
    const rows = await query<{ id: string }>(
      `INSERT INTO chats (type, name, created_by) VALUES ('group', $1, $2) RETURNING id`,
      [input.name.trim(), input.creatorId],
      tx,
    );
    const chatId = rows[0]!.id;
    await query(`INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'admin')`, [chatId, input.creatorId], tx);
    await query(
      `INSERT INTO chat_members (chat_id, user_id, role)
       SELECT $1, unnest($2::uuid[]), 'member'`,
      [chatId, others],
      tx,
    );
    return getChat(chatId, tx);
  });
}

async function requireGroupAdmin(chatId: string, actorId: string, db: Queryable): Promise<void> {
  const { type, role } = await requireMember(chatId, actorId, db);
  if (type !== 'group') throw AppError.badRequest('This action is only available for group chats');
  if (role !== 'admin') throw AppError.forbidden('Only group admins can do this');
}

export async function addGroupMembers(chatId: string, actorId: string, memberIds: string[]): Promise<ChatDetails> {
  return withTransaction(async (tx) => {
    await requireGroupAdmin(chatId, actorId, tx);
    await assertUsersExist(memberIds, tx);
    await query(
      `INSERT INTO chat_members (chat_id, user_id, role)
       SELECT $1, unnest($2::uuid[]), 'member'
       ON CONFLICT (chat_id, user_id) DO NOTHING`,
      [chatId, [...new Set(memberIds)]],
      tx,
    );
    return getChat(chatId, tx);
  });
}

/**
 * Admins can remove anyone; any member can remove themselves (leave the group).
 * If the last admin leaves, the longest-standing member is promoted so the group
 * is never left without an admin.
 */
export async function removeGroupMember(chatId: string, actorId: string, memberId: string): Promise<ChatDetails> {
  return withTransaction(async (tx) => {
    const actor = await requireMember(chatId, actorId, tx);
    if (actor.type !== 'group') throw AppError.badRequest('This action is only available for group chats');
    if (actorId !== memberId && actor.role !== 'admin') {
      throw AppError.forbidden('Only group admins can remove other members');
    }
    // Lock the group's member rows so two concurrent removals can't both skip the promotion.
    await query('SELECT user_id FROM chat_members WHERE chat_id = $1 FOR UPDATE', [chatId], tx);

    const removed = await query('DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2 RETURNING user_id', [chatId, memberId], tx);
    if (removed.length === 0) throw AppError.notFound(`User ${memberId} is not a member of chat ${chatId}`);

    await query(
      `UPDATE chat_members SET role = 'admin'
        WHERE chat_id = $1
          AND NOT EXISTS (SELECT 1 FROM chat_members WHERE chat_id = $1 AND role = 'admin')
          AND user_id = (SELECT user_id FROM chat_members WHERE chat_id = $1 ORDER BY joined_at, user_id LIMIT 1)`,
      [chatId],
      tx,
    );
    return getChat(chatId, tx);
  });
}

export async function updateGroupRole(
  chatId: string,
  actorId: string,
  memberId: string,
  role: MemberRole,
): Promise<ChatDetails> {
  return withTransaction(async (tx) => {
    await requireGroupAdmin(chatId, actorId, tx);
    await query('SELECT user_id FROM chat_members WHERE chat_id = $1 FOR UPDATE', [chatId], tx);
    if (role === 'member') {
      const admins = await query<{ n: string }>(
        `SELECT count(*) AS n FROM chat_members WHERE chat_id = $1 AND role = 'admin' AND user_id <> $2`,
        [chatId, memberId],
        tx,
      );
      if (Number(admins[0]!.n) === 0) throw AppError.badRequest('A group must keep at least one admin');
    }
    const updated = await query('UPDATE chat_members SET role = $3 WHERE chat_id = $1 AND user_id = $2 RETURNING user_id', [chatId, memberId, role], tx);
    if (updated.length === 0) throw AppError.notFound(`User ${memberId} is not a member of chat ${chatId}`);
    return getChat(chatId, tx);
  });
}

export async function renameGroup(chatId: string, actorId: string, name: string): Promise<ChatDetails> {
  return withTransaction(async (tx) => {
    await requireGroupAdmin(chatId, actorId, tx);
    await query('UPDATE chats SET name = $2 WHERE id = $1', [chatId, name.trim()], tx);
    return getChat(chatId, tx);
  });
}
