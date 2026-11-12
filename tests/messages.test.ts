import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/postgres';
import { api, createDirectChat, createUsers, MISSING_UUID, resetDatabases, send } from './helpers';

beforeEach(resetDatabases);
afterAll(() => pool.end());

async function setup() {
  const [a, b, outsider] = (await createUsers('A', 'B', 'Outsider')) as [string, string, string];
  const chatId = await createDirectChat(a, b);
  return { a, b, outsider, chatId };
}

describe('POST /chat/:chatId/message/send', () => {
  it('stores the message in Firestore with a server timestamp and sequence number', async () => {
    const { a, chatId } = await setup();
    const res = await send(chatId, a, '  hello  ');
    expect(res.body).toMatchObject({
      messageId: expect.any(String),
      chatId,
      seq: 1,
      senderId: a,
      text: 'hello',
      deleted: false,
      editedAt: null,
      readBy: {},
    });
    expect(new Date(res.body.createdAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('gives concurrent messages unique, gap-free sequence numbers', async () => {
    const { a, b, chatId } = await setup();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        api().post(`/chat/${chatId}/message/send`).send({ senderId: i % 2 ? a : b, text: `m${i}` }),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const seqs = results.map((r) => r.body.seq as number).sort((x, y) => x - y);
    expect(seqs).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it('rejects non-members, unknown chats and empty text', async () => {
    const { outsider, a, chatId } = await setup();
    await api().post(`/chat/${chatId}/message/send`).send({ senderId: outsider, text: 'hi' }).expect(403);
    await api().post(`/chat/${MISSING_UUID}/message/send`).send({ senderId: a, text: 'hi' }).expect(404);
    await api().post(`/chat/${chatId}/message/send`).send({ senderId: a, text: '   ' }).expect(400);
    await api().post(`/chat/${chatId}/message/send`).send({ senderId: a, text: 'x'.repeat(4001) }).expect(400);
  });
});

describe('GET /chat/:chatId/messages', () => {
  it('returns the latest messages oldest-first, honours limit and pages back with before', async () => {
    const { a, b, chatId } = await setup();
    for (let i = 1; i <= 7; i++) await send(chatId, i % 2 ? a : b, `msg ${i}`);

    const page1 = await api().get(`/chat/${chatId}/messages?limit=3`).expect(200);
    expect(page1.body.messages.map((m: { text: string }) => m.text)).toEqual(['msg 5', 'msg 6', 'msg 7']);
    expect(page1.body).toMatchObject({ hasMore: true, nextCursor: 5 });

    const page2 = await api().get(`/chat/${chatId}/messages?limit=3&before=${page1.body.nextCursor}`).expect(200);
    expect(page2.body.messages.map((m: { text: string }) => m.text)).toEqual(['msg 2', 'msg 3', 'msg 4']);

    const page3 = await api().get(`/chat/${chatId}/messages?limit=3&before=${page2.body.nextCursor}`).expect(200);
    expect(page3.body.messages.map((m: { text: string }) => m.text)).toEqual(['msg 1']);
    expect(page3.body).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it('defaults to 50, validates limit, and checks membership when userId is given', async () => {
    const { a, outsider, chatId } = await setup();
    await send(chatId, a, 'only one');
    const res = await api().get(`/chat/${chatId}/messages`).expect(200);
    expect(res.body.messages).toHaveLength(1);
    await api().get(`/chat/${chatId}/messages?limit=0`).expect(400);
    await api().get(`/chat/${chatId}/messages?limit=abc`).expect(400);
    await api().get(`/chat/${chatId}/messages?limit=1000`).expect(400);
    await api().get(`/chat/${chatId}/messages?userId=${outsider}`).expect(403);
    await api().get(`/chat/${MISSING_UUID}/messages`).expect(404);
  });
});

describe('POST /chat/:chatId/message/:messageId/read', () => {
  it('records a read receipt and keeps the first read time on repeat calls', async () => {
    const { a, b, chatId } = await setup();
    const msg = (await send(chatId, a, 'read me')).body;

    const first = await api().post(`/chat/${chatId}/message/${msg.messageId}/read`).send({ userId: b }).expect(200);
    expect(first.body).toMatchObject({ messageId: msg.messageId, userId: b, readAt: expect.any(String) });

    const second = await api().post(`/chat/${chatId}/message/${msg.messageId}/read`).send({ userId: b }).expect(200);
    expect(second.body.readAt).toBe(first.body.readAt);

    const list = await api().get(`/chat/${chatId}/messages`).expect(200);
    expect(list.body.messages[0].readBy).toEqual({ [b]: first.body.readAt });
  });

  it('does not mark a sender as having read their own message', async () => {
    const { a, chatId } = await setup();
    const msg = (await send(chatId, a, 'mine')).body;
    const res = await api().post(`/chat/${chatId}/message/${msg.messageId}/read`).send({ userId: a }).expect(200);
    expect(res.body).toMatchObject({ readAt: null, readBy: {} });
  });

  it('returns 404 for an unknown message and 403 for non-members', async () => {
    const { a, b, outsider, chatId } = await setup();
    const msg = (await send(chatId, a, 'x')).body;
    await api().post(`/chat/${chatId}/message/doesNotExist123/read`).send({ userId: b }).expect(404);
    await api().post(`/chat/${chatId}/message/${msg.messageId}/read`).send({ userId: outsider }).expect(403);
  });
});

describe('POST /chat/:chatId/lastseen', () => {
  it('stores the last seen message per user and never moves backwards', async () => {
    const { a, b, chatId } = await setup();
    const m1 = (await send(chatId, a, 'one')).body;
    const m2 = (await send(chatId, a, 'two')).body;

    const up = await api().post(`/chat/${chatId}/lastseen`).send({ userId: b, messageId: m2.messageId }).expect(200);
    expect(up.body).toMatchObject({ userId: b, messageId: m2.messageId, seq: 2, updated: true });

    // An older message arriving late does not overwrite the newer position
    const late = await api().post(`/chat/${chatId}/lastseen`).send({ userId: b, messageId: m1.messageId }).expect(200);
    expect(late.body).toMatchObject({ messageId: m2.messageId, seq: 2, updated: false });
  });

  it('moves the sender’s own last seen forward when they send a message', async () => {
    const { a, b, chatId } = await setup();
    const m = (await send(chatId, a, 'hi')).body;
    const res = await api().get(`/chat/${chatId}/lastseen`).expect(200);
    expect(res.body.lastSeen).toEqual([expect.objectContaining({ userId: a, messageId: m.messageId, seq: 1 })]);
    expect(res.body.lastSeen.find((s: { userId: string }) => s.userId === b)).toBeUndefined();
  });

  it('validates the message and the membership', async () => {
    const { a, b, outsider, chatId } = await setup();
    const m = (await send(chatId, a, 'hi')).body;
    await api().post(`/chat/${chatId}/lastseen`).send({ userId: b, messageId: 'nope' }).expect(404);
    await api().post(`/chat/${chatId}/lastseen`).send({ userId: outsider, messageId: m.messageId }).expect(403);
    await api().post(`/chat/${chatId}/lastseen`).send({ userId: b }).expect(400);
  });
});
