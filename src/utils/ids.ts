import { z } from 'zod';

/** Users and chats live in PostgreSQL with UUID primary keys. */
export const uuid = z.uuid({ message: 'must be a valid UUID' });

/** Firestore auto-generated document ids (20 chars), kept permissive but safe for paths. */
export const messageId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'must be a valid message id');
