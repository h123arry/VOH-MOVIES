import { Link } from 'react-router-dom'

export function NotFoundPage() {
  return (
    <main className="not-found page-container">
      <p className="eyebrow">404 / OUT OF FRAME</p>
      <h1>This page isn't in the picture.</h1>
      <Link className="text-link" to="/">Return to VOH MOVIES</Link>
    </main>
  )
}