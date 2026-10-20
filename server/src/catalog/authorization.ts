import type { FastifyRequest } from 'fastify'
import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto'

export interface AdminPrincipal {
  subject: string
  permissions: string[]
  email?: string
  emailVerified: boolean
}

export interface AdminAuthorizer {
  readonly configured: boolean
  authorize(request: FastifyRequest): Promise<AdminPrincipal | null>
}

export interface JwtAdminAuthorizerOptions {
  issuer: string
  audience: string
  publicKey: string
  cookieName: string
}

interface JwtClaims {
  aud?: string | string[]
  exp?: number
  iss?: string
  nbf?: number
  scope?: string
  sub?: string
  email?: string
  email_verified?: boolean
}

export class JwtAdminAuthorizer implements AdminAuthorizer {
  readonly configured = true
  private readonly publicKey: KeyObject

  constructor(private readonly options: JwtAdminAuthorizerOptions) {
    this.publicKey = createPublicKey(options.publicKey)
    if (this.publicKey.asymmetricKeyType !== 'rsa' || (this.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
      throw new Error('ADMIN_JWT_PUBLIC_KEY must be an RSA public key with at least 2048 bits.')
    }
  }

  async authorize(request: FastifyRequest): Promise<AdminPrincipal | null> {
    const token = readToken(request, this.options.cookieName)
    if (!token || token.length > 16_384) return null

    const segments = token.split('.')
    if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) return null

    try {
      const header = decodeJson<{ alg?: string }>(segments[0])
      if (header.alg !== 'RS256') return null
      const claims = decodeJson<JwtClaims>(segments[1])
      const signature = Buffer.from(segments[2], 'base64url')
      if (!verifySignature('RSA-SHA256', Buffer.from(`${segments[0]}.${segments[1]}`), this.publicKey, signature)) return null

      const now = Math.floor(Date.now() / 1000)
      const audienceMatches = typeof claims.aud === 'string'
        ? claims.aud === this.options.audience
        : claims.aud?.includes(this.options.audience) === true
      if (
        claims.iss !== this.options.issuer ||
        !audienceMatches ||
        typeof claims.sub !== 'string' ||
        claims.sub.trim().length === 0 ||
        typeof claims.exp !== 'number' ||
        !Number.isFinite(claims.exp) ||
        claims.exp <= now ||
        (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf) || claims.nbf > now)) ||
        (claims.scope !== undefined && typeof claims.scope !== 'string')
      ) return null

      const grantedScopes = new Set((claims.scope ?? '').split(/\s+/))
      return {
        subject: claims.sub,
        permissions: ['catalog:read', 'catalog:write'].filter((permission) => grantedScopes.has(permission)),
        ...(claims.email_verified === true && typeof claims.email === 'string' ? { email: claims.email } : {}),
        emailVerified: claims.email_verified === true && typeof claims.email === 'string',
      }
    } catch {
      return null
    }
  }
}

export class DenyAllAdminAuthorizer implements AdminAuthorizer {
  readonly configured = false

  async authorize(_request: FastifyRequest): Promise<AdminPrincipal | null> {
    return null
  }
}

function readToken(request: FastifyRequest, cookieName: string): string | undefined {
  const authorization = request.headers.authorization
  if (authorization !== undefined) {
    const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization)
    return match?.[1]
  }

  const cookieHeader = request.headers.cookie
  if (!cookieHeader) return undefined
  const matches = cookieHeader.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${cookieName}=`))
  if (matches.length !== 1) return undefined
  return matches[0].slice(cookieName.length + 1)
}

function decodeJson<T>(segment: string): T {
  const decoded = Buffer.from(segment, 'base64url').toString('utf8')
  return JSON.parse(decoded) as T
}