import { Bookmark, Compass, Search, Shield } from 'lucide-react'
import { NavLink } from 'react-router-dom'

export function MobileNavigation() {
  return (
    <nav className="mobile-nav" aria-label="Mobile navigation">
      <NavLink to="/" end><Compass size={19} /><span>Discover</span></NavLink>
      <a href="/#catalogue"><Search size={19} /><span>Search</span></a>
      <a href="/#my-list"><Bookmark size={19} /><span>My list</span></a>
      <NavLink to="/admin"><Shield size={19} /><span>Admin</span></NavLink>
    </nav>
  )
}