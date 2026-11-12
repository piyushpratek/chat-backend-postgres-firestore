import { env } from './config/env';
import { createApp } from './app';
import { migrate } from './db/migrate';
import { pool } from './db/postgres';

async function main(): Promise<void> {
  // Tables are created on start-up if they are missing, so a fresh database just works.
  await migrate();
  const server = createApp().listen(env.PORT, () => {
    console.log(`Chat backend listening on http://localhost:${env.PORT}`);
    if (env.FIRESTORE_EMULATOR_HOST) console.log(`Using Firestore emulator at ${env.FIRESTORE_EMULATOR_HOST}`);
  });

  const shutdown = (signal: string): void => {
    console.log(`${signal} received, shutting down`);
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
