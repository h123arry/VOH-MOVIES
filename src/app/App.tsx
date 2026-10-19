import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { CatalogStudioPage } from '../features/admin/CatalogStudioPage'
import { HomePage } from '../features/catalog/HomePage'
import { NotFoundPage } from './NotFoundPage'
import { SiteLayout } from './SiteLayout'

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<SiteLayout />}>
          <Route index element={<HomePage />} />
          <Route path="admin" element={<CatalogStudioPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}