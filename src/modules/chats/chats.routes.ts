import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../utils/validate';
import { uuid } from '../../utils/ids';
import {
  addGroupMembers,
  createGroupChat,
  createOrGetDirectChat,
  getChat,
  removeGroupMember,
  renameGroup,
  requireMember,
  updateGroupRole,
} from './chats.service';

const CreateChatBody = z.object({ userAId: uuid, userBId: uuid });
const ChatParams = z.object({ chatId: uuid });
const GroupName = z.string().trim().min(1).max(100);
const CreateGroupBody = z.object({
  creatorId: uuid,
  name: GroupName,
  memberIds: z.array(uuid).min(1).max(255),
});
const AddMembersBody = z.object({ userId: uuid, memberIds: z.array(uuid).min(1).max(255) });
const RemoveMemberBody = z.object({ userId: uuid, memberId: uuid });
const RoleBody = z.object({ userId: uuid, memberId: uuid, role: z.enum(['admin', 'member']) });
const RenameBody = z.object({ userId: uuid, name: GroupName });
const OptionalUserQuery = z.object({ userId: uuid.optional() });

export const chatsRouter = Router();

// API 1: Create or Get Chat (1:1). 201 when a new chat was created, 200 when it already existed.
chatsRouter.post('/chat/create', async (req, res) => {
  const { userAId, userBId } = parse(CreateChatBody, req.body);
  const result = await createOrGetDirectChat(userAId, userBId);
  res.status(result.created ? 201 : 200).json(result);
});

// ---- Bonus: group chats ----

chatsRouter.post('/chat/group/create', async (req, res) => {
  const body = parse(CreateGroupBody, req.body);
  res.status(201).json(await createGroupChat(body));
});

chatsRouter.get('/chat/:chatId', async (req, res) => {
  const { chatId } = parse(ChatParams, req.params);
  const { userId } = parse(OptionalUserQuery, req.query);
  if (userId) await requireMember(chatId, userId);
  res.json(await getChat(chatId));
});

chatsRouter.patch('/chat/:chatId', async (req, res) => {
  const { chatId } = parse(ChatParams, req.params);
  const { userId, name } = parse(RenameBody, req.body);
  res.json(await renameGroup(chatId, userId, name));
});

chatsRouter.post('/chat/:chatId/members/add', async (req, res) => {
  const { chatId } = parse(ChatParams, req.params);
  const { userId, memberIds } = parse(AddMembersBody, req.body);
  res.json(await addGroupMembers(chatId, userId, memberIds));
});

chatsRouter.post('/chat/:chatId/members/remove', async (req, res) => {
  const { chatId } = parse(ChatParams, req.params);
  const { userId, memberId } = parse(RemoveMemberBody, req.body);
  res.json(await removeGroupMember(chatId, userId, memberId));
});

chatsRouter.post('/chat/:chatId/members/role', async (req, res) => {
  const { chatId } = parse(ChatParams, req.params);
  const { userId, memberId, role } = parse(RoleBody, req.body);
  res.json(await updateGroupRole(chatId, userId, memberId, role));
});
