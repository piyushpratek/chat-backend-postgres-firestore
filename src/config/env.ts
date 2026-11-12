import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  // PostgreSQL (e.g. a free Neon or Supabase database)
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),

  // Firebase. Either the three service-account fields below, or
  // GOOGLE_APPLICATION_CREDENTIALS pointing at the JSON file, or
  // FIRESTORE_EMULATOR_HOST for local development and tests.
  FIREBASE_PROJECT_ID: z.string().min(1, 'FIREBASE_PROJECT_ID is required'),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),
  FIRESTORE_EMULATOR_HOST: z.string().optional(),

  MESSAGES_DEFAULT_LIMIT: z.coerce.number().int().positive().default(50),
  MESSAGES_MAX_LIMIT: z.coerce.number().int().positive().default(100),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const source = { ...process.env };
  // Tests always use a separate database so they can never wipe real data.
  if (source.NODE_ENV === 'test') {
    source.DATABASE_URL = source.TEST_DATABASE_URL;
  }
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return parsed.data;
}

export const env = loadEnv();
