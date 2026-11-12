import request from 'supertest';
import { createApp } from '../src/app';
import { migrate } from '../src/db/migrate';
import { pool } from '../src/db/postgres';

export const app = createApp();
export const api = () => request(app);

export async function resetDatabases(): Promise<void> {
  await migrate();
  await pool.query('TRUNCATE chat_members, chats, users CASCADE');
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  const project = process.env.FIREBASE_PROJECT_ID;
  const res = await fetch(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`Failed to clear Firestore emulator: ${res.status}`);
}

export async function createUsers(...names: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const name of names) {
    const res = await api().post('/users').send({ name }).expect(201);
    ids.push(res.body.id as string);
  }
  return ids;
}

export async function createDirectChat(a: string, b: string): Promise<string> {
  const res = await api().post('/chat/create').send({ userAId: a, userBId: b });
  return res.body.chatId as string;
}

export async function send(chatId: string, senderId: string, text: string) {
  return api().post(`/chat/${chatId}/message/send`).send({ senderId, text }).expect(201);
}

export const MISSING_UUID = '9f0e8d7c-6b5a-4f3e-9d2c-1b0a9f8e7d6c';
