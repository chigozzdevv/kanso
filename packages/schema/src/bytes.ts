import { z } from 'zod';

export const bytes = z.array(z.number().int().min(0).max(255));
export const hash32 = bytes.length(32);
export const version = z.number().int().positive().max(0xffff_ffff);
