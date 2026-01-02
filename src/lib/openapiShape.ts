import { z } from 'zod'
import YAML from 'yaml'

export type HttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'OPTIONS'
  | 'HEAD'

export type ParamLocation = 'path' | 'query' | 'header'

export type ParameterShape = {
  name: string
  in: ParamLocation
  required: boolean
  schema?: {
    type?: string
    format?: string
    enum?: Array<string>
    default?: unknown
  }
}

export type BodyFieldShape = {
  name: string
  required: boolean
  type?: string
}

export type OperationShape = {
  key: string
  method: HttpMethod
  path: string
  summary?: string
  description?: string
  parameters: Array<ParameterShape>
  requestBody?: {
    contentTypes: Array<string>
    fields?: Array<BodyFieldShape>
    rawSchema?: unknown
  }
  authHint?:
    | { kind: 'bearer'; header: 'Authorization'; prefix: 'Bearer ' }
    | { kind: 'apiKey'; in: 'header'; name: string }
}

export type SpecShape = {
  title?: string
  version?: string
  servers: Array<string>
  operations: Array<OperationShape>
}

const specUrlSchema = z.string().url()

export async function fetchAndShapeOpenApi(
  specUrl: string,
  opts?: { cacheTtlSeconds?: number },
): Promise<SpecShape> {
  const parsedUrl = specUrlSchema.parse(specUrl)
  const cacheTtlSeconds = opts?.cacheTtlSeconds ?? 60

  const cacheKey = new Request(parsedUrl)

  const cached = await readCache(cacheKey)
  if (cached) return cached

  const res = await fetch(parsedUrl, {
    headers: {
      accept: 'application/json, text/yaml, application/yaml, text/plain;q=0.9',
    },
  })

  if (!res.ok) {
    throw new Response(`Failed to fetch spec: ${res.status}`, { status: 400 })
  }

  const text = await res.text()
  const spec = parseOpenApiText(text)
  const shape = reduceOpenApiSpec(spec)

  await writeCache(cacheKey, shape, cacheTtlSeconds)
  return shape
}

function parseOpenApiText(text: string): any {
  const trimmed = text.trim()
  if (!trimmed) throw new Response('Empty spec', { status: 400 })

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed)
  }

  return YAML.parse(trimmed)
}

