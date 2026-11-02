import { z } from 'zod';

export const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const near_account = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
export const development_network = z.enum(['sandbox', 'testnet']);
