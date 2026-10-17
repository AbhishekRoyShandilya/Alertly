import { z } from 'zod';
import { IsoDate, ID_PREFIX, publicId } from './common';

export const CreateApiKeyInput = z
  .object({ name: z.string().trim().min(1).max(100) })
  .meta({ id: 'CreateApiKeyInput' });
export type CreateApiKeyInput = z.infer<typeof CreateApiKeyInput>;

export const ApiKey = z
  .object({
    id: publicId(ID_PREFIX.apiKey),
    name: z.string(),
    prefix: z.string().meta({ description: 'First characters of the key, safe to display' }),
    lastUsedAt: IsoDate.nullable(),
    revokedAt: IsoDate.nullable(),
    createdAt: IsoDate,
  })
  .meta({ id: 'ApiKey' });
export type ApiKey = z.infer<typeof ApiKey>;

export const ApiKeyCreated = z
  .object({
    id: publicId(ID_PREFIX.apiKey),
    name: z.string(),
    prefix: z.string(),
    key: z.string().meta({ description: 'The full key. Returned only once, never stored.' }),
  })
  .meta({ id: 'ApiKeyCreated' });
export type ApiKeyCreated = z.infer<typeof ApiKeyCreated>;
