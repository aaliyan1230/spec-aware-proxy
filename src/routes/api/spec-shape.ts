import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { fetchAndShapeOpenApi } from '~/lib/openapiShape'

const querySchema = z.object({
  url: z.string().url(),
})

export const Route = createFileRoute('/api/spec-shape')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const u = new URL(request.url)
        const parsed = querySchema.safeParse({ url: u.searchParams.get('url') })
        if (!parsed.success) {
          return Response.json(
            { error: 'Missing or invalid url' },
            { status: 400, headers: { 'cache-control': 'no-store' } },
          )
        }

        try {
          const shape = await fetchAndShapeOpenApi(parsed.data.url, {
            cacheTtlSeconds: 60,
          })

          return Response.json(shape, {
            headers: {
              'cache-control': 'no-store',
            },
          })
        } catch (err: any) {
          if (err instanceof Response) return err
          return Response.json(
            { error: err?.message ?? 'Failed to load spec' },
            { status: 400, headers: { 'cache-control': 'no-store' } },
          )
        }
      },
    },
  },
})
