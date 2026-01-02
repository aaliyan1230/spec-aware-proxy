import { deflate, inflate } from 'pako'
import { z } from 'zod'
import { decodeBase64Url, encodeBase64Url } from './base64url'

export const appStateSchema = z
  .object({
    baseUrl: z.string().url().catch(''),
    specUrl: z.string().url().optional().catch(undefined),
    operationKey: z.string().optional().catch(undefined),

    manualMethod: z.string().default('GET').catch('GET'),
    manualPath: z.string().default('/').catch('/'),

    pathParams: z.record(z.string(), z.string()).default({}).catch({}),
    queryParams: z.record(z.string(), z.string()).default({}).catch({}),
    headerParams: z.record(z.string(), z.string()).default({}).catch({}),

    contentType: z.string().default('application/json').catch('application/json'),
    bodyJson: z.string().default('').catch(''),
  })
  .strict()

export type AppState = z.infer<typeof appStateSchema>

export const defaultAppState: AppState = {
  baseUrl: '',
  specUrl: undefined,
  operationKey: undefined,

  manualMethod: 'GET',
  manualPath: '/',
  pathParams: {},
  queryParams: {},
  headerParams: {},
  contentType: 'application/json',
  bodyJson: '',
}

const MAX_STATE_BYTES = 20_000

export function encodeStateToSearchParam(state: AppState): string {
  const json = JSON.stringify(state)
  const compressed = deflate(json)
  const encoded = encodeBase64Url(compressed)
  return encoded
}

export function decodeStateFromSearchParam(input: string | undefined): AppState {
  if (!input) return defaultAppState

  try {
    const bytes = decodeBase64Url(input)
    if (bytes.byteLength > MAX_STATE_BYTES) return defaultAppState

    const inflated = inflate(bytes, { to: 'string' })
    const parsed = JSON.parse(inflated)
    const res = appStateSchema.safeParse(parsed)
    return res.success ? { ...defaultAppState, ...res.data } : defaultAppState
  } catch {
    return defaultAppState
  }
}
