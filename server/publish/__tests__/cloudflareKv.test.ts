/**
 * The Cloudflare KV client maps put/delete onto the CF REST API. Tests inject a
 * fetch spy — no network.
 */
import { describe, expect, it } from 'bun:test'
import { createCloudflareKvClient } from '../cloudflareKv'

const CONFIG = { accountId: 'acct1', namespaceId: 'ns1', apiToken: 'tok1' }
const BASE =
  'https://api.cloudflare.com/client/v4/accounts/acct1/storage/kv/namespaces/ns1/values'

function spyFetch(response: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return response
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('createCloudflareKvClient', () => {
  it('PUT writes the value at the url-encoded key with a bearer token', async () => {
    const { impl, calls } = spyFetch(new Response('{"success":true}', { status: 200 }))
    const client = createCloudflareKvClient(CONFIG, impl)

    await client.put('shop.example.com', 'site-abc')

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${BASE}/shop.example.com`)
    expect(calls[0].init.method).toBe('PUT')
    expect(calls[0].init.body).toBe('site-abc')
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer tok1')
  })

  it('url-encodes keys with reserved characters', async () => {
    const { impl, calls } = spyFetch(new Response('{}', { status: 200 }))
    const client = createCloudflareKvClient(CONFIG, impl)
    await client.put('a/b.example.com', 'x')
    expect(calls[0].url).toBe(`${BASE}/a%2Fb.example.com`)
  })

  it('DELETE removes the key', async () => {
    const { impl, calls } = spyFetch(new Response('{}', { status: 200 }))
    const client = createCloudflareKvClient(CONFIG, impl)
    await client.delete('shop.example.com')
    expect(calls[0].init.method).toBe('DELETE')
    expect(calls[0].url).toBe(`${BASE}/shop.example.com`)
  })

  it('throws with the response body on a non-ok status', async () => {
    const { impl } = spyFetch(new Response('bad token', { status: 403 }))
    const client = createCloudflareKvClient(CONFIG, impl)
    await expect(client.put('h', 'v')).rejects.toThrow('403')
  })
})
