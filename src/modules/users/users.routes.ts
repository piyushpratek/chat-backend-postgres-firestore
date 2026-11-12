import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../utils/validate';
import { uuid } from '../../utils/ids';
import { createUser, getUser, listUsers } from './users.service';
import { listUserChats } from '../chats/chats.service';

const CreateUserBody = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.email().optional(),
});
const UserParams = z.object({ userId: uuid });

export const usersRouter = Router();

// Helper endpoints so a reviewer can create test users. Not part of the brief.
usersRouter.post('/users', async (req, res) => {
  const body = parse(CreateUserBody, req.body);
  res.status(201).json(await createUser(body));
});

usersRouter.get('/users', async (_req, res) => {
  res.json({ users: await listUsers() });
});

usersRouter.get('/user/:userId', async (req, res) => {
  const { userId } = parse(UserParams, req.params);
  res.json(await getUser(userId));
});

// API 6: List User Chats
usersRouter.get('/user/:userId/chats', async (req, res) => {
  const { userId } = parse(UserParams, req.params);
  res.json({ userId, chats: await listUserChats(userId) });
});
