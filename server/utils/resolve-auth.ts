import { eq } from 'drizzle-orm'
import type { H3Event } from 'h3'

interface ResolvedUser {
  id: string
  email: string
  name: string
  avatarUrl: string | null
  colorMode: string | null
  isAdmin: boolean
  kind: 'human' | 'agent'
  color: string | null
  managedById: string | null
}

interface AuthResult {
  user: ResolvedUser
  authMethod: 'session' | 'token'
}

export async function resolveAuth(event: H3Event): Promise<AuthResult> {
  const authHeader = getRequestHeader(event, 'authorization')

  // An OAuth access token (MCP sign-in). `data.oauth` lets the MCP endpoint
  // say `error="invalid_token"` in WWW-Authenticate, which is what tells a
  // client to refresh rather than start over.
  if (authHeader?.startsWith(`Bearer ${ACCESS_TOKEN_PREFIX}`)) {
    const grant = findGrantByAccessToken(authHeader.slice(7))
    if (!grant) {
      throw createError({ statusCode: 401, message: 'Invalid access token', data: { oauth: 'invalid_token' } })
    }
    if (grant.accessExpiresAt.getTime() < Date.now()) {
      throw createError({ statusCode: 401, message: 'Access token expired', data: { oauth: 'invalid_token' } })
    }
    const user = db.select().from(schema.users).where(eq(schema.users.id, grant.userId)).get()
    if (!user) {
      throw createError({ statusCode: 401, message: 'Invalid access token', data: { oauth: 'invalid_token' } })
    }
    if (user.suspendedAt) {
      throw createError({ statusCode: 403, message: 'Your account has been suspended' })
    }
    const now = new Date()
    db.update(schema.oauthGrants).set({ lastUsedAt: now }).where(eq(schema.oauthGrants.id, grant.id)).run()
    db.update(schema.users).set({ lastSeenAt: now }).where(eq(schema.users.id, user.id)).run()
    return {
      user: tokenUser(user),
      authMethod: 'token'
    }
  }

  if (authHeader?.startsWith('Bearer dzo_')) {
    const rawToken = authHeader.slice(7)
    const tokenHash = hashApiToken(rawToken)

    const tokenRow = db.select()
      .from(schema.apiTokens)
      .where(eq(schema.apiTokens.tokenHash, tokenHash))
      .get()

    if (!tokenRow) {
      throw createError({ statusCode: 401, message: 'Invalid API token' })
    }

    if (tokenRow.expiresAt && tokenRow.expiresAt < new Date()) {
      throw createError({ statusCode: 401, message: 'API token has expired' })
    }

    const user = db.select()
      .from(schema.users)
      .where(eq(schema.users.id, tokenRow.userId))
      .get()

    if (!user) {
      throw createError({ statusCode: 401, message: 'Invalid API token' })
    }

    if (user.suspendedAt) {
      throw createError({ statusCode: 403, message: 'Your account has been suspended' })
    }

    const now = new Date()
    db.update(schema.apiTokens)
      .set({ lastUsedAt: now })
      .where(eq(schema.apiTokens.id, tokenRow.id))
      .run()
    db.update(schema.users)
      .set({ lastSeenAt: now })
      .where(eq(schema.users.id, user.id))
      .run()

    return {
      user: tokenUser(user),
      authMethod: 'token'
    }
  }

  const session = await requireUserSession(event)
  const sessionUser = session.user as ResolvedUser

  // Re-fetch isAdmin from DB to prevent stale session privilege escalation
  const freshUser = db.select({
    isAdmin: schema.users.isAdmin,
    kind: schema.users.kind,
    color: schema.users.color,
    managedById: schema.users.managedById
  })
    .from(schema.users)
    .where(eq(schema.users.id, sessionUser.id))
    .get()

  // Every sign-in path refuses an agent, so a session naming one was not issued
  // by this server as it is now. Refuse it rather than reason about what it may do.
  if (freshUser?.kind === 'agent') {
    throw createError({ statusCode: 401, message: 'Unauthorized' })
  }

  return {
    user: {
      ...sessionUser,
      isAdmin: !!freshUser?.isAdmin,
      kind: 'human',
      color: freshUser?.color ?? null,
      managedById: null
    },
    authMethod: 'session'
  }
}

/**
 * The caller behind a token. An agent is never an admin, whatever its row says:
 * `isAdmin` grants a synthetic owner role on every project, which is exactly the
 * reach agents exist to take away from an instance owner's own token.
 */
function tokenUser(user: typeof schema.users.$inferSelect): ResolvedUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    colorMode: user.colorMode,
    isAdmin: user.kind === 'human' && !!user.isAdmin,
    kind: user.kind,
    color: user.color,
    managedById: user.managedById
  }
}
