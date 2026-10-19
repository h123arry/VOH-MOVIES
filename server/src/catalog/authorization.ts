import type { FastifyRequest } from 'fastify'

export interface AdminPrincipal {
  subject: string
  permissions: string[]
}

export interface AdminAuthorizer {
  readonly configured: boolean
  authorize(request: FastifyRequest): Promise<AdminPrincipal | null>
}

export class DenyAllAdminAuthorizer implements AdminAuthorizer {
  readonly configured = false

  async authorize(_request: FastifyRequest): Promise<AdminPrincipal | null> {
    return null
  }
}