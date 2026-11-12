import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { parse } from '../../utils/validate';
import { messageId, uuid } from '../../utils/ids';
import {
  deleteMessage,
  editMessage,
  getLastSeen,
  getMessages,
  markMessageRead,
  sendMessage,
  updateLastSeen,
} from './messages.service';

const MessageText = z
  .string()
  .trim()
  .min(1, 'text cannot be empty')
  .max(4000, 'text can be at most 4000 characters');

const ChatParams = z.object({ chatId: uuid });
const MessageParams = z.object({ chatId: uuid, messageId });
const SendBody = z.object({ senderId: uuid, text: MessageText });
const UserBody = z.object({ userId: uuid });
const LastSeenBody = z.object({ userId: uuid, messageId });
const EditBody = z.object({ userId: uuid, text: MessageText });
const MessagesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(env.MESSAGES_MAX_LIMIT).default(env.MESSAGES_DEFAULT_LIMIT),
  before: z.coerce.number().int().positive().optional(),
  userId: uuid.optional(),
});
const OptionalUserQuery = z.object({ userId: uuid.optional() });

export const messagesRouter = Router();

// API 2: Send Message
messagesRouter.post('/chat/:chatId/message/send', async (req, res) => {
  const { chatId } = parse(ChatParams, req.params);
  const { senderId, text } = parse(SendBody, req.body);
  res.status(201).json(await sendMessage(chatId, senderId, text));
});

// API 3: Get Messages (?limit=50, optional ?before=<seq> for older pages)
messagesRouter.get('/chat/:chatId/messages', async (req, res) => {
  const { chatId } = parse(ChatParams, req.params);
  const opts = parse(MessagesQuery, req.query);
  res.json(await getMessages(chatId, opts));
});

// API 4: Mark Message Read
messagesRouter.post('/chat/:chatId/message/:messageId/read', async (req, res) => {
  const { chatId, messageId: id } = parse(MessageParams, req.params);
  const { userId } = parse(UserBody, req.body);
  res.json(await markMessageRead(chatId, id, userId));
});

// API 5: Update Last Seen Message
messagesRouter.post('/chat/:chatId/lastseen', async (req, res) => {
  const { chatId } = parse(ChatParams, req.params);
  const { userId, messageId: id } = parse(LastSeenBody, req.body);
  res.json(await updateLastSeen(chatId, userId, id));
});

// Helper: read every member's last seen pointer for a chat
messagesRouter.get('/chat/:chatId/lastseen', async (req, res) => {
  const { chatId } = parse(ChatParams, req.params);
  const { userId } = parse(OptionalUserQuery, req.query);
  res.json({ chatId, lastSeen: await getLastSeen(chatId, userId) });
});

// ---- Bonus: edit / delete ----

messagesRouter.patch('/chat/:chatId/message/:messageId', async (req, res) => {
  const { chatId, messageId: id } = parse(MessageParams, req.params);
  const { userId, text } = parse(EditBody, req.body);
  res.json(await editMessage(chatId, id, userId, text));
});

messagesRouter.delete('/chat/:chatId/message/:messageId', async (req, res) => {
  const { chatId, messageId: id } = parse(MessageParams, req.params);
  const { userId } = parse(UserBody, req.body ?? {});
  res.json(await deleteMessage(chatId, id, userId));
});
