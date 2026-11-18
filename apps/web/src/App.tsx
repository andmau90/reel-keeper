import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  ApiErrorResponseSchema,
  ApiHistoryResponseSchema,
  ApiHistoryUndoResponseSchema,
  ApiInboxItemSchema,
  ApiInboxListResponseSchema,
  ApiLibraryResponseSchema,
  ApiMovieMetadataEditResponseSchema,
  ApiMovieMetadataResponseSchema,
  type ApiInboxItem,
  type ApiHistoryBatch,
  type ApiLibraryFolder,
  type KodiNfoField,
  type MovieMetadataEditValues,
  type MovieMetadataValues,
} from '@reelkeeper/shared';
import './App.css';

type Route =
  | { page: 'inbox' }
  | { page: 'library' }
  | { page: 'history' }
  | { page: 'detail'; id: string; from: 'inbox' | 'library' };

interface ApiParser<T> {
  parse(value: unknown): T;
}

/**
 * Renders ReelKeeper's inbox, library, and movie-detail views.
 *
 * @returns The application workspace.
 */
export function App() {
  const [route, setRoute] = useState<Route>(readRoute);
  const [items, setItems] = useState<ApiInboxItem[]>([]);
  const [folders, setFolders] = useState<ApiLibraryFolder[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRematching, setIsRematching] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedItem = useMemo(
    () =>
      route.page === 'detail'
        ? items.find((item) => item.id === route.id)
        : undefined,
    [items, route],
  );

  useEffect(() => {
    const handlePopState = () => setRoute(readRoute());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([
      requestJson('/api/inbox', ApiInboxListResponseSchema),
      requestJson('/api/library', ApiLibraryResponseSchema),
    ])
      .then(([inbox, library]) => {
        if (!active) {
          return;
        }
        setItems(inbox.items);
        setFolders(library.folders);
        setError(null);
      })
      .catch((requestError: unknown) => {
        if (active) {
          setError(errorMessage(requestError));
        }
      })
      .finally(() => {
        if (active) {
          setIsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      return;
    }

    const events = new EventSource('/api/events');
    events.onopen = () => setIsConnected(true);
    events.onerror = () => setIsConnected(false);
    events.addEventListener('inbox.snapshot', (event) => {
      try {
        const snapshot = ApiInboxListResponseSchema.parse(
          JSON.parse((event as MessageEvent<string>).data),
        );
        setItems(snapshot.items);
        setIsConnected(true);
      } catch (eventError) {
        setError(errorMessage(eventError));
      }
    });
    events.addEventListener('inbox.updated', (event) => {
      try {
        const item = ApiInboxItemSchema.parse(
          JSON.parse((event as MessageEvent<string>).data),
        );
        setItems((current) => upsertItem(current, item));
        setIsConnected(true);
      } catch (eventError) {
        setError(errorMessage(eventError));
      }
    });

    return () => events.close();
  }, []);

  const navigate = (path: string) => {
    window.history.pushState({}, '', path);
    setRoute(readRoute());
    setError(null);
  };

  const refreshLibrary = async () => {
    try {
      const library = await requestJson(
        '/api/library',
        ApiLibraryResponseSchema,
      );
      setFolders(library.folders);
      setError(null);
    } catch (requestError) {
      setError(errorMessage(requestError));
    }
  };

  const rematch = async (item: ApiInboxItem) => {
    setIsRematching(true);
    try {
      const updatedItem = await requestJson(
        `/api/inbox/${encodeURIComponent(item.id)}/rematch`,
        ApiInboxItemSchema,
        { method: 'POST' },
      );
      setItems((current) => upsertItem(current, updatedItem));
      setError(null);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setIsRematching(false);
    }
  };

  const activeSection = route.page === 'detail' ? route.from : route.page;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="/inbox"
          onClick={(event) => {
            event.preventDefault();
            navigate('/inbox');
          }}
        >
          <span className="brand-mark">R</span>
          <span className="brand-name">REELKEEPER</span>
        </a>

        <div className="nav-label">RACCOLTA</div>
        <nav className="primary-nav" aria-label="Navigazione principale">
          <button
            className={
              activeSection === 'inbox' ? 'nav-item active' : 'nav-item'
            }
            onClick={() => navigate('/inbox')}
            type="button"
          >
            <span className="nav-icon" aria-hidden="true">
              ▤
            </span>
            <span>Inbox</span>
            <span className="nav-count">
              {items.filter((item) => item.status !== 'missing').length}
            </span>
          </button>
          <button
            className={
              activeSection === 'library' ? 'nav-item active' : 'nav-item'
            }
            onClick={() => navigate('/library')}
            type="button"
          >
            <span className="nav-icon" aria-hidden="true">
              ▦
            </span>
            <span>Libreria</span>
          </button>
          <button
            className={
              activeSection === 'history' ? 'nav-item active' : 'nav-item'
            }
            onClick={() => navigate('/history')}
            type="button"
          >
            <span className="nav-icon" aria-hidden="true">
              ◷
            </span>
            <span>Cronologia</span>
          </button>
        </nav>

        <div className="sidebar-bottom">
          <div className="connection-indicator">
            <span
              className={isConnected ? 'status-dot online' : 'status-dot'}
            />
            <span>{isConnected ? 'Server connesso' : 'Server in attesa'}</span>
          </div>
          <span className="sidebar-version">REELKEEPER · LOCALE</span>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <span className="breadcrumb">LA TUA COLLEZIONE</span>
          <div className="topbar-status">
            <span
              className={isConnected ? 'status-dot online' : 'status-dot'}
            />
            {isConnected ? 'Sincronizzato' : 'Connessione in attesa'}
          </div>
        </header>

        <div className="page-content">
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button
                aria-label="Chiudi avviso"
                onClick={() => setError(null)}
                type="button"
              >
                ×
              </button>
            </div>
          )}

          {route.page === 'inbox' && (
            <InboxPage
              items={items}
              isLoading={isLoading}
              onOpen={(id) => navigate(`/inbox/${encodeURIComponent(id)}`)}
            />
          )}
          {route.page === 'library' && (
            <LibraryPage
              folders={folders}
              isLoading={isLoading}
              onOpen={(id) =>
                navigate(`/inbox/${encodeURIComponent(id)}?from=library`)
              }
              onRefresh={() => void refreshLibrary()}
            />
          )}
          {route.page === 'detail' && (
            <DetailPage
              item={selectedItem}
              isLoading={isLoading}
              isRematching={isRematching}
              onBack={() =>
                navigate(route.from === 'library' ? '/library' : '/inbox')
              }
              onRematch={() => {
                if (selectedItem) {
                  void rematch(selectedItem);
                }
              }}
            />
          )}
          {route.page === 'history' && <HistoryPage />}
        </div>
      </main>
    </div>
  );
}

