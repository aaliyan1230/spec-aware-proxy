import { createFileRoute } from '@tanstack/react-router'
import * as React from 'react'
import { z } from 'zod'
import type { OperationShape, SpecShape } from '~/lib/openapiShape'
import { decodeStateFromSearchParam, encodeStateToSearchParam } from '~/lib/urlState'

export const Route = createFileRoute('/')({
  validateSearch: z.object({
    s: z.string().optional(),
  }),
  component: ProxyPage,
})

function ProxyPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const decoded = React.useMemo(
    () => decodeStateFromSearchParam(search.s),
    [search.s],
  )

  const [state, setState] = React.useState(decoded)
  const [spec, setSpec] = React.useState<SpecShape | null>(null)
  const [specError, setSpecError] = React.useState<string>('')
  const [loadingSpec, setLoadingSpec] = React.useState(false)

  const [sending, setSending] = React.useState(false)
  const [responseStatus, setResponseStatus] = React.useState<string>('')
  const [responseHeaders, setResponseHeaders] = React.useState<Array<[string, string]>>([])
  const [responseBody, setResponseBody] = React.useState<string>('')
  const [sendError, setSendError] = React.useState<string>('')

  const lastEncodedRef = React.useRef<string | null>(null)
  React.useEffect(() => {
    const encoded = encodeStateToSearchParam(state)
    if (encoded === lastEncodedRef.current) return
    lastEncodedRef.current = encoded
    void navigate({ search: { s: encoded }, replace: true })
  }, [state, navigate])

  React.useEffect(() => {
    const encodedDecoded = encodeStateToSearchParam(decoded)
    if (encodedDecoded === lastEncodedRef.current) return
    setState(decoded)
  }, [decoded])

  const operations = spec?.operations ?? []
  const selectedOperation = React.useMemo(() => {
    if (!state.operationKey) return null
    return operations.find((o) => o.key === state.operationKey) ?? null
  }, [operations, state.operationKey])

  const requiredWarnings = React.useMemo(() => {
    const op = selectedOperation
    if (!op) return []

    const missing: Array<string> = []
    for (const p of op.parameters) {
      if (!p.required) continue
      const v =
        p.in === 'path'
          ? state.pathParams[p.name]
          : p.in === 'query'
            ? state.queryParams[p.name]
            : state.headerParams[p.name]

      if (!v) missing.push(`${p.in}: ${p.name}`)
    }
    if (op.requestBody?.fields?.some((f) => f.required)) {
      const obj = safeJsonObject(state.bodyJson)
      for (const f of op.requestBody.fields) {
        if (!f.required) continue
        const v = obj?.[f.name]
        if (v === undefined || v === null || v === '') missing.push(`body: ${f.name}`)
      }
    }

    return missing
  }, [selectedOperation, state.bodyJson, state.headerParams, state.pathParams, state.queryParams])

  const shareUrl = React.useMemo(() => {
    if (typeof window === 'undefined') return ''
    const u = new URL(window.location.href)
    return u.toString()
  }, [search.s])

  async function loadSpec() {
    setSpecError('')
    setLoadingSpec(true)
    setSpec(null)

    try {
      if (!state.specUrl) throw new Error('Spec URL is required')

      const res = await fetch(`/api/spec-shape?url=${encodeURIComponent(state.specUrl)}`)
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error(json?.error ?? `Failed to load spec (${res.status})`)

      const nextSpec = json as SpecShape
      setSpec(nextSpec)

      if (!state.operationKey && nextSpec.operations.length > 0) {
        setState((s) => ({ ...s, operationKey: nextSpec.operations[0]!.key }))
      }
    } catch (err: any) {
      setSpecError(err?.message ?? 'Failed to load spec')
    } finally {
      setLoadingSpec(false)
    }
  }

  function setParam(op: OperationShape, pName: string, value: string) {
    const p = op.parameters.find((x) => x.name === pName)
    if (!p) return

    setState((s) => {
      if (p.in === 'path') return { ...s, pathParams: { ...s.pathParams, [pName]: value } }
      if (p.in === 'query') return { ...s, queryParams: { ...s.queryParams, [pName]: value } }
      return { ...s, headerParams: { ...s.headerParams, [pName]: value } }
    })
  }

  function setAuthFromHint(op: OperationShape, rawToken: string) {
    const hint = op.authHint
    if (!hint) return

    if (hint.kind === 'bearer') {
      setState((s) => ({
        ...s,
        headerParams: {
          ...s.headerParams,
          Authorization: rawToken ? `${hint.prefix}${rawToken}` : '',
        },
      }))
      return
    }

    if (hint.kind === 'apiKey') {
      setState((s) => ({
        ...s,
        headerParams: {
          ...s.headerParams,
          [hint.name]: rawToken,
        },
      }))
    }
  }

  async function sendRequest() {
    setSendError('')
    setResponseStatus('')
    setResponseHeaders([])
    setResponseBody('')

    try {
      if (!state.baseUrl) throw new Error('Base URL is required')

      const method = selectedOperation?.method ?? state.manualMethod
      const path = selectedOperation?.path ?? state.manualPath
      if (!path) throw new Error('Path is required')

      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(state.headerParams)) {
        if (!k) continue
        if (!v) continue
        headers[k] = v
      }

      const payload = {
        baseUrl: state.baseUrl,
        method,
        path,
        pathParams: state.pathParams,
        queryParams: state.queryParams,
        headers,
        contentType: state.contentType,
        body: state.bodyJson,
      }

      setSending(true)
      const res = await fetch('/api/relay', {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(payload),
      })

      setResponseStatus(`${res.status} ${res.statusText}`.trim())
      setResponseHeaders(Array.from(res.headers.entries()))

      if (!res.body) {
        const text = await res.text().catch(() => '')
        setResponseBody(text)
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let out = ''

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        out += decoder.decode(value, { stream: true })
        setResponseBody(out)
      }

      out += decoder.decode()
      setResponseBody(out)
    } catch (err: any) {
      setSendError(err?.message ?? 'Request failed')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="mx-auto max-w-5xl p-4">
      <div className="flex flex-col gap-4">
        <div className="rounded-lg border bg-white p-4 dark:bg-gray-900">
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium">API base URL</span>
                <input
                  className="rounded-md border bg-transparent px-3 py-2"
                  placeholder="https://api.example.com"
                  value={state.baseUrl}
                  onChange={(e) => setState((s) => ({ ...s, baseUrl: e.target.value }))}
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium">OpenAPI spec URL (optional)</span>
                <input
                  className="rounded-md border bg-transparent px-3 py-2"
                  placeholder="https://api.example.com/openapi.json"
                  value={state.specUrl ?? ''}
                  onChange={(e) =>
                    setState((s) => ({
                      ...s,
                      specUrl: e.target.value ? e.target.value : undefined,
                    }))
                  }
                />
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                className="rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-50"
                onClick={() => void loadSpec()}
                disabled={!state.specUrl || loadingSpec}
              >
                {loadingSpec ? 'Loading spec...' : 'Load spec'}
              </button>
              {specError ? (
                <span className="text-sm text-red-600 dark:text-red-400">{specError}</span>
              ) : null}
              <span className="ml-auto text-xs text-gray-500">State is stored in the URL</span>
            </div>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border bg-white p-4 dark:bg-gray-900">
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-base font-semibold">Request</h2>
                <button
                  className="rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-50"
                  onClick={() => void sendRequest()}
                  disabled={sending}
                >
                  {sending ? 'Sending...' : 'Send'}
                </button>
              </div>

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium">Operation</span>
                <select
                  className="rounded-md border bg-transparent px-3 py-2"
                  value={state.operationKey ?? '__manual__'}
                  onChange={(e) => {
                    const v = e.target.value
                    setState((s) => ({
                      ...s,
                      operationKey: v === '__manual__' ? undefined : v,
                      pathParams: {},
                      queryParams: {},
                      headerParams: {},
                      bodyJson: '',
                    }))
                  }}
                >
                  <option value="__manual__">Manual</option>
                  {operations.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.key}
                    </option>
                  ))}
                </select>
              </label>

              {selectedOperation ? (
                <div className="rounded-md border bg-gray-50 p-3 text-sm dark:bg-gray-950">
                  <div className="font-mono">
                    {selectedOperation.method} {selectedOperation.path}
                  </div>
                  {selectedOperation.summary ? (
                    <div className="mt-1 text-gray-600 dark:text-gray-300">
                      {selectedOperation.summary}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-sm font-medium">Method</span>
                    <select
                      className="rounded-md border bg-transparent px-3 py-2"
                      value={state.manualMethod}
                      onChange={(e) => setState((s) => ({ ...s, manualMethod: e.target.value }))}
                    >
                      {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-sm font-medium">Path</span>
                    <input
                      className="rounded-md border bg-transparent px-3 py-2 font-mono text-sm"
                      placeholder="/v1/resource"
                      value={state.manualPath}
                      onChange={(e) => setState((s) => ({ ...s, manualPath: e.target.value }))}
                    />
                  </label>
                </div>
              )}

              {requiredWarnings.length ? (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/40 dark:text-amber-200">
                  <div className="font-medium">Missing required fields</div>
                  <div className="mt-1 font-mono text-xs">{requiredWarnings.join(' | ')}</div>
                </div>
              ) : null}

              {selectedOperation ? (
                <div className="flex flex-col gap-4">
                  {selectedOperation.authHint ? (
                    <label className="flex flex-col gap-1">
                      <span className="text-sm font-medium">Auth</span>
                      <input
                        className="rounded-md border bg-transparent px-3 py-2"
                        placeholder={
                          selectedOperation.authHint.kind === 'bearer'
                            ? 'Bearer token'
                            : selectedOperation.authHint.name
                        }
                        onChange={(e) => setAuthFromHint(selectedOperation, e.target.value)}
                      />
                      <span className="text-xs text-gray-500">Not stored, only forwarded</span>
                    </label>
                  ) : null}

                  {selectedOperation.parameters.length ? (
                    <div className="flex flex-col gap-2">
                      <div className="text-sm font-medium">Parameters</div>
                      <div className="flex flex-col gap-2">
                        {selectedOperation.parameters.map((p) => {
                          const v =
                            p.in === 'path'
                              ? state.pathParams[p.name] ?? ''
                              : p.in === 'query'
                                ? state.queryParams[p.name] ?? ''
                                : state.headerParams[p.name] ?? ''

                          const enumVals = p.schema?.enum
                          return (
                            <label key={`${p.in}:${p.name}`} className="flex flex-col gap-1">
                              <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
                                {p.in} / {p.name}{' '}
                                {p.required ? (
                                  <span className="text-red-600 dark:text-red-400">required</span>
                                ) : null}
                              </span>
                              {enumVals?.length ? (
                                <select
                                  className="rounded-md border bg-transparent px-3 py-2"
                                  value={v}
                                  onChange={(e) => setParam(selectedOperation, p.name, e.target.value)}
                                >
                                  <option value="">Select...</option>
                                  {enumVals.map((ev) => (
                                    <option key={ev} value={ev}>
                                      {ev}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <input
                                  className="rounded-md border bg-transparent px-3 py-2"
                                  value={v}
                                  onChange={(e) => setParam(selectedOperation, p.name, e.target.value)}
                                />
                              )}
                            </label>
                          )
                        })}
                      </div>
                    </div>
                  ) : null}

                  {selectedOperation.requestBody ? (
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm font-medium">Body</div>
                        <select
                          className="rounded-md border bg-transparent px-3 py-2 text-sm"
                          value={state.contentType ?? 'application/json'}
                          onChange={(e) =>
                            setState((s) => ({ ...s, contentType: e.target.value }))
                          }
                        >
                          {selectedOperation.requestBody.contentTypes.map((ct) => (
                            <option key={ct} value={ct}>
                              {ct}
                            </option>
                          ))}
                        </select>
                      </div>

                      {selectedOperation.requestBody.fields?.length ? (
                        <div className="grid gap-2 md:grid-cols-2">
                          {selectedOperation.requestBody.fields.map((f) => {
                            const obj = safeJsonObject(state.bodyJson) ?? {}
                            const v = obj[f.name] ?? ''
                            return (
                              <label key={f.name} className="flex flex-col gap-1">
                                <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
                                  {f.name}{' '}
                                  {f.required ? (
                                    <span className="text-red-600 dark:text-red-400">required</span>
                                  ) : null}
                                </span>
                                <input
                                  className="rounded-md border bg-transparent px-3 py-2"
                                  value={String(v)}
                                  onChange={(e) => {
                                    const next = { ...obj, [f.name]: coerceValue(e.target.value, f.type) }
                                    setState((s) => ({
                                      ...s,
                                      bodyJson: JSON.stringify(next, null, 2),
                                    }))
                                  }}
                                />
                              </label>
                            )
                          })}
                        </div>
                      ) : null}

                      <label className="flex flex-col gap-1">
                        <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
                          Raw body
                        </span>
                        <textarea
                          className="min-h-40 w-full rounded-md border bg-transparent px-3 py-2 font-mono text-xs"
                          placeholder={
                            state.contentType?.includes('json')
                              ? '{\n  "example": true\n}'
                              : '...'
                          }
                          value={state.bodyJson ?? ''}
                          onChange={(e) => setState((s) => ({ ...s, bodyJson: e.target.value }))}
                        />
                      </label>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <label className="flex flex-col gap-1">
                    <span className="text-sm font-medium">Query params</span>
                    <textarea
                      className="min-h-24 w-full rounded-md border bg-transparent px-3 py-2 font-mono text-xs"
                      placeholder="key=value"
                      value={pairsToText(state.queryParams)}
                      onChange={(e) =>
                        setState((s) => ({ ...s, queryParams: textToPairs(e.target.value) }))
                      }
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-sm font-medium">Headers</span>
                    <textarea
                      className="min-h-24 w-full rounded-md border bg-transparent px-3 py-2 font-mono text-xs"
                      placeholder="Header-Name: value"
                      value={pairsToText(state.headerParams)}
                      onChange={(e) =>
                        setState((s) => ({ ...s, headerParams: textToPairs(e.target.value) }))
                      }
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-sm font-medium">Body</span>
                    <textarea
                      className="min-h-40 w-full rounded-md border bg-transparent px-3 py-2 font-mono text-xs"
                      placeholder={`{\n  "hello": "world"\n}`}
                      value={state.bodyJson ?? ''}
                      onChange={(e) => setState((s) => ({ ...s, bodyJson: e.target.value }))}
                    />
                  </label>
                </div>
              )}

              {sendError ? (
                <div className="text-sm text-red-600 dark:text-red-400">{sendError}</div>
              ) : null}

              {shareUrl ? (
                <div className="text-xs text-gray-500">
                  Share link: <span className="break-all">{shareUrl}</span>
                </div>
              ) : null}
            </div>
          </div>

          <div className="rounded-lg border bg-white p-4 dark:bg-gray-900">
            <div className="flex flex-col gap-3">
              <div>
                <h2 className="text-base font-semibold">Response</h2>
                {responseStatus ? (
                  <div className="mt-1 font-mono text-xs text-gray-600 dark:text-gray-300">
                    {responseStatus}
                  </div>
                ) : null}
              </div>

              {responseHeaders.length ? (
                <details className="rounded-md border bg-gray-50 p-3 text-xs dark:bg-gray-950">
                  <summary className="cursor-pointer select-none font-medium">Headers</summary>
                  <div className="mt-2 space-y-1 font-mono">
                    {responseHeaders.map(([k, v]) => (
                      <div key={k}>
                        {k}: {v}
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}

              <pre className="min-h-72 overflow-auto rounded-md border bg-gray-50 p-3 text-xs dark:bg-gray-950">
                {responseBody || '...'}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function safeJsonObject(input: string | undefined): Record<string, any> | null {
  if (!input) return null
  try {
    const parsed = JSON.parse(input)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

function coerceValue(raw: string, type: string | undefined): any {
  const t = (type ?? '').toLowerCase()
  if (t === 'number' || t === 'integer') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : raw
  }
  if (t === 'boolean') {
    if (raw === 'true') return true
    if (raw === 'false') return false
    return raw
  }
  return raw
}

function pairsToText(pairs: Record<string, string>): string {
  return Object.entries(pairs)
    .filter(([k, v]) => k && v)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
}

function textToPairs(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf(':')
    if (idx === -1) continue
    const k = trimmed.slice(0, idx).trim()
    const v = trimmed.slice(idx + 1).trim()
    if (!k) continue
    out[k] = v
  }
  return out
}
