/**
 * Creates four demo users with fixed ids so the README's example requests work as-is.
 * Safe to run more than once. Usage: npm run seed
 */
import { migrate } from '../src/db/migrate';
import { pool } from '../src/db/postgres';

export const DEMO_USERS = [
  { id: '00000000-0000-4000-8000-000000000001', name: 'Aarav', email: 'aarav@example.com' },
  { id: '00000000-0000-4000-8000-000000000002', name: 'Bhavna', email: 'bhavna@example.com' },
  { id: '00000000-0000-4000-8000-000000000003', name: 'Chirag', email: 'chirag@example.com' },
  { id: '00000000-0000-4000-8000-000000000004', name: 'Diya', email: 'diya@example.com' },
] as const;

async function seed(): Promise<void> {
  await migrate();
  for (const u of DEMO_USERS) {
    await pool.query('INSERT INTO users (id, name, email) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [
      u.id,
      u.name,
      u.email,
    ]);
  }
  console.table(DEMO_USERS.map((u) => ({ name: u.name, id: u.id })));
  await pool.end();
}

seed().catch((err: unknown) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
