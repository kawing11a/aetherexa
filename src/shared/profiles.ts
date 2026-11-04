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
  keyFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{20,}=?$/).optional(),
}).strict().refine((profile) => profile.authentication !== 'private-key-file' || Boolean(profile.keyFingerprint || profile.privateKeyPath), { message: 'Choose a managed key or provide the existing key file path.' });

const remoteFileTransferProfileSchema = z.object({
  kind: z.literal('file-transfer'),
  ...baseSchema,
  protocol: z.enum(['sftp', 'ftp', 'ftps-explicit', 'ftps-implicit']),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1).max(128),
  authentication: z.enum(['password', 'key-manager', 'agent']),
  keyFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{20,}=?$/).optional(),
}).strict().refine((profile) => profile.protocol === 'sftp' || profile.authentication === 'password', { message: 'FTP profiles require password authentication.' })
  .refine((profile) => profile.authentication !== 'key-manager' || Boolean(profile.keyFingerprint), { message: 'Choose a managed SSH key.' });

const s3FileTransferProfileSchema = z.object({
  kind: z.literal('file-transfer'),
  ...baseSchema,
  protocol: z.literal('s3'),
  bucket: z.string().min(3).max(63).regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/).refine((bucket) => !bucket.includes('..') && !/^\d+\.\d+\.\d+\.\d+$/.test(bucket), { message: 'Enter a valid AWS S3 bucket name.' }),
  region: z.string().min(3).max(64).regex(/^[a-z0-9-]+$/),
  credentialMode: z.enum(['default-chain', 'static']),
}).strict();

export const fileTransferProfileSchema = z.union([remoteFileTransferProfileSchema, s3FileTransferProfileSchema]);

export const connectionProfileSchema = z.union([databaseProfileSchema, sshProfileSchema, fileTransferProfileSchema]);

export const connectionTargetSchema = z.enum([
  'database:mysql', 'database:postgres', 'database:sqlserver', 'database:oracle', 'database:sqlite', 'database:mongodb', 'database:redis', 'database:memcached',
  'ssh', 'file-transfer:sftp', 'file-transfer:ftp', 'file-transfer:ftps-explicit', 'file-transfer:ftps-implicit', 'file-transfer:s3',
]);
export type ConnectionTarget = z.infer<typeof connectionTargetSchema>;

export const reusableFieldSchema = z.object({
  target: connectionTargetSchema,
  field: z.string().min(1).max(80),
  value: z.union([z.string().max(4096), z.number().finite(), z.boolean()]),
}).strict().refine(({ target, field }) => reusableFields[target].includes(field), { message: 'This field cannot be reused.' });

export const setupTemplateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  target: connectionTargetSchema,
  fields: z.record(z.string().max(80), z.union([z.string().max(4096), z.number().finite(), z.boolean()])),
}).strict().superRefine((template, context) => {
  if (!Object.keys(template.fields).every((field) => reusableFields[template.target].includes(field))) context.addIssue({ code: 'custom', message: 'Template contains a field that cannot be reused.' });
});

export const reusableFields: Record<ConnectionTarget, string[]> = {
  'database:mysql': ['host', 'port', 'database', 'username', 'tls'], 'database:postgres': ['host', 'port', 'database', 'username', 'tls'],
  'database:sqlserver': ['host', 'port', 'database', 'username', 'tls'], 'database:oracle': ['host', 'port', 'database', 'username', 'tls'],
  'database:sqlite': ['path'], 'database:mongodb': ['host', 'port', 'database', 'username', 'tls'],
  'database:redis': ['host', 'port', 'database', 'username', 'tls'], 'database:memcached': ['host', 'port'],
  ssh: ['host', 'port', 'username'], 'file-transfer:sftp': ['host', 'port', 'username'], 'file-transfer:ftp': ['host', 'port', 'username'],
  'file-transfer:ftps-explicit': ['host', 'port', 'username'], 'file-transfer:ftps-implicit': ['host', 'port', 'username'], 'file-transfer:s3': ['bucket', 'region'],
};

export const connectionCatalogSchema = z.object({
  groups: z.array(z.string().trim().min(1).max(80)).max(500),
  templates: z.array(setupTemplateSchema).max(500),
  reusableValues: z.array(reusableFieldSchema).max(5000),
}).strict().refine((catalog) => new Set(catalog.groups).size === catalog.groups.length, { message: 'Group names must be unique.' })
  .refine((catalog) => new Set(catalog.templates.map((template) => template.id)).size === catalog.templates.length, { message: 'Template IDs must be unique.' });
export type ConnectionCatalog = z.infer<typeof connectionCatalogSchema>;

export const catalogChangeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create-group'), name: z.string().trim().min(1).max(80) }).strict(),
  z.object({ type: z.literal('rename-group'), from: z.string().trim().min(1).max(80), to: z.string().trim().min(1).max(80) }).strict(),
  z.object({ type: z.literal('remove-group'), name: z.string().trim().min(1).max(80) }).strict(),
  z.object({ type: z.literal('put-template'), template: z.unknown() }).strict(),
  z.object({ type: z.literal('remove-template'), id: z.string().uuid() }).strict(),
  z.object({ type: z.literal('remember-fields'), values: z.array(z.unknown()).max(32) }).strict(),
]);
export type CatalogChange = z.infer<typeof catalogChangeSchema>;

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
export type FileTransferProfile = z.infer<typeof fileTransferProfileSchema>;
export type ConnectionProfile = z.infer<typeof connectionProfileSchema>;
export type SshKeyMetadata = { fingerprint: string; label: string; algorithm: 'ed25519' | 'rsa'; publicKey: string; createdAt: string };

export function parseConnectionProfile(input: unknown): ConnectionProfile {
  return connectionProfileSchema.parse(input);
}

export function isSecretBundle(input: unknown): input is SecretBundle {
  return secretBundleSchema.safeParse(input).success;
}
