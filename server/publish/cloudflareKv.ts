/**
 * Thin Cloudflare KV write client over the CF REST API.
 *
 * The edge Worker (`deploy/cloudflare/`) resolves a visitor Host to a `site_id`
 * by reading a KV namespace; this client is how the app keeps that namespace in
 * sync (`edgeHostMap.ts`). Only writes/deletes single keys — the Worker owns all
 * reads.
 *
 * Server-side `fetch` to an external API is allowed here (the raw-`fetch` ban is
 * scoped to `src/admin/`). The response is validated at the boundary by checking
 * `res.ok` and surfacing the response text on failure — no `res.json() as` cast.
 */

export interface CloudflareKvConfig {
  accountId: string
  namespaceId: string
  apiToken: string
}

/**
 * The write surface the host-map sync depends on. Injectable so the sync can be
 * tested against a fake without hitting the network.
 */
export interface EdgeHostMapClient {
  put(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

type FetchImpl = typeof fetch

function valueUrl(config: CloudflareKvConfig, key: string): string {
  const base = 'https://api.cloudflare.com/client/v4'
  return `${base}/accounts/${config.accountId}/storage/kv/namespaces/${config.namespaceId}/values/${encodeURIComponent(key)}`
}

async function ensureOk(res: Response, action: string, key: string): Promise<void> {
  if (res.ok) return
  const detail = (await res.text().catch(() => '')) || res.statusText
  throw new Error(`[cloudflareKv] ${action} "${key}" failed (${res.status}): ${detail}`)
}

/**
 * Build a Cloudflare KV client bound to one namespace. `fetchImpl` defaults to the
 * runtime `fetch` and is injectable for tests.
 */
export function createCloudflareKvClient(
  config: CloudflareKvConfig,
  fetchImpl: FetchImpl = fetch,
): EdgeHostMapClient {
  const authHeaders = { authorization: `Bearer ${config.apiToken}` }
  return {
    put: async (key, value) => {
      const res = await fetchImpl(valueUrl(config, key), {
        method: 'PUT',
        headers: { ...authHeaders, 'content-type': 'text/plain' },
        body: value,
      })
      await ensureOk(res, 'PUT', key)
    },
    delete: async (key) => {
      const res = await fetchImpl(valueUrl(config, key), {
        method: 'DELETE',
        headers: authHeaders,
      })
      await ensureOk(res, 'DELETE', key)
    },
  }
}
