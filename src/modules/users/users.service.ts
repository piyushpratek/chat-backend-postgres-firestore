import { query, type Queryable, pool } from '../../db/postgres';
import { AppError } from '../../utils/AppError';

export interface User {
  id: string;
  name: string;
  email: string | null;
  createdAt: string;
}

interface UserRow {
  id: string;
  name: string;
  email: string | null;
  created_at: Date;
}

const toUser = (r: UserRow): User => ({
  id: r.id,
  name: r.name,
  email: r.email,
  createdAt: r.created_at.toISOString(),
});

export async function createUser(input: { name: string; email?: string | undefined }): Promise<User> {
  try {
    const rows = await query<UserRow>(
      'INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id, name, email, created_at',
      [input.name.trim(), input.email?.toLowerCase() ?? null],
    );
    return toUser(rows[0]!);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw AppError.conflict('A user with this email already exists');
    }
    throw err;
  }
}

export async function getUser(userId: string): Promise<User> {
  const rows = await query<UserRow>('SELECT id, name, email, created_at FROM users WHERE id = $1', [userId]);
  if (!rows[0]) throw AppError.notFound(`User ${userId} not found`);
  return toUser(rows[0]);
}

export async function listUsers(): Promise<User[]> {
  const rows = await query<UserRow>('SELECT id, name, email, created_at FROM users ORDER BY created_at, id LIMIT 200');
  return rows.map(toUser);
}

/** Throws 404 naming the first id that does not exist. */
export async function assertUsersExist(userIds: string[], db: Queryable = pool): Promise<void> {
  const unique = [...new Set(userIds)];
  const rows = await query<{ id: string }>('SELECT id FROM users WHERE id = ANY($1::uuid[])', [unique], db);
  const found = new Set(rows.map((r) => r.id));
  const missing = unique.find((id) => !found.has(id));
  if (missing) throw AppError.notFound(`User ${missing} not found`);
}
