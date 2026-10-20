import { ArrowUpRight, Search, Shield } from 'lucide-react'
import { Link, NavLink } from 'react-router-dom'
import { BrandMark } from '../branding/BrandMark'

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="header-inner">
        <BrandMark />
        <nav className="desktop-nav" aria-label="Main navigation">
          <NavLink to="/" end>Discover</NavLink>
          <a href="/#catalogue">Catalogue</a>
          <a href="/#my-list">My list</a>
          <NavLink to="/plans">Plans</NavLink>
        </nav>
        <div className="header-actions">
          <a className="icon-link search-link" href="/#catalogue" aria-label="Search catalogue" title="Search catalogue">
            <Search size={18} strokeWidth={1.8} />
          </a>
          <Link className="admin-link" to="/admin">
            <Shield size={15} strokeWidth={1.8} />
            <span>Control centre</span>
            <ArrowUpRight className="admin-arrow" size={13} />
          </Link>
        </div>
      </div>
    </header>
  )
}