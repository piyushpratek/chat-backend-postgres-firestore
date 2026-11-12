import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/postgres';
import { api, createDirectChat, createUsers, MISSING_UUID, resetDatabases, send } from './helpers';

beforeEach(resetDatabases);
afterAll(() => pool.end());

describe('POST /chat/create (create or get 1:1 chat)', () => {
  it('creates a chat the first time and returns the same chat afterwards', async () => {
    const [a, b] = await createUsers('A', 'B');
    const first = await api().post('/chat/create').send({ userAId: a, userBId: b }).expect(201);
    expect(first.body).toEqual({ chatId: expect.any(String), created: true });

    const again = await api().post('/chat/create').send({ userAId: a, userBId: b }).expect(200);
    expect(again.body).toEqual({ chatId: first.body.chatId, created: false });

    // Order of the two users does not matter
    const swapped = await api().post('/chat/create').send({ userAId: b, userBId: a }).expect(200);
    expect(swapped.body.chatId).toBe(first.body.chatId);
  });

  it('never creates duplicate chats under concurrent requests', async () => {
    const [a, b] = await createUsers('A', 'B');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        api().post('/chat/create').send(i % 2 ? { userAId: a, userBId: b } : { userAId: b, userBId: a }),
      ),
    );
    const ids = new Set(results.map((r) => r.body.chatId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM chats');
    expect(rows[0].n).toBe(1);
  });

  it('rejects a chat with yourself', async () => {
    const [a] = await createUsers('A');
    const res = await api().post('/chat/create').send({ userAId: a, userBId: a }).expect(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 404 when a user does not exist', async () => {
    const [a] = await createUsers('A');
    const res = await api().post('/chat/create').send({ userAId: a, userBId: MISSING_UUID }).expect(404);
    expect(res.body.error.message).toContain(MISSING_UUID);
  });

  it('returns field-level validation errors', async () => {
    const res = await api().post('/chat/create').send({ userAId: 'not-a-uuid' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d: { field: string }) => d.field).sort()).toEqual(['userAId', 'userBId']);
  });

  it('returns 400 for a malformed JSON body', async () => {
    await api().post('/chat/create').set('Content-Type', 'application/json').send('{"userAId":').expect(400);
  });
});

describe('GET /user/:userId/chats', () => {
  it('lists every chat of the user with member ids, most recently active first', async () => {
    const [a, b, c, d] = await createUsers('A', 'B', 'C', 'D');
    const ab = await createDirectChat(a!, b!);
    const ac = await createDirectChat(a!, c!);
    await createDirectChat(b!, d!); // not A's chat

    await send(ab, b!, 'newest activity is here');
    // touchChat runs after the response, give it a moment
    await new Promise((r) => setTimeout(r, 100));

    const res = await api().get(`/user/${a}/chats`).expect(200);
    expect(res.body.userId).toBe(a);
    expect(res.body.chats).toHaveLength(2);
    expect(res.body.chats[0].chatId).toBe(ab);
    expect(res.body.chats[1].chatId).toBe(ac);
    expect([...res.body.chats[0].memberIds].sort()).toEqual([a, b].sort());
    expect(res.body.chats[0]).toMatchObject({ type: 'direct', name: null });
  });

  it('returns an empty list for a user with no chats and 404 for an unknown user', async () => {
    const [a] = await createUsers('A');
    const res = await api().get(`/user/${a}/chats`).expect(200);
    expect(res.body.chats).toEqual([]);
    await api().get(`/user/${MISSING_UUID}/chats`).expect(404);
  });
});
