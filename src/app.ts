import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env';
import { pool } from './db/postgres';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { chatsRouter } from './modules/chats/chats.routes';
import { messagesRouter } from './modules/messages/messages.routes';
import { usersRouter } from './modules/users/users.routes';

export function createApp(): Express {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));
  if (env.NODE_ENV !== 'test') app.use(morgan('dev'));

  app.get('/', (_req, res) => {
    res.json({ name: 'chat-backend', status: 'ok', docs: 'See README.md for every endpoint' });
  });

  app.get('/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', postgres: 'up' });
  });

  app.use(usersRouter);
  app.use(chatsRouter);
  app.use(messagesRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
