import { z } from 'zod';

const databaseEngineSchema = z.enum([
  'mysql',
  'postgres',
  'sqlserver',
  'oracle',
  'sqlite',
  'mongodb',
  'redis',
  'memcached',
]);

const optionValueSchema = z.union([
  z.string().max(4096),
  z.number().finite(),
  z.boolean(),
]);

const baseSchema = {
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  groupId: z.string().trim().max(80).nullable(),
  secretRevision: z.string().uuid().optional(),
};

export const databaseProfileSchema = z.object({
  kind: z.literal('database'),
  ...baseSchema,
  engine: databaseEngineSchema,
  options: z.record(z.string().max(80), optionValueSchema).refine((options) => Object.keys(options).every((key) => !/(password|secret|token|credential|private.?key)/i.test(key)), { message: 'Secrets must be stored outside connection profile metadata.' }),
}).strict();

export const sshProfileSchema = z.object({
  kind: z.literal('ssh'),
  ...baseSchema,
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1).max(128),
  authentication: z.enum(['password', 'private-key-file', 'agent']),
  privateKeyPath: z.string().trim().max(4096).optional(),
}).strict();

export const connectionProfileSchema = z.discriminatedUnion('kind', [
  databaseProfileSchema,
  sshProfileSchema,
]);

export const secretBundleSchema = z.record(
  z.string().trim().min(1).max(80),
  z.string().max(65536),
).refine((bundle) => JSON.stringify(bundle).length <= 262144, {
  message: 'Secret bundle exceeds the storage limit.',
});

export type DatabaseEngine = z.infer<typeof databaseEngineSchema>;
export type SecretBundle = Readonly<Record<string, string>>;
export type DatabaseProfile = z.infer<typeof databaseProfileSchema>;
export type SshProfile = z.infer<typeof sshProfileSchema>;
export type ConnectionProfile = z.infer<typeof connectionProfileSchema>;

export function parseConnectionProfile(input: unknown): ConnectionProfile {
  return connectionProfileSchema.parse(input);
}

export function isSecretBundle(input: unknown): input is SecretBundle {
  return secretBundleSchema.safeParse(input).success;
}
