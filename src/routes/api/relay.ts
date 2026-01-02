import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

const relayRequestSchema = z.object({
  baseUrl: z.string().url(),
  method: z.string().min(1),
  path: z.string().min(1),
  pathParams: z.record(z.string(), z.string()).optional().default({}),
  queryParams: z.record(z.string(), z.string()).optional().default({}),
  headers: z.record(z.string(), z.string()).optional().default({}),
  contentType: z.string().optional(),
  body: z.string().optional(),
})

type RelayRequest = z.infer<typeof relayRequestSchema>

export const Route = createFileRoute('/api/relay')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.json().catch(() => null)
        const parsed = relayRequestSchema.safeParse(raw)
        if (!parsed.success) {
          return Response.json(
            { error: 'Invalid relay request' },
            { status: 400, headers: { 'cache-control': 'no-store' } },
          )
        }

        const relayReq = parsed.data

        let targetUrl: URL
        try {
          targetUrl = buildTargetUrl(relayReq)
        } catch (err: any) {
          return Response.json(
            { error: err?.message ?? 'Invalid target URL' },
            { status: 400, headers: { 'cache-control': 'no-store' } },
          )
        }

        if (!isSafeTarget(targetUrl)) {
          return Response.json(
            { error: 'Blocked target host' },
            { status: 400, headers: { 'cache-control': 'no-store' } },
          )
        }

        const upstreamHeaders = new Headers()
        for (const [k, v] of Object.entries(relayReq.headers ?? {})) {
          if (!k) continue
          if (isHopByHopHeader(k)) continue
          upstreamHeaders.set(k, v)
        }

        if (relayReq.contentType && !upstreamHeaders.has('content-type')) {
          upstreamHeaders.set('content-type', relayReq.contentType)
        }

        const method = relayReq.method.toUpperCase()
        const hasBody = !['GET', 'HEAD'].includes(method)

        const body = hasBody && relayReq.body ? coerceBody(relayReq) : undefined

        const upstreamRes = await fetch(targetUrl.toString(), {
          method,
          headers: upstreamHeaders,
          body,
          redirect: 'manual',
        })

        const headers = new Headers(upstreamRes.headers)
        stripUnsafeResponseHeaders(headers)
        headers.set('cache-control', 'no-store')
        headers.set('x-relay-target', targetUrl.origin)

        return new Response(upstreamRes.body, {
          status: upstreamRes.status,
          statusText: upstreamRes.statusText,
          headers,
        })
      },
    },
  },
})

function buildTargetUrl(input: RelayRequest): URL {
  const base = new URL(input.baseUrl)

  const pathWithParams = input.path.replace(
    /\{([^}]+)\}/g,
    (_m, name) => encodeURIComponent(input.pathParams?.[name] ?? ''),
  )

  const url = new URL(pathWithParams, base)

  for (const [k, v] of Object.entries(input.queryParams ?? {})) {
    if (v === undefined) continue
    url.searchParams.set(k, v)
  }

  return url
}

function coerceBody(input: RelayRequest): BodyInit {
  const ct = (input.contentType ?? '').toLowerCase()
  const body = input.body ?? ''

  if (ct.includes('application/json')) {
    const parsed = body ? JSON.parse(body) : null
    return JSON.stringify(parsed)
  }

  return body
}

function isHopByHopHeader(headerName: string): boolean {
  const h = headerName.trim().toLowerCase()
  return (
    h === 'connection' ||
    h === 'keep-alive' ||
    h === 'proxy-authenticate' ||
    h === 'proxy-authorization' ||
    h === 'te' ||
    h === 'trailer' ||
    h === 'transfer-encoding' ||
    h === 'upgrade' ||
    h === 'host' ||
    h === 'content-length'
  )
}

function stripUnsafeResponseHeaders(headers: Headers) {
  for (const h of ['set-cookie', 'connection', 'transfer-encoding']) {
    headers.delete(h)
  }
}

function isSafeTarget(url: URL): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false

  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return false

  if (host === '0.0.0.0' || host === '127.0.0.1' || host === '::1') return false

  if (host === '169.254.169.254') return false

  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map((n) => Number(n))
    if (a === 10) return false
    if (a === 192 && b === 168) return false
    if (a === 172 && b >= 16 && b <= 31) return false
  }

  return true
}
