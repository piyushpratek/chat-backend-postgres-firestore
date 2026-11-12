import type { z } from 'zod';
import { AppError } from './AppError';

/** Parses input with a zod schema and throws a 400 with field-level details on failure. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({
      field: i.path.join('.') || '(root)',
      message: i.message,
    }));
    throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', details);
  }
  return result.data;
}
