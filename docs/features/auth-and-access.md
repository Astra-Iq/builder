# Auth and Access

Authentication is delegated to **Logto** (OIDC). The builder is an OIDC client:
unauthenticated visitors are redirected to Logto to sign in, Logto redirects
back to a callback, and the builder mints its own opaque session cookie.
Authorization keeps the builder's capability model — a signed-in user's Logto
**role** maps onto one of the four built-in roles, whose capability set gates
every request exactly as before.

There is no local password, MFA, lockout, step-up, or user-management surface —
Logto owns identity and credentials.

---

## TL;DR

- **Login** is an OIDC Authorization Code + PKCE flow. `GET /admin/api/cms/auth/login`
  redirects to Logto; `GET /admin/api/cms/auth/callback` verifies the ID token and
  mints the session cookie; `GET /admin/api/cms/auth/logout` revokes the session and
  redirects to Logto's end-session endpoint.
- **Sessions** are still token-cookie based and unchanged from the runtime's point of
  view: cookie name `instatic_admin_session` (`SESSION_COOKIE_NAME`), the raw token in
  the cookie, only its SHA-256 hash in the `sessions` table. Per-request auth validates
  the cookie against the DB — it never re-contacts Logto.
- **Capabilities** are the access model. `CoreCapability` (`src/core/capabilities.ts`)
  and the four built-in roles in `SYSTEM_ROLES` (`server/auth/capabilities.ts`) are
  unchanged. Handlers gate on capability via `requireCapability(req, db, '...')`.
- **Role mapping:** the user's Logto role name (`owner` / `admin` / `client` / `member`)
  selects the matching built-in role; the local identity row is assigned that `role_id`,
  and capabilities flow from `roles.capabilities_json` exactly as before. Default when no
  role matches: `member` (no capabilities).
- **Local identities are auto-provisioned.** A `users` row keyed by the Logto subject
  (`users.logto_subject`) is upserted on every login, so content authorship, audit actor,
  and the `sessions.user_id` FK keep referencing a real local id. The row carries no
  credential (`password_hash = ''`, never verified).
- **CSRF** defense is unchanged: state-changing methods must come from a configured
  public origin (`server/auth/security.ts`). The OIDC login/callback are GETs; the
  callback is protected by the `state` parameter bound to a short-lived tx cookie.

---

## The sign-in flow

```text
GET /admin/*  (no session cookie)
    │  server/static.ts serveAdminApp
    ▼
302 → /admin/api/cms/auth/login
    │  mint PKCE verifier + state + nonce; stash in a short-lived HttpOnly tx cookie
    ▼
302 → Logto authorize endpoint (code + PKCE + state + nonce)
    │  user signs in at Logto
    ▼
GET /admin/api/cms/auth/callback?code=…&state=…
    │  validate state == tx cookie
    │  exchange code → tokens (server/auth/oidc.ts exchangeCodeForTokens)
    │  verify ID token via JWKS + iss/aud/nonce (verifyIdToken)
    │  provisionUserFromClaims → upsert users row by logto_subject, assign mapped role
    │  createSession + Set-Cookie: instatic_admin_session=…
    ▼
302 → /admin/site
```

Per request thereafter: `requireAuthenticatedUser` (`server/auth/authz.ts`) hashes the
cookie, loads the user + role + capabilities via one join (`findUserBySessionHash`), and
`requireCapability` checks the needed capability. No Logto round-trip.

Logout: `GET /admin/api/cms/auth/logout` revokes the session row, clears the cookie, and
redirects to Logto's end-session endpoint (`buildEndSessionUrl`).

---

## Configuration

Set these env vars (see `.env.example`). The server boots without them, but the auth
routes return 500 until they are present.

| Var | Purpose |
|-----|---------|
| `LOGTO_ENDPOINT` | Tenant base URL, e.g. `https://your-tenant.logto.app`. OIDC endpoints are derived under `${endpoint}/oidc`. |
| `LOGTO_APP_ID` / `LOGTO_APP_SECRET` | The Logto "Traditional Web" application credentials. |
| `PUBLIC_ORIGIN` | Used to derive the callback (`/admin/api/cms/auth/callback`) and post-logout (`/admin`) URIs. |
| `LOGTO_REDIRECT_URI` / `LOGTO_POST_LOGOUT_REDIRECT_URI` | Optional explicit overrides. |
| `LOGTO_SCOPES` | Optional; defaults to `openid profile email roles`. |

In Logto: create roles named `owner`, `admin`, `client`, `member`; assign them to users;
register the callback URL and the post-logout URL on the application; ensure the `roles`
scope is granted so the user's roles appear in the ID token's `roles` claim.

---

## Roles → capabilities

The four built-in roles and their capability sets live in `SYSTEM_ROLES`
(`server/auth/capabilities.ts`) and are seeded/resynced into the `roles` table at boot
(`syncSystemRoles`). This is the reference the Logto role name maps onto:

| Role | Capabilities |
|------|--------------|
| Owner | All `CORE_CAPABILITIES` |
| Admin | All except `roles.manage` |
| Client | A copy-editor subset (`site.read`, `site.content.edit`, `media.read`, `data.custom.tables.read`) |
| Member | None |

The mapping and provisioning code is `server/auth/logtoIdentity.ts`
(`mapLogtoRoleToBuilderRole`, `provisionUserFromClaims`); the OIDC client is
`server/auth/oidc.ts`.

---

## Handler patterns (unchanged)

```ts
const user = await requireCapability(req, db, 'site.read')
if (user instanceof Response) return user   // 401 unauth / 403 missing capability
```

`requireAuthenticatedUser`, `requireCapability`, `requireAnyCapability`, and the
`userHasCapability` / `userHasAnyCapability` helpers are unchanged. There is no
`requireStepUp` anymore — step-up re-authentication is gone with local passwords.

---

## Where the code lives

```text
src/core/capabilities.ts       — CORE_CAPABILITIES, CoreCapability (unchanged)
server/auth/
├── oidc.ts             — OIDC client: authorize URL, PKCE, token exchange, JWKS verify, end-session
├── logtoIdentity.ts    — Logto role → builder role mapping + provisionUserFromClaims
├── authz.ts            — requireAuthenticatedUser / requireCapability / requireAnyCapability
├── capabilities.ts     — SYSTEM_ROLES, normalizeCapabilities, roleHasCapability
├── sessions.ts         — createSession, findUserBySessionHash, revokeSessionByHash
├── tokens.ts           — SESSION_COOKIE_NAME, createSessionToken, hashSessionToken
├── security.ts         — CSRF origin check + trusted-proxy IP attribution
└── deviceLabel.ts      — UA → friendly device label
server/handlers/cms/auth.ts    — /auth/login, /auth/callback, /auth/logout, /me
server/bootstrapSite.ts        — first-run site + starter homepage (replaces the setup wizard)
```

---

## Related

- [docs/architecture.md](../architecture.md) — system overview
- [docs/reference/capabilities.md](../reference/capabilities.md) — capability matrix
- Source-of-truth files: `server/auth/oidc.ts`, `server/auth/logtoIdentity.ts`,
  `server/handlers/cms/auth.ts`, `server/auth/authz.ts`, `server/auth/capabilities.ts`
- Tests: `src/__tests__/server/oidc.test.ts`, `src/__tests__/server/logtoIdentity.test.ts`,
  `src/__tests__/server/capabilityRouteMatrix.test.ts`
