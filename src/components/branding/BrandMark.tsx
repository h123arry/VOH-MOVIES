import { Link } from 'react-router-dom'

export function BrandMark() {
  return (
    <Link className="brand-mark" to="/" aria-label="VOH MOVIES home">
      <span className="brand-symbol" aria-hidden="true">V</span>
      <span className="brand-wordmark">
        <span>VOH</span>
        <span className="brand-subtitle">MOVIES</span>
      </span>
    </Link>
  )
}