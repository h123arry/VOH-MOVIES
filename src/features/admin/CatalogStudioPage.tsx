import { useState } from 'react'
import { ArrowLeft, Check, Film, Plus, Save, Trash2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { CatalogEntrySchema, type CatalogEntry } from '../catalog/catalog.models'
import { catalogConfig } from '../catalog/catalog.config'
import { catalogService } from '../catalog/catalog.service'
import { useCatalog } from '../catalog/useCatalog'

type SaveMode = 'draft' | 'keep-status' | 'publish'
type RetryAction = { type: 'save'; mode: SaveMode } | { type: 'delete'; id: string }

export function CatalogStudioPage() {
  const catalog = useCatalog({ admin: true })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draftText, setDraftText] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Array<{ path: string; message: string }>>([])
  const [operationError, setOperationError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [retryAction, setRetryAction] = useState<RetryAction | null>(null)
  const records = catalog.status === 'ready' ? catalog.items : []
  const selected = records.find((record) => record.id === selectedId)
  const storageMode = catalog.status === 'ready'
    ? catalog.storage
    : catalogConfig.apiBaseUrl
      ? 'api'
      : 'device'

  const startNew = (kind: 'film' | 'series') => {
    const base = {
      id: createRecordId(),
      kind,
      publicationStatus: 'draft',
      title: '',
      synopsis: '',
      genres: [],
      actors: [],
      characters: [],
      distributionRights: [],
    }
    const draft = kind === 'film' ? { ...base, durationMinutes: 0 } : { ...base, seasons: [] }
    setSelectedId(null)
    setDraftText(JSON.stringify(draft, null, 2))
    clearMessages()
  }

  const selectRecord = (record: CatalogEntry) => {
    setSelectedId(record.id)
    setDraftText(JSON.stringify(record, null, 2))
    clearMessages()
  }

  const save = async (mode: SaveMode) => {
    clearMessages()
    let raw: unknown
    try {
      raw = JSON.parse(draftText)
    } catch (error) {
      setOperationError(error instanceof Error ? `JSON syntax: ${error.message}` : 'The record must be valid JSON.')
      return
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      setOperationError('The record must be a JSON object.')
      return
    }
    const publicationStatus = mode === 'draft' ? 'draft' : mode === 'publish' ? 'published' : undefined
    const candidate = publicationStatus ? { ...raw, publicationStatus } : raw
    const validation = CatalogEntrySchema.safeParse(candidate)
    if (!validation.success) {
      setFieldErrors(validation.error.issues.map((issue) => ({ path: issue.path.map(String).join('.') || 'record', message: issue.message })))
      return
    }

    setBusy(true)
    try {
      const result = selectedId
        ? await catalogService.update(selectedId, validation.data)
        : await catalogService.create(validation.data)
      if (result.status === 'created' || result.status === 'saved') {
        setRetryAction(null)
        setSelectedId(result.item.id)
        setDraftText(JSON.stringify(result.item, null, 2))
        setNotice(result.item.publicationStatus === 'published' ? 'Record published.' : 'Draft saved.')
        await catalog.reload()
      } else {
        setOperationError(result.message)
        setRetryAction(result.status === 'error' ? { type: 'save', mode } : null)
      }
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'The record could not be saved.')
      setRetryAction({ type: 'save', mode })
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!selected || !globalThis.confirm(`Delete “${selected.title}” from this catalogue? This cannot be undone.`)) return
    await performDelete(selected.id)
  }

  const performDelete = async (id: string) => {
    clearMessages()
    setBusy(true)
    try {
      const result = await catalogService.delete(id)
      if (result.status === 'deleted') {
        setRetryAction(null)
        setSelectedId(null)
        setDraftText('')
        setNotice('Catalogue record deleted.')
        await catalog.reload()
      } else {
        setOperationError(result.message)
        setRetryAction(result.status === 'error' ? { type: 'delete', id } : null)
      }
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'The record could not be deleted.')
      setRetryAction({ type: 'delete', id })
    } finally {
      setBusy(false)
    }
  }

  function clearMessages() {
    setFieldErrors([])
    setOperationError('')
    setNotice('')
    setRetryAction(null)
  }

  return (
    <main className="admin-page catalog-studio page-container">
      <Link className="back-link" to="/"><ArrowLeft size={16} /> Back to VOH MOVIES</Link>
      <section className="admin-intro">
        <div className="admin-title-row"><div className="admin-shield"><Film size={20} /></div><p className="eyebrow">VOH / CATALOGUE</p></div>
        <h1>Catalog <em>studio.</em></h1>
        <p className="admin-lede">Create and maintain verified catalog records. JSON is validated against the catalog domain schema before every write.</p>
      </section>

      <div className="admin-notice"><Film size={18} /><p><strong>{storageMode === 'device' ? 'Device-local storage.' : 'Server API mode.'}</strong> {storageMode === 'device' ? 'Records are saved only in this browser and are not shared or synchronized.' : 'Catalog requests use the configured API, which must authenticate and authorize every administrative operation. This interface is not an authentication boundary.'}</p></div>

      <div className="studio-layout" aria-busy={catalog.status === 'loading' || busy}>
        <section className="studio-records" aria-label="Catalog records">
          <div className="studio-list-heading"><h2>Records</h2><span>{records.length}</span></div>
          <div className="studio-create-actions">
            <button className="studio-small-button" onClick={() => startNew('film')} disabled={busy}><Plus size={14} /> New film</button>
            <button className="studio-small-button" onClick={() => startNew('series')} disabled={busy}><Plus size={14} /> New series</button>
          </div>
          {catalog.status === 'loading' ? <p className="studio-state" role="status">Loading catalogue records…</p> : null}
          {catalog.status === 'error' ? <div className="studio-error" role="alert"><p>{catalog.message}</p><button className="catalogue-retry" onClick={() => void catalog.reload()}>Retry catalogue read</button></div> : null}
          {catalog.status === 'ready' && records.length === 0 ? <p className="studio-state">No records yet. Create a draft to start the catalog.</p> : null}
          <div className="studio-record-list">
            {records.map((record) => (
              <button className={record.id === selectedId ? 'studio-record selected' : 'studio-record'} key={record.id} onClick={() => selectRecord(record)}>
                <span><strong>{record.title || 'Untitled draft'}</strong><small>{record.kind === 'film' ? 'Film' : record.kind === 'series' ? 'Series' : 'Collection'} · {record.publicationStatus}</small></span>
                <span className="module-index">{record.releaseYear ?? '—'}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="studio-editor" aria-label="Catalog record editor">
          <div className="studio-editor-heading"><div><p className="eyebrow">{selected ? `RECORD / ${selected.id}` : 'RECORD / NEW'}</p><h2>{selected ? selected.title || 'Untitled draft' : draftText ? 'New record' : 'Select or create a record'}</h2></div>{selected && <span className={selected.publicationStatus === 'published' ? 'publication-badge published' : 'publication-badge'}>{selected.publicationStatus}</span>}</div>
          {notice && <p className="studio-success" role="status"><Check size={15} /> {notice}</p>}
          {draftText ? <>
            <label className="json-field"><span>Catalog record JSON</span><textarea value={draftText} onChange={(event) => { setDraftText(event.target.value); setFieldErrors([]); setOperationError('') }} spellCheck={false} aria-label="Catalog record JSON" /></label>
            {fieldErrors.length > 0 && <div className="field-errors" role="alert"><strong>Correct these fields before saving:</strong><ul>{fieldErrors.map((issue, index) => <li key={`${issue.path}-${index}`}><code>{issue.path}</code>: {issue.message}</li>)}</ul></div>}
            {operationError && <div className="studio-error" role="alert"><p>{operationError}</p>{retryAction && <button className="catalogue-retry" onClick={() => retryAction.type === 'save' ? void save(retryAction.mode) : void confirmDeleteRetry(retryAction.id)}>Retry {retryAction.type}</button>}</div>}
            <div className="studio-save-actions">
              {selected && <button className="studio-delete-button" onClick={() => void remove()} disabled={busy}><Trash2 size={15} /> Delete</button>}
              <span className="studio-action-spacer" />
              <button className="studio-small-button" onClick={() => void save('draft')} disabled={busy}><Save size={15} /> {busy ? 'Saving…' : 'Save draft'}</button>
              <button className="primary-button studio-publish-button" onClick={() => void save(selected?.publicationStatus === 'published' ? 'keep-status' : 'publish')} disabled={busy}><Check size={15} /> {busy ? 'Saving…' : selected?.publicationStatus === 'published' ? 'Save changes' : 'Publish'}</button>
            </div>
          </> : <p className="studio-state editor-placeholder">Choose an existing record or create a film or series draft.</p>}
        </section>
      </div>
      <p className="admin-footnote">Only published records with current streaming rights appear in the viewer catalog. Delete requires confirmation.</p>
    </main>
  )

  function confirmDeleteRetry(id: string) {
    if (!globalThis.confirm('Retry deleting this catalogue record? This cannot be undone.')) return
    void performDelete(id)
  }
}

function createRecordId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `voh-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}