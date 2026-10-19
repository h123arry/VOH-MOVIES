import { useCallback, useEffect, useState } from 'react'
import type { CatalogLoadResult } from './catalog.models'
import { catalogService } from './catalog.service'

type CatalogState = CatalogLoadResult | { status: 'loading'; items: [] }

export function useCatalog(options: { admin?: boolean } = {}) {
  const [state, setState] = useState<CatalogState>({ status: 'loading', items: [] })

  const reload = useCallback(async (signal?: AbortSignal) => {
    setState({ status: 'loading', items: [] })
    const result = options.admin ? await catalogService.listAdmin(signal) : await catalogService.list(signal)
    if (!signal?.aborted) setState(result)
  }, [options.admin])

  useEffect(() => {
    const controller = new AbortController()
    void reload(controller.signal)
    return () => controller.abort()
  }, [reload])

  return { ...state, reload }
}