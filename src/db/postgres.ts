import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { env } from '../config/env';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  // Hosted Postgres (Neon, Supabase) needs SSL. "sslmode=require" in the URL also works.
  ...(env.DATABASE_SSL ? { ssl: { rejectUnauthorized: false } } : {}),
  max: 10,
});

pool.on('error', (err) => {
  console.error('[postgres] idle client error', err);
});

/** Anything that can run a query: the pool, or a client inside a transaction. */
export type Queryable = Pick<PoolClient, 'query'>;

export async function query<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
  db: Queryable = pool,
): Promise<T[]> {
  const result = await db.query<T>(text, params);
  return result.rows;
}

/** Runs fn inside BEGIN/COMMIT, rolling back on any error. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
