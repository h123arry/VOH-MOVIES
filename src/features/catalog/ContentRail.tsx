import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useRef } from 'react'
import type { CatalogItem } from './catalog.types'
import { MovieCard } from './MovieCard'

interface ContentRailProps {
  title: string
  items: CatalogItem[]
  savedIds: string[]
  onSelect: (item: CatalogItem) => void
  onToggleSaved: (id: string) => void
}

export function ContentRail({ title, items, savedIds, onSelect, onToggleSaved }: ContentRailProps) {
  const railRef = useRef<HTMLDivElement>(null)
  if (items.length === 0) return null

  const scroll = (direction: -1 | 1) => {
    railRef.current?.scrollBy({ left: direction * railRef.current.clientWidth * 0.8, behavior: 'smooth' })
  }

  return (
    <section className="content-rail" aria-label={title}>
      <div className="rail-heading">
        <h2>{title}</h2>
        <div className="rail-controls">
          <button aria-label={`Scroll ${title} left`} onClick={() => scroll(-1)}><ChevronLeft size={18} /></button>
          <button aria-label={`Scroll ${title} right`} onClick={() => scroll(1)}><ChevronRight size={18} /></button>
        </div>
      </div>
      <div className="rail-track" ref={railRef}>
        {items.map((item) => <MovieCard key={item.id} item={item} saved={savedIds.includes(item.id)} onSelect={onSelect} onToggleSaved={onToggleSaved} />)}
      </div>
    </section>
  )
}