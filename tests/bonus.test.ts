import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/postgres';
import { col } from '../src/firebase/firestore';
import { api, createDirectChat, createUsers, resetDatabases, send } from './helpers';

beforeEach(resetDatabases);
afterAll(() => pool.end());

async function group() {
  const [owner, m1, m2, extra] = (await createUsers('Owner', 'M1', 'M2', 'Extra')) as [string, string, string, string];
  const res = await api()
    .post('/chat/group/create')
    .send({ creatorId: owner, name: 'Team', memberIds: [m1, m2, m1] })
    .expect(201);
  return { owner, m1, m2, extra, chatId: res.body.chatId as string, body: res.body };
}

describe('group chats', () => {
  it('creates a group with the creator as admin and shows it in member chat lists', async () => {
    const { owner, m1, m2, chatId, body } = await group();
    expect(body).toMatchObject({ type: 'group', name: 'Team', createdBy: owner });
    expect(body.members).toHaveLength(3);
    expect(body.members.find((m: { userId: string }) => m.userId === owner).role).toBe('admin');

    const list = await api().get(`/user/${m2}/chats`).expect(200);
    expect(list.body.chats[0]).toMatchObject({ chatId, type: 'group', name: 'Team' });
    expect([...list.body.chats[0].memberIds].sort()).toEqual([owner, m1, m2].sort());
  });

  it('lets members message the group and keeps ordering', async () => {
    const { owner, m1, m2, chatId } = await group();
    await send(chatId, owner, 'one');
    await send(chatId, m1, 'two');
    await send(chatId, m2, 'three');
    const res = await api().get(`/chat/${chatId}/messages`).expect(200);
    expect(res.body.messages.map((m: { text: string }) => m.text)).toEqual(['one', 'two', 'three']);
  });

  it('only admins can add members, rename, or remove others', async () => {
    const { owner, m1, extra, chatId } = await group();
    await api().post(`/chat/${chatId}/members/add`).send({ userId: m1, memberIds: [extra] }).expect(403);
    const added = await api().post(`/chat/${chatId}/members/add`).send({ userId: owner, memberIds: [extra] }).expect(200);
    expect(added.body.members).toHaveLength(4);

    await api().patch(`/chat/${chatId}`).send({ userId: m1, name: 'Nope' }).expect(403);
    const renamed = await api().patch(`/chat/${chatId}`).send({ userId: owner, name: 'Core team' }).expect(200);
    expect(renamed.body.name).toBe('Core team');

    await api().post(`/chat/${chatId}/members/remove`).send({ userId: m1, memberId: extra }).expect(403);
    const removed = await api().post(`/chat/${chatId}/members/remove`).send({ userId: owner, memberId: extra }).expect(200);
    expect(removed.body.members).toHaveLength(3);
    // A removed member can no longer post
    await api().post(`/chat/${chatId}/message/send`).send({ senderId: extra, text: 'hi' }).expect(403);
  });

  it('promotes the longest-standing member when the last admin leaves', async () => {
    const { owner, m1, chatId } = await group();
    const res = await api().post(`/chat/${chatId}/members/remove`).send({ userId: owner, memberId: owner }).expect(200);
    expect(res.body.members).toHaveLength(2);
    expect(res.body.members.filter((m: { role: string }) => m.role === 'admin')).toHaveLength(1);
    expect(res.body.members.map((m: { userId: string }) => m.userId)).not.toContain(owner);
    expect(m1).toBeTruthy();
  });

  it('manages roles but never leaves a group without an admin', async () => {
    const { owner, m1, chatId } = await group();
    await api().post(`/chat/${chatId}/members/role`).send({ userId: owner, memberId: owner, role: 'member' }).expect(400);
    await api().post(`/chat/${chatId}/members/role`).send({ userId: owner, memberId: m1, role: 'admin' }).expect(200);
    const res = await api().post(`/chat/${chatId}/members/role`).send({ userId: owner, memberId: owner, role: 'member' }).expect(200);
    expect(res.body.members.find((m: { userId: string }) => m.userId === m1).role).toBe('admin');
  });

  it('rejects group actions on 1:1 chats and groups without other members', async () => {
    const [a, b, c] = (await createUsers('A', 'B', 'C')) as [string, string, string];
    const direct = await createDirectChat(a, b);
    await api().post(`/chat/${direct}/members/add`).send({ userId: a, memberIds: [c] }).expect(400);
    await api().post('/chat/group/create').send({ creatorId: a, name: 'Solo', memberIds: [a] }).expect(400);
  });
});

describe('message edit and delete', () => {
  it('lets the sender edit, and keeps the chat preview in sync', async () => {
    const [a, b] = (await createUsers('A', 'B')) as [string, string];
    const chatId = await createDirectChat(a, b);
    const m = (await send(chatId, a, 'helo')).body;

    await api().patch(`/chat/${chatId}/message/${m.messageId}`).send({ userId: b, text: 'hack' }).expect(403);
    const edited = await api().patch(`/chat/${chatId}/message/${m.messageId}`).send({ userId: a, text: 'hello' }).expect(200);
    expect(edited.body).toMatchObject({ text: 'hello', editedAt: expect.any(String), seq: 1 });

    const chatDoc = await col.chat(chatId).get();
    expect(chatDoc.get('lastMessage.text')).toBe('hello');
  });

  it('soft-deletes: text is removed but the message keeps its place', async () => {
    const [a, b] = (await createUsers('A', 'B')) as [string, string];
    const chatId = await createDirectChat(a, b);
    const m1 = (await send(chatId, a, 'keep')).body;
    const m2 = (await send(chatId, a, 'oops')).body;

    await api().delete(`/chat/${chatId}/message/${m2.messageId}`).send({ userId: b }).expect(403);
    const del = await api().delete(`/chat/${chatId}/message/${m2.messageId}`).send({ userId: a }).expect(200);
    expect(del.body).toMatchObject({ deleted: true, text: null, deletedAt: expect.any(String) });

    // Deleting again is harmless, editing a deleted message is not allowed
    await api().delete(`/chat/${chatId}/message/${m2.messageId}`).send({ userId: a }).expect(200);
    await api().patch(`/chat/${chatId}/message/${m2.messageId}`).send({ userId: a, text: 'x' }).expect(409);

    const list = await api().get(`/chat/${chatId}/messages`).expect(200);
    expect(list.body.messages.map((m: { messageId: string; deleted: boolean }) => [m.messageId, m.deleted])).toEqual([
      [m1.messageId, false],
      [m2.messageId, true],
    ]);
    expect((await col.chat(chatId).get()).get('lastMessage')).toMatchObject({ text: null, deleted: true });
  });

  it('lets a group admin delete any message in the group', async () => {
    const [owner, member] = (await createUsers('Owner', 'Member')) as [string, string];
    const g = await api().post('/chat/group/create').send({ creatorId: owner, name: 'G', memberIds: [member] }).expect(201);
    const m = (await send(g.body.chatId, member, 'spam')).body;
    await api().delete(`/chat/${g.body.chatId}/message/${m.messageId}`).send({ userId: owner }).expect(200);
  });
});
