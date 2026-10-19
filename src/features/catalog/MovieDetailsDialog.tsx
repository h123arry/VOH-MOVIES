import { Bookmark, BookmarkCheck, X } from 'lucide-react'
import type { CatalogItem } from './catalog.types'

interface MovieDetailsDialogProps {
  item: CatalogItem | null
  saved: boolean
  onClose: () => void
  onToggleSaved: (id: string) => void
}

export function MovieDetailsDialog({ item, saved, onClose, onToggleSaved }: MovieDetailsDialogProps) {
  if (!item) return null

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="details-dialog" role="dialog" aria-modal="true" aria-labelledby="details-title">
        <button className="dialog-close" onClick={onClose} aria-label="Close details"><X size={20} /></button>
        {item.backdropUrl && <img className="details-backdrop" src={item.backdropUrl} alt="" />}
        <div className="details-copy">
          <p className="eyebrow">{item.kind.toUpperCase()}{item.releaseDate ? ` / ${formatReleaseDate(item.releaseDate)}` : item.year ? ` / ${item.year}` : ''}</p>
          <h2 id="details-title">{item.title}</h2>
          {item.synopsis && <p className="details-synopsis">{item.synopsis}</p>}
          {(item.genres.length > 0 || item.duration) && <p className="details-genres">{item.genres.join('  /  ')}{item.duration ? `${item.genres.length > 0 ? '  /  ' : ''}${item.duration}` : ''}</p>}
          {item.actors.length > 0 && <p className="details-cast"><span>CAST</span> {item.actors.map((actor) => actor.name).join(' · ')}</p>}
          {item.characters.length > 0 && <p className="details-cast"><span>CHARACTERS</span> {item.characters.map((character) => character.name).join(' · ')}</p>}
          {item.seasons && item.seasons.length > 0 && <div className="details-seasons">
            { [...item.seasons].sort((left, right) => left.seasonNumber - right.seasonNumber).map((season) => (
              <section className="details-season" key={season.id}>
                <h3>Season {season.seasonNumber}{season.title ? ` · ${season.title}` : ''}</h3>
                {[...season.episodes].sort((left, right) => left.episodeNumber - right.episodeNumber).map((episode) => (
                  <article className="details-episode" key={episode.id}>
                    <span className="episode-number">{season.seasonNumber}.{String(episode.episodeNumber).padStart(2, '0')}</span>
                    <div>
                      <h4>{episode.title}</h4>
                      {episode.synopsis && <p>{episode.synopsis}</p>}
                      <span className="episode-meta">{episode.releaseDate ?? episode.releaseYear ?? ''}{episode.durationMinutes ? `${episode.releaseDate || episode.releaseYear ? ' · ' : ''}${episode.durationMinutes} min` : ''}</span>
                      {episode.actors.length > 0 && <span className="episode-meta">Cast: {episode.actors.map((actor) => actor.name).join(', ')}</span>}
                      {episode.characters.length > 0 && <span className="episode-meta">Characters: {episode.characters.map((character) => character.name).join(', ')}</span>}
                    </div>
                  </article>
                ))}
              </section>
            ))}
          </div>}
          <button className="secondary-button" onClick={() => onToggleSaved(item.id)}>
            {saved ? <BookmarkCheck size={17} /> : <Bookmark size={17} />}
            {saved ? 'Saved to my list' : 'Add to my list'}
          </button>
          <p className="playback-note">Playback is not connected yet.</p>
        </div>
      </section>
    </div>
  )
}

function formatReleaseDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}