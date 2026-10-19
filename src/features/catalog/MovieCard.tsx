import { Bookmark, BookmarkCheck } from 'lucide-react'
import type { CatalogItem } from './catalog.types'

interface MovieCardProps {
  item: CatalogItem
  saved: boolean
  onSelect: (item: CatalogItem) => void
  onToggleSaved: (id: string) => void
}

export function MovieCard({ item, saved, onSelect, onToggleSaved }: MovieCardProps) {
  return (
    <article className="movie-card">
      <button className="poster-button" onClick={() => onSelect(item)} aria-label={`View details for ${item.title}`}>
        {item.posterUrl ? <img src={item.posterUrl} alt={`${item.title} poster`} loading="lazy" /> : <span className="poster-fallback">VOH</span>}
        <span className="poster-shade" />
        <span className="poster-title">{item.title}</span>
      </button>
      <div className="movie-card-meta">
        <button className="movie-title-button" onClick={() => onSelect(item)}>{item.title}</button>
        <span>{item.year ?? item.kind}</span>
        <button
          className="save-button"
          onClick={() => onToggleSaved(item.id)}
          aria-label={saved ? `Remove ${item.title} from my list` : `Save ${item.title} to my list`}
          title={saved ? 'Remove from my list' : 'Save to my list'}
        >
          {saved ? <BookmarkCheck size={17} /> : <Bookmark size={17} />}
        </button>
      </div>
    </article>
  )
}