function InboxPage({
  items,
  isLoading,
  onOpen,
}: {
  items: ApiInboxItem[];
  isLoading: boolean;
  onOpen: (id: string) => void;
}) {
  const visibleItems = items
    .filter((item) => item.status !== 'missing')
    .slice()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  return (
    <section>
      <PageHeading
        eyebrow="CENTRO OPERATIVO"
        title="Inbox"
        description="I file rilevati vengono analizzati e preparati per la revisione."
      >
        <span className="count-pill">{visibleItems.length} ELEMENTI</span>
      </PageHeading>

      {isLoading ? (
        <LoadingState />
      ) : visibleItems.length === 0 ? (
        <EmptyState
          title="La tua inbox è vuota"
          description="I nuovi film appariranno qui dopo che il file sarà stabile."
        />
      ) : (
        <div className="inbox-list">
          {visibleItems.map((item, index) => (
            <button
              className="inbox-row"
              key={item.id}
              onClick={() => onOpen(item.id)}
              type="button"
            >
              <span className="row-index">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className="file-mark" aria-hidden="true">
                ▶
              </span>
              <span className="inbox-row-main">
                <span className="row-title">
                  {item.parsedTitle ?? item.sourcePath}
                </span>
                <span className="row-subtitle">{item.sourcePath}</span>
              </span>
              <StatusBadge status={item.status} />
              <span className="row-candidates">
                {item.candidates.length > 0
                  ? `${item.candidates.length} candidati`
                  : '—'}
              </span>
              <span className="row-chevron" aria-hidden="true">
                ›
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function LibraryPage({
  folders,
  isLoading,
  onOpen,
  onRefresh,
}: {
  folders: ApiLibraryFolder[];
  isLoading: boolean;
  onOpen: (id: string) => void;
  onRefresh: () => void;
}) {
  return (
    <section>
      <PageHeading
        eyebrow="ARCHIVIO"
        title="Libreria"
        description="Cartelle film già presenti nella directory selezionata."
      >
        <button className="button secondary" onClick={onRefresh} type="button">
          <span aria-hidden="true">↻</span>
          Aggiorna
        </button>
      </PageHeading>

      {isLoading ? (
        <LoadingState />
      ) : folders.length === 0 ? (
        <EmptyState
          title="Nessun film in libreria"
          description="Le cartelle con file video appariranno qui."
        />
      ) : (
        <div className="library-grid">
          {folders.map((folder) => (
            <article className="library-card" key={folder.folderPath}>
              <div className="poster-placeholder">
                <span className="poster-symbol" aria-hidden="true">
                  ◈
                </span>
                <span className="poster-year">
                  {folder.videoPaths.length} VIDEO
                </span>
              </div>
              <div className="library-card-content">
                <span className="card-kicker">CARTELLA FILM</span>
                <h2>{folder.folderPath}</h2>
                <p className="card-file">{folder.videoPaths[0]}</p>
                <div className="card-footer">
                  <span>{folder.companions.length} file associati</span>
                  {folder.inboxItemId !== null ? (
                    <button
                      aria-label={`Apri ${folder.folderPath}`}
                      className="icon-button"
                      onClick={() => {
                        const itemId = folder.inboxItemId;
                        if (itemId) {
                          onOpen(itemId);
                        }
                      }}
                      type="button"
                    >
                      ›
                    </button>
                  ) : (
                    <span className="pending-label">In scansione</span>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function DetailPage({
  item,
  isLoading,
  isRematching,
  onBack,
  onRematch,
}: {
  item: ApiInboxItem | undefined;
  isLoading: boolean;
  isRematching: boolean;
  onBack: () => void;
  onRematch: () => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  if (isLoading) {
    return <LoadingState />;
  }
  if (!item) {
    return (
      <EmptyState
        title="Elemento non trovato"
        description="L'elemento potrebbe essere stato rimosso dalla libreria."
      />
    );
  }

  const canRematch =
    item.videoPath !== null &&
    ['candidates_found', 'needs_review', 'error'].includes(item.status);

  return (
    <section>
      <button className="back-link" onClick={onBack} type="button">
        <span aria-hidden="true">←</span> Torna alla lista
      </button>
      <div className="detail-heading">
        <div>
          <span className="page-eyebrow">DETTAGLIO FILM</span>
          <h1>{item.parsedTitle ?? item.sourcePath}</h1>
          <p className="detail-file">{item.videoPath ?? item.sourcePath}</p>
        </div>
        <div className="detail-actions">
          <StatusBadge status={item.status} />
          <button
            className="button secondary"
            disabled={!item.videoPath}
            onClick={() => setIsEditing((current) => !current)}
            type="button"
          >
            {isEditing ? 'Chiudi editor' : 'Modifica metadati'}
          </button>
          <button
            className="button primary"
            disabled={!canRematch || isRematching}
            onClick={onRematch}
            type="button"
          >
            {isRematching ? 'Ricerca in corso…' : '↻  Riesegui abbinamento'}
          </button>
        </div>
      </div>

      <div className="detail-grid">
        <section className="detail-card">
          <div className="section-title">
            <div>
              <span className="page-eyebrow">RISULTATI TMDB</span>
              <h2>Candidati</h2>
            </div>
            <span className="count-pill">
              {item.candidates.length} RISULTATI
            </span>
          </div>
          {item.candidates.length === 0 ? (
            <p className="muted-copy">
              {item.reviewReason
                ? reviewReasonLabel(item.reviewReason)
                : 'Nessun candidato disponibile. Prova a rieseguire la ricerca.'}
            </p>
          ) : (
            <div className="candidate-list">
              {item.candidates.map((result, index) => (
                <article className="candidate-row" key={result.candidate.id}>
                  <span className="candidate-rank">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div className="candidate-title">
                    <strong>{result.candidate.title}</strong>
                    <span>
                      {result.candidate.originalTitle &&
                      result.candidate.originalTitle !== result.candidate.title
                        ? result.candidate.originalTitle
                        : 'TMDB'}
                      {result.candidate.year
                        ? ` · ${result.candidate.year}`
                        : ''}
                    </span>
                  </div>
                  <div className="score-wrap">
                    <span className="score-value">{result.score}%</span>
                    <span className="score-track">
                      <span style={{ width: `${result.score}%` }} />
                    </span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <aside className="detail-card file-info">
          <span className="page-eyebrow">SORGENTE</span>
          <h2>File rilevato</h2>
          <div className="info-row">
            <span>Percorso</span>
            <strong>{item.sourcePath}</strong>
          </div>
          <div className="info-row">
            <span>Anno rilevato</span>
            <strong>{item.parsedYear ?? 'Non specificato'}</strong>
          </div>
          <div className="info-row">
            <span>Ultimo aggiornamento</span>
            <strong>{formatDate(item.updatedAt)}</strong>
          </div>
          {item.errorMessage && (
            <p className="inline-error">{item.errorMessage}</p>
          )}
          <p className="safety-note">
            L'abbinamento non sposta né rinomina il file.
          </p>
        </aside>
      </div>
      {isEditing && item.videoPath && (
        <MetadataEditor item={item} onCancel={() => setIsEditing(false)} />
      )}
    </section>
  );
}

interface MetadataFormState {
  title: string;
  originalTitle: string;
  year: string;
  releaseDate: string;
  plot: string;
  tagline: string;
  runtime: string;
  genres: string;
  studios: string;
  directors: string;
  actors: string;
}

const FORM_LOCK_FIELDS: Record<keyof MetadataFormState, KodiNfoField> = {
  title: 'title',
  originalTitle: 'originalTitle',
  year: 'year',
  releaseDate: 'releaseDate',
  plot: 'plot',
  tagline: 'tagline',
  runtime: 'runtime',
  genres: 'genres',
  studios: 'studios',
  directors: 'directors',
  actors: 'actors',
};

function metadataToForm(metadata: MovieMetadataValues): MetadataFormState {
  return {
    title: metadata.title,
    originalTitle: metadata.originalTitle,
    year: metadata.year?.toString() ?? '',
    releaseDate: metadata.releaseDate ?? '',
    plot: metadata.plot,
    tagline: metadata.tagline,
    runtime: metadata.runtime?.toString() ?? '',
    genres: metadata.genres.join('\n'),
    studios: metadata.studios.join('\n'),
    directors: metadata.directors.join('\n'),
    actors: metadata.actors
      .map((actor) => `${actor.name} | ${actor.character}`)
      .join('\n'),
  };
}

function buildMetadataEdits(
  form: MetadataFormState,
  current: MovieMetadataValues,
): MovieMetadataEditValues {
  const edits: MovieMetadataEditValues = {};
  if (form.title !== current.title) edits.title = form.title;
  if (form.originalTitle !== current.originalTitle) {
    edits.originalTitle = form.originalTitle;
  }
  const year = parseOptionalInteger(form.year, 'Anno');
  if (year !== current.year) edits.year = year;
  const releaseDate = form.releaseDate.trim() || null;
  if (releaseDate !== current.releaseDate) edits.releaseDate = releaseDate;
  if (form.plot !== current.plot) edits.plot = form.plot;
  if (form.tagline !== current.tagline) edits.tagline = form.tagline;
  const runtime = parseOptionalInteger(form.runtime, 'Durata');
  if (runtime !== current.runtime) {
    if (runtime !== null && runtime <= 0) {
      throw new Error('La durata deve essere un numero positivo.');
    }
    edits.runtime = runtime;
  }

  const genres = parseLines(form.genres);
  if (!sameValues(genres, current.genres)) edits.genres = genres;
  const studios = parseLines(form.studios);
  if (!sameValues(studios, current.studios)) edits.studios = studios;
  const directors = parseLines(form.directors);
  if (!sameValues(directors, current.directors)) edits.directors = directors;
  const actors = parseActors(form.actors);
  if (JSON.stringify(actors) !== JSON.stringify(current.actors)) {
    edits.actors = actors;
  }
  return edits;
}

function parseOptionalInteger(value: string, label: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} deve essere un numero intero.`);
  }
  return parsed;
}

function parseLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseActors(
  value: string,
): Array<{ name: string; character: string }> {
  return parseLines(value).map((line) => {
    const separator = line.indexOf('|');
    return separator < 0
      ? { name: line.trim(), character: '' }
      : {
          name: line.slice(0, separator).trim(),
          character: line.slice(separator + 1).trim(),
        };
  });
}

function sameValues(left: string[], right: string[]): boolean {
  return (
    left.length === right.length && left.every((value, i) => value === right[i])
  );
}

const METADATA_FIELD_LABELS: Array<{ field: KodiNfoField; label: string }> = [
  { field: 'title', label: 'Titolo' },
  { field: 'originalTitle', label: 'Titolo originale' },
  { field: 'year', label: 'Anno' },
  { field: 'releaseDate', label: 'Data di uscita' },
  { field: 'plot', label: 'Trama' },
  { field: 'tagline', label: 'Tagline' },
  { field: 'runtime', label: 'Durata' },
  { field: 'genres', label: 'Generi' },
  { field: 'studios', label: 'Studi' },
  { field: 'directors', label: 'Registi' },
  { field: 'actors', label: 'Cast' },
  { field: 'rating', label: 'Valutazione TMDB' },
];

function MetadataEditor({
  item,
  onCancel,
}: {
  item: ApiInboxItem;
  onCancel: () => void;
}) {
  const [current, setCurrent] = useState<MovieMetadataValues | null>(null);
  const [form, setForm] = useState<MetadataFormState | null>(null);
  const [lockedFields, setLockedFields] = useState<KodiNfoField[]>([]);
  const [tmdbId, setTmdbId] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    requestJson(
      `/api/inbox/${encodeURIComponent(item.id)}/metadata`,
      ApiMovieMetadataResponseSchema,
    )
      .then((response) => {
        if (!active) {
          return;
        }
        setCurrent(response.metadata);
        setForm(metadataToForm(response.metadata));
        setLockedFields(response.lockedFields);
        setTmdbId(
          item.candidates.find(
            (candidate) => candidate.candidate.id === response.tmdbId,
          )?.candidate.id ??
            item.candidates[0]?.candidate.id ??
            null,
        );
      })
      .catch((requestError: unknown) => {
        if (active) {
          setError(errorMessage(requestError));
        }
      })
      .finally(() => {
        if (active) {
          setIsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [item]);

  const changeField = (field: keyof MetadataFormState, value: string) => {
    setForm((currentForm) =>
      currentForm ? { ...currentForm, [field]: value } : currentForm,
    );
    const lockField = FORM_LOCK_FIELDS[field];
    setLockedFields((currentFields) =>
      currentFields.includes(lockField)
        ? currentFields
        : [...currentFields, lockField],
    );
    setSaved(false);
  };

  const toggleLock = (field: KodiNfoField, checked: boolean) => {
    setLockedFields((currentFields) =>
      checked
        ? [...new Set([...currentFields, field])]
        : currentFields.filter((currentField) => currentField !== field),
    );
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!current || !form || tmdbId === null) {
      return;
    }
    if (
      !window.confirm(
        'Applico i metadati al file NFO? Questa modifica crea una voce annullabile nella cronologia.',
      )
    ) {
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      const metadata = buildMetadataEdits(form, current);
      const response = await requestJson(
        `/api/inbox/${encodeURIComponent(item.id)}/metadata`,
        ApiMovieMetadataEditResponseSchema,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tmdbId,
            metadata,
            lockedFields,
            approved: true,
          }),
        },
      );
      setCurrent(response.current.metadata);
      setForm(metadataToForm(response.current.metadata));
      setLockedFields(response.current.lockedFields);
      setSaved(true);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return <LoadingState />;
  }
  if (!form || !current) {
    return (
      <div className="editor-card" role="alert">
        <p>{error ?? 'Impossibile caricare i metadati.'}</p>
        <button className="button secondary" onClick={onCancel} type="button">
          Chiudi
        </button>
      </div>
    );
  }

  const canSave = tmdbId !== null && !isSaving;
  return (
    <form className="editor-card" onSubmit={(event) => void save(event)}>
      <div className="section-title">
        <div>
          <span className="page-eyebrow">MODIFICA MANUALE</span>
          <h2>Metadati Kodi</h2>
        </div>
        <span className="muted-copy">
          I campi bloccati non verranno sovrascritti dai futuri aggiornamenti.
        </span>
      </div>

      <label className="form-field">
        <span>Abbinamento TMDB</span>
        <select
          value={tmdbId ?? ''}
          onChange={(event) =>
            setTmdbId(event.target.value ? Number(event.target.value) : null)
          }
        >
          <option value="">Seleziona un candidato</option>
          {item.candidates.map(({ candidate }) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.title}
              {candidate.year ? ` (${candidate.year})` : ''}
            </option>
          ))}
        </select>
      </label>

      <div className="metadata-fields">
        <MetadataInput
          label="Titolo"
          field="title"
          value={form.title}
          onChange={changeField}
        />
        <MetadataInput
          label="Titolo originale"
          field="originalTitle"
          value={form.originalTitle}
          onChange={changeField}
        />
        <MetadataInput
          label="Anno"
          field="year"
          value={form.year}
          onChange={changeField}
        />
        <MetadataInput
          label="Data di uscita"
          field="releaseDate"
          value={form.releaseDate}
          onChange={changeField}
        />
        <MetadataInput
          label="Durata (minuti)"
          field="runtime"
          value={form.runtime}
          onChange={changeField}
        />
        <MetadataInput
          label="Tagline"
          field="tagline"
          value={form.tagline}
          onChange={changeField}
        />
        <MetadataInput
          label="Trama"
          field="plot"
          value={form.plot}
          onChange={changeField}
          multiline
        />
        <MetadataInput
          label="Generi (uno per riga)"
          field="genres"
          value={form.genres}
          onChange={changeField}
          multiline
        />
        <MetadataInput
          label="Studi (uno per riga)"
          field="studios"
          value={form.studios}
          onChange={changeField}
          multiline
        />
        <MetadataInput
          label="Registi (uno per riga)"
          field="directors"
          value={form.directors}
          onChange={changeField}
          multiline
        />
        <MetadataInput
          label="Cast (Nome | Personaggio, uno per riga)"
          field="actors"
          value={form.actors}
          onChange={changeField}
          multiline
        />
      </div>

      <fieldset className="lock-fieldset">
        <legend>Blocca campi per i prossimi aggiornamenti</legend>
        <div className="lock-options">
          {METADATA_FIELD_LABELS.map(({ field, label }) => (
            <label key={field}>
              <input
                checked={lockedFields.includes(field)}
                onChange={(event) => toggleLock(field, event.target.checked)}
                type="checkbox"
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {saved && (
        <p className="save-notice" role="status">
          Metadati salvati e registrati nella cronologia.
        </p>
      )}
      <div className="editor-actions">
        <button className="button secondary" onClick={onCancel} type="button">
          Chiudi
        </button>
        <button className="button primary" disabled={!canSave} type="submit">
          {isSaving ? 'Salvataggio…' : 'Salva modifiche'}
        </button>
      </div>
    </form>
  );
}

function MetadataInput({
  label,
  field,
  value,
  onChange,
  multiline = false,
}: {
  label: string;
  field: keyof MetadataFormState;
  value: string;
  onChange: (field: keyof MetadataFormState, value: string) => void;
  multiline?: boolean;
}) {
  return (
    <label className={`form-field${multiline ? ' full-width' : ''}`}>
      <span>{label}</span>
      {multiline ? (
        <textarea
          onChange={(event) => onChange(field, event.target.value)}
          rows={field === 'plot' ? 4 : 3}
          value={value}
        />
      ) : (
        <input
          onChange={(event) => onChange(field, event.target.value)}
          type="text"
          value={value}
        />
      )}
    </label>
  );
}

function HistoryPage() {
  const [batches, setBatches] = useState<ApiHistoryBatch[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [undoingId, setUndoingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const history = await requestJson(
        '/api/history',
        ApiHistoryResponseSchema,
      );
      setBatches(history.batches);
      setError(null);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const undo = async (batch: ApiHistoryBatch) => {
    if (
      !window.confirm(
        "Annullare questa operazione? I file modificati dopo l'operazione non verranno sovrascritti.",
      )
    ) {
      return;
    }
    setUndoingId(batch.id);
    try {
      await requestJson(
        `/api/history/${encodeURIComponent(batch.id)}/undo`,
        ApiHistoryUndoResponseSchema,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approved: true }),
        },
      );
      await refresh();
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setUndoingId(null);
    }
  };

  return (
    <section>
      <PageHeading
        eyebrow="ATTIVITÀ"
        title="Cronologia"
        description="Modifiche ai file registrate da ReelKeeper, con annullamento protetto."
      >
        <button
          className="button secondary"
          onClick={() => void refresh()}
          type="button"
        >
          Aggiorna
        </button>
      </PageHeading>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {isLoading ? (
        <LoadingState />
      ) : batches.length === 0 ? (
        <EmptyState
          title="Nessuna operazione registrata"
          description="Le modifiche approvate ai file appariranno qui."
        />
      ) : (
        <div className="history-list">
          {batches.map((batch) => (
            <article className="history-card" key={batch.id}>
              <div className="history-card-heading">
                <div>
                  <span className="page-eyebrow">
                    {historyStatus(batch.status)}
                  </span>
                  <h2>{formatDate(batch.createdAt)}</h2>
                </div>
                <button
                  className="button secondary"
                  disabled={
                    undoingId === batch.id ||
                    (batch.status !== 'completed' &&
                      batch.status !== 'partial_undo')
                  }
                  onClick={() => void undo(batch)}
                  type="button"
                >
                  {undoingId === batch.id ? 'Annullamento…' : 'Annulla'}
                </button>
              </div>
              <ul>
                {batch.operations.map((operation, index) => (
                  <li
                    key={`${operation.type}-${operation.destinationPath}-${index}`}
                  >
                    <strong>{operationLabel(operation.type)}</strong>
                    <span>
                      {operation.sourcePath ? `${operation.sourcePath} → ` : ''}
                      {operation.destinationPath}
                    </span>
                  </li>
                ))}
              </ul>
              {batch.errorMessage && (
                <p className="inline-error">{batch.errorMessage}</p>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function PageHeading({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <span className="page-eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children && <div className="page-heading-action">{children}</div>}
    </div>
  );
}

function StatusBadge({ status }: { status: ApiInboxItem['status'] }) {
  return (
    <span className={`status-badge status-${status}`}>
      <span className="status-dot" />
      {statusLabel(status)}
    </span>
  );
}

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="empty-state">
      <div className="empty-mark" aria-hidden="true">
        ◈
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="loading-state" role="status">
      <span className="loading-spinner" />
      Caricamento…
    </div>
  );
}

async function requestJson<T>(
  url: string,
  schema: ApiParser<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...init?.headers,
    },
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = ApiErrorResponseSchema.safeParse(body);
    throw new Error(
      error.success
        ? error.data.error
        : `Richiesta non riuscita (${response.status}).`,
    );
  }
  return schema.parse(body);
}

function readRoute(): Route {
  const segments = window.location.pathname
    .split('/')
    .filter(Boolean)
    .map(decodeURIComponent);
  if (segments[0] === 'history') {
    return { page: 'history' };
  }
  if (segments[0] === 'library') {
    return { page: 'library' };
  }
  if (segments[0] === 'inbox' && segments[1]) {
    const from = new URLSearchParams(window.location.search).get('from');
    return {
      page: 'detail',
      id: segments[1],
      from: from === 'library' ? 'library' : 'inbox',
    };
  }
  return { page: 'inbox' };
}

function upsertItem(items: ApiInboxItem[], item: ApiInboxItem): ApiInboxItem[] {
  const index = items.findIndex((current) => current.id === item.id);
  if (index < 0) {
    return [item, ...items];
  }
  return items.map((current) => (current.id === item.id ? item : current));
}

function statusLabel(status: ApiInboxItem['status']): string {
  const labels: Record<ApiInboxItem['status'], string> = {
    observing: 'In osservazione',
    queued: 'In coda',
    processing: 'Analisi',
    candidates_found: 'Da verificare',
    needs_review: 'Revisione',
    error: 'Errore',
    missing: 'Non trovato',
  };
  return labels[status];
}

function reviewReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    ambiguous_year: "L'anno nel nome del file è ambiguo.",
    missing_year: "L'anno non è presente nel nome del file.",
    multiple_videos: 'La cartella contiene più video e richiede una selezione.',
    no_candidates: 'TMDB non ha restituito risultati.',
    unparseable_filename: 'Il nome del file non è stato riconosciuto.',
  };
  return labels[reason] ?? 'Questo elemento richiede una verifica manuale.';
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('it-IT', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function historyStatus(status: ApiHistoryBatch['status']): string {
  const labels: Record<ApiHistoryBatch['status'], string> = {
    pending: 'In attesa',
    completed: 'Completata',
    failed: 'Errore',
    partial_failure: 'Completata parzialmente',
    undoing: 'Annullamento in corso',
    partial_undo: 'Annullata parzialmente',
    undone: 'Annullata',
  };
  return labels[status];
}

function operationLabel(
  type: ApiHistoryBatch['operations'][number]['type'],
): string {
  const labels: Record<typeof type, string> = {
    mkdir: 'Creazione cartella',
    move: 'Spostamento',
    rename: 'Rinomina',
    write_nfo: 'Scrittura NFO',
    write_image: 'Scrittura immagine',
  };
  return labels[type];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
