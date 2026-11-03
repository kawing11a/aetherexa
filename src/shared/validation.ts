import { z } from 'zod';

export const emptyRequestSchema = z.object({}).strict();

export const profileSaveInputSchema = z.object({
  profile: z.unknown(),
  secrets: z.record(z.string().min(1).max(80), z.string().max(65536)).optional(),
}).strict();

export const profileIdInputSchema = z.object({
  id: z.string().uuid(),
}).strict();
