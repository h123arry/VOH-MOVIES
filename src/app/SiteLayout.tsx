import { Outlet } from 'react-router-dom'
import { MobileNavigation } from '../components/navigation/MobileNavigation'
import { SiteFooter } from '../components/navigation/SiteFooter'
import { SiteHeader } from '../components/navigation/SiteHeader'

export function SiteLayout() {
  return (
    <div className="site-frame bg-obsidian text-white min-h-screen">
      <SiteHeader />
      <Outlet />
      <SiteFooter />
      <MobileNavigation />
    </div>
  )
}