function reduceOpenApiSpec(spec: any): SpecShape {
  const servers: Array<string> = Array.isArray(spec?.servers)
    ? spec.servers
        .map((s: any) => (typeof s?.url === 'string' ? s.url : null))
        .filter(Boolean)
    : []

  const authHint = inferGlobalAuthHint(spec)

  const operations: Array<OperationShape> = []
  const paths = spec?.paths && typeof spec.paths === 'object' ? spec.paths : {}

  for (const [path, pathItem] of Object.entries<any>(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue

    for (const method of [
      'get',
      'post',
      'put',
      'patch',
      'delete',
      'options',
      'head',
    ] as const) {
      const op = pathItem[method]
      if (!op) continue

      const methodUpper = method.toUpperCase() as HttpMethod
      const key = `${methodUpper} ${path}`

      const parameters = collectParameters(pathItem, op)
      const requestBody = reduceRequestBody(op?.requestBody)
      const opAuthHint = inferOpAuthHint(spec, op) ?? authHint

      operations.push({
        key,
        method: methodUpper,
        path,
        summary: typeof op?.summary === 'string' ? op.summary : undefined,
        description:
          typeof op?.description === 'string' ? op.description : undefined,
        parameters,
        requestBody,
        authHint: opAuthHint,
      })
    }
  }

  operations.sort((a, b) => a.key.localeCompare(b.key))

  return {
    title: typeof spec?.info?.title === 'string' ? spec.info.title : undefined,
    version:
      typeof spec?.info?.version === 'string' ? spec.info.version : undefined,
    servers,
    operations,
  }
}

function collectParameters(pathItem: any, op: any): Array<ParameterShape> {
  const params: Array<any> = []

  if (Array.isArray(pathItem?.parameters)) params.push(...pathItem.parameters)
  if (Array.isArray(op?.parameters)) params.push(...op.parameters)

  return params
    .map((p) => {
      if (!p || typeof p !== 'object') return null

      const loc = p.in
      if (loc !== 'path' && loc !== 'query' && loc !== 'header') return null

      const name = typeof p.name === 'string' ? p.name : ''
      if (!name) return null

      const schema = p.schema && typeof p.schema === 'object' ? p.schema : {}
      const enumVals =
        Array.isArray(schema.enum) && schema.enum.every((x: any) => typeof x === 'string')
          ? (schema.enum as Array<string>)
          : undefined

      return {
        name,
        in: loc,
        required: Boolean(p.required) || loc === 'path',
        schema: {
          type: typeof schema.type === 'string' ? schema.type : undefined,
          format: typeof schema.format === 'string' ? schema.format : undefined,
          enum: enumVals,
          default: schema.default,
        },
      } satisfies ParameterShape
    })
    .filter(Boolean) as Array<ParameterShape>
}

function reduceRequestBody(requestBody: any): OperationShape['requestBody'] {
  if (!requestBody || typeof requestBody !== 'object') return undefined

  const content = requestBody.content && typeof requestBody.content === 'object'
    ? requestBody.content
    : {}

  const contentTypes = Object.keys(content)
  if (contentTypes.length === 0) return undefined

  const jsonType =
    typeof content['application/json'] === 'object'
      ? 'application/json'
      : contentTypes.find((t) => t.toLowerCase().includes('json'))

  const jsonContent = jsonType ? content[jsonType] : undefined

  const schema = jsonContent?.schema

  const reduced: OperationShape['requestBody'] = {
    contentTypes,
  }

  const fields = reduceObjectSchemaFields(schema)
  if (fields) {
    reduced.fields = fields
  } else if (schema !== undefined) {
    reduced.rawSchema = schema
  }

  return reduced
}

function reduceObjectSchemaFields(schema: any): Array<BodyFieldShape> | undefined {
  if (!schema || typeof schema !== 'object') return undefined
  if (schema.type !== 'object') return undefined

  const props = schema.properties && typeof schema.properties === 'object'
    ? schema.properties
    : null
  if (!props) return undefined

  const requiredList = Array.isArray(schema.required) ? schema.required : []

  const fields: Array<BodyFieldShape> = []
  for (const [name, propSchema] of Object.entries<any>(props)) {
    const ps = propSchema && typeof propSchema === 'object' ? propSchema : {}
    fields.push({
      name,
      required: requiredList.includes(name),
      type: typeof ps.type === 'string' ? ps.type : undefined,
    })
  }

  if (fields.length === 0) return undefined
  if (fields.length > 50) return undefined

  return fields
}

function inferGlobalAuthHint(spec: any): OperationShape['authHint'] {
  const schemes = spec?.components?.securitySchemes
  if (!schemes || typeof schemes !== 'object') return undefined

  for (const scheme of Object.values<any>(schemes)) {
    const hint = inferAuthHintFromScheme(scheme)
    if (hint) return hint
  }

  return undefined
}

function inferOpAuthHint(spec: any, op: any): OperationShape['authHint'] {
  const schemes = spec?.components?.securitySchemes
  if (!schemes || typeof schemes !== 'object') return undefined

  const security = Array.isArray(op?.security) ? op.security : undefined
  if (!security) return undefined

  for (const entry of security) {
    if (!entry || typeof entry !== 'object') continue
    for (const schemeName of Object.keys(entry)) {
      const scheme = schemes[schemeName]
      const hint = inferAuthHintFromScheme(scheme)
      if (hint) return hint
    }
  }

  return undefined
}

function inferAuthHintFromScheme(scheme: any): OperationShape['authHint'] {
  if (!scheme || typeof scheme !== 'object') return undefined

  if (scheme.type === 'http' && scheme.scheme === 'bearer') {
    return { kind: 'bearer', header: 'Authorization', prefix: 'Bearer ' }
  }

  if (scheme.type === 'apiKey' && scheme.in === 'header' && typeof scheme.name === 'string') {
    return { kind: 'apiKey', in: 'header', name: scheme.name }
  }

  return undefined
}

type CacheEntry = { value: SpecShape; expiresAt: number }
const memoryCache = new Map<string, CacheEntry>()

async function readCache(key: Request): Promise<SpecShape | null> {
  const now = Date.now()

  const mem = memoryCache.get(key.url)
  if (mem && mem.expiresAt > now) return mem.value

  const cache = (globalThis as any).caches?.default as Cache | undefined
  if (!cache) return null

  const hit = await cache.match(key)
  if (!hit) return null

  const json = await hit.json().catch(() => null)
  if (!json) return null

  return json as SpecShape
}

async function writeCache(
  key: Request,
  value: SpecShape,
  ttlSeconds: number,
): Promise<void> {
  const now = Date.now()
  memoryCache.set(key.url, { value, expiresAt: now + ttlSeconds * 1000 })

  const cache = (globalThis as any).caches?.default as Cache | undefined
  if (!cache) return

  const res = new Response(JSON.stringify(value), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${ttlSeconds}`,
    },
  })

  await cache.put(key, res)
}
