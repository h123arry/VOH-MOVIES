const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim()

export const catalogConfig = {
  apiBaseUrl: configuredApiBaseUrl ? configuredApiBaseUrl.replace(/\/+$/, '') : undefined,
}