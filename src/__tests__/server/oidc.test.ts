import { describe, expect, it } from 'bun:test'
import { SignJWT, generateKeyPair } from 'jose'
import {
  OidcError,
  buildAuthorizeUrl,
  buildEndSessionUrl,
  createPkcePair,
  fetchUserinfo,
  readLogtoConfig,
  verifyIdToken,
  type LogtoConfig,
} from '../../../server/auth/oidc'

const CONFIG: LogtoConfig = {
  issuer: 'https://logto.test/oidc',
  authorizationEndpoint: 'https://logto.test/oidc/auth',
  tokenEndpoint: 'https://logto.test/oidc/token',
  jwksUri: 'https://logto.test/oidc/jwks',
  endSessionEndpoint: 'https://logto.test/oidc/session/end',
  appId: 'app-123',
  appSecret: 'secret',
  redirectUri: 'https://cms.test/admin/api/cms/auth/callback',
  postLogoutRedirectUri: 'https://cms.test/admin',
  scopes: 'openid profile email roles',
}

describe('Logto OIDC client', () => {
  it('readLogtoConfig requires endpoint/app-id/secret and an absolute redirect base', () => {
    expect(readLogtoConfig({}, [])).toBeNull()
    // Endpoint + app but no public origin → no absolute redirect URI → null.
    expect(
      readLogtoConfig({ LOGTO_ENDPOINT: 'https://x.logto.app', LOGTO_APP_ID: 'a', LOGTO_APP_SECRET: 's' }, []),
    ).toBeNull()

    const cfg = readLogtoConfig(
      { LOGTO_ENDPOINT: 'https://x.logto.app/', LOGTO_APP_ID: 'a', LOGTO_APP_SECRET: 's' },
      ['https://cms.test'],
    )
    expect(cfg?.redirectUri).toBe('https://cms.test/admin/api/cms/auth/callback')
    expect(cfg?.postLogoutRedirectUri).toBe('https://cms.test/admin')
    expect(cfg?.authorizationEndpoint).toBe('https://x.logto.app/oidc/auth')
    expect(cfg?.issuer).toBe('https://x.logto.app/oidc')
    // Organization scopes are requested by default so org membership + roles
    // are available at the userinfo endpoint.
    expect(cfg?.scopes).toContain('urn:logto:scope:organizations')
    expect(cfg?.scopes).toContain('urn:logto:scope:organization_roles')
  })

  it('fetchUserinfo GETs the userinfo endpoint with the bearer token', async () => {
    let seenUrl = ''
    let seenAuth = ''
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url)
      seenAuth = String((init?.headers as Record<string, string>)?.authorization ?? '')
      return new Response(JSON.stringify({ sub: 'u1', organization_roles: ['org_a:admin'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const info = await fetchUserinfo(CONFIG, 'access-tok', fakeFetch)
    expect(seenUrl).toBe('https://logto.test/oidc/me')
    expect(seenAuth).toBe('Bearer access-tok')
    expect(info.organization_roles).toEqual(['org_a:admin'])
  })

  it('fetchUserinfo throws OidcError on a non-2xx response', async () => {
    const failing = (async () => new Response('nope', { status: 401 })) as typeof fetch
    await expect(fetchUserinfo(CONFIG, 'bad', failing)).rejects.toThrow(OidcError)
  })

  it('buildAuthorizeUrl carries client id, PKCE challenge, state and nonce', () => {
    const url = new URL(buildAuthorizeUrl(CONFIG, { state: 's1', nonce: 'n1', codeChallenge: 'c1' }))
    expect(url.origin + url.pathname).toBe('https://logto.test/oidc/auth')
    expect(url.searchParams.get('client_id')).toBe('app-123')
    expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge')).toBe('c1')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('s1')
    expect(url.searchParams.get('nonce')).toBe('n1')
  })

  it('buildEndSessionUrl carries the client id and post-logout redirect', () => {
    const url = new URL(buildEndSessionUrl(CONFIG))
    expect(url.searchParams.get('client_id')).toBe('app-123')
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://cms.test/admin')
  })

  it('createPkcePair produces a verifier and a distinct S256 challenge', () => {
    const { verifier, challenge } = createPkcePair()
    expect(verifier.length).toBeGreaterThan(20)
    expect(challenge.length).toBeGreaterThan(20)
    expect(challenge).not.toBe(verifier)
  })

  it('verifyIdToken accepts a valid signed token and enforces the nonce', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256')
    const token = await new SignJWT({ nonce: 'n1', roles: ['admin'], email: 'a@b.com' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(CONFIG.issuer)
      .setAudience(CONFIG.appId)
      .setSubject('u1')
      .setExpirationTime('5m')
      .sign(privateKey)

    const payload = await verifyIdToken(CONFIG, token, 'n1', publicKey)
    expect(payload.sub).toBe('u1')
    expect(payload.roles).toEqual(['admin'])

    // Nonce mismatch is rejected.
    await expect(verifyIdToken(CONFIG, token, 'wrong-nonce', publicKey)).rejects.toThrow(OidcError)
  })

  it('verifyIdToken rejects a token from the wrong issuer/audience', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256')
    const token = await new SignJWT({ nonce: 'n1' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('https://evil.test/oidc')
      .setAudience(CONFIG.appId)
      .setSubject('u1')
      .setExpirationTime('5m')
      .sign(privateKey)

    await expect(verifyIdToken(CONFIG, token, 'n1', publicKey)).rejects.toThrow()
  })
})
