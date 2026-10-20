// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

const { catalogConfigMock } = vi.hoisted(() => ({ catalogConfigMock: { apiBaseUrl: undefined as string | undefined } }))

vi.mock('../catalog/catalog.config', () => ({ catalogConfig: catalogConfigMock }))

import { PlansPage } from './PlansPage'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  catalogConfigMock.apiBaseUrl = undefined
})

describe('monetization plans page', () => {
  it('does not invent plan availability when the API is not configured', async () => {
    render(<MemoryRouter><PlansPage /></MemoryRouter>)
    expect((await screen.findByRole('alert')).textContent).toContain('Configure VITE_API_BASE_URL')
    expect(screen.queryByText('Payment and entitlement were verified by the server.')).toBeNull()
  })

  it('shows server-provided plan settings and unavailable account authentication honestly', async () => {
    catalogConfigMock.apiBaseUrl = 'https://api.example.test'
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/billing/plans')) {
        return new Response(JSON.stringify({
          plans: [
            { code: 'FREE', name: 'Free', priceMinor: 0, currency: null, billingInterval: null, features: [], qualities: [], maxConcurrentStreams: null, maxWatchlistEntries: null, purchasable: false },
            { code: 'MEDIUM', name: 'Medium', priceMinor: null, currency: null, billingInterval: null, features: [], qualities: [], maxConcurrentStreams: null, maxWatchlistEntries: null, purchasable: false },
            { code: 'PRO', name: 'Pro / Premium', priceMinor: null, currency: null, billingInterval: null, features: [], qualities: [], maxConcurrentStreams: null, maxWatchlistEntries: null, purchasable: false },
          ],
          rentalsAvailable: false,
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ error: 'unauthorized', message: 'A valid account session is required.' }), { status: 401 })
    }))

    render(<MemoryRouter><PlansPage /></MemoryRouter>)
    expect(await screen.findByRole('heading', { name: 'Medium' })).toBeTruthy()
    expect(screen.getAllByText('Pricing not configured')).toHaveLength(2)
    expect(await screen.findByText('A valid account session is required.')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /Checkout unavailable/ }).every((button) => button.hasAttribute('disabled'))).toBe(true)
    expect(screen.queryByText('Payment and entitlement were verified by the server.')).toBeNull()
  })
})
