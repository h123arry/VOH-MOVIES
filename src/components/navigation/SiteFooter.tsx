import { BrandMark } from '../branding/BrandMark'

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <BrandMark />
        <p>A new world of entertainment, powered by VOH.</p>
        <span className="footer-status"><i /> Catalogue connection pending</span>
        <span className="copyright">© {new Date().getFullYear()} VOH</span>
      </div>
    </footer>
  )
}