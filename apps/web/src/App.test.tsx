// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  ApiHistoryBatch,
  ApiInboxItem,
  ApiLibraryFolder,
  ApiMovieMetadataResponse,
} from '@reelkeeper/shared';
import { App } from './App.js';

const itemId = '54e6accf-93f0-4775-ac6d-2a840c79aa31';
const inboxItem: ApiInboxItem = {
  id: itemId,
  sourcePath: 'Amber Coast (2004)/Amber.Coast.2004.mkv',
  videoPath: 'Amber Coast (2004)/Amber.Coast.2004.mkv',
  status: 'candidates_found',
  parsedTitle: 'Amber Coast',
  parsedYear: 2004,
  candidates: [
    {
      candidate: { id: 33, title: 'Amber Coast', year: 2004 },
      titleScore: 100,
      score: 100,
      yearMatch: 'exact',
    },
  ],
  reviewReason: null,
  errorMessage: null,
  createdAt: '2025-01-01T10:00:00.000Z',
  updatedAt: '2025-01-01T10:00:00.000Z',
  lastSeenAt: '2025-01-01T10:00:00.000Z',
};

const libraryFolder: ApiLibraryFolder = {
  folderPath: 'Amber Coast (2004)',
  videoPaths: [inboxItem.sourcePath],
  companions: [],
  inboxItemId: itemId,
};

const movieMetadata: ApiMovieMetadataResponse = {
  tmdbId: 33,
  lockedFields: [],
  metadata: {
    title: 'Amber Coast',
    originalTitle: 'Amber Coast',
    year: 2004,
    releaseDate: '2004-04-03',
    plot: 'A story.',
    tagline: '',
    runtime: 108,
    genres: ['Drama'],
    studios: ['Studio'],
    directors: ['A Director'],
    actors: [{ name: 'Actor One', character: 'Lead' }],
  },
};

function mockApi(
  rematchResponse: ApiInboxItem = inboxItem,
  historyBatches: ApiHistoryBatch[] = [],
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/inbox') {
        return jsonResponse({ items: [inboxItem] });
      }
      if (url === '/api/library') {
        return jsonResponse({ folders: [libraryFolder] });
      }
      if (url === '/api/history') {
        return jsonResponse({ batches: historyBatches });
      }
      if (
        url === `/api/inbox/${itemId}/metadata` &&
        (!init?.method || init.method === 'GET')
      ) {
        return jsonResponse(movieMetadata);
      }
      if (url === `/api/inbox/${itemId}/metadata` && init?.method === 'PUT') {
        return jsonResponse({
          batchId: '4b104e2c-8e42-4bc2-8d62-45b1aa12d0c8',
          current: {
            ...movieMetadata,
            lockedFields: ['title'],
            metadata: { ...movieMetadata.metadata, title: 'Manual title' },
          },
        });
      }
      if (url.endsWith('/undo') && init?.method === 'POST') {
        return jsonResponse({
          batchId: url.split('/')[3],
          status: 'undone',
        });
      }
      if (url.endsWith('/rematch') && init?.method === 'POST') {
        return jsonResponse(rematchResponse);
      }
      return jsonResponse({ error: 'Not found.' }, 404);
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('App', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.pushState({}, '', '/');
  });

  it('renders the inbox and the recognition candidates', async () => {
    mockApi();
    render(<App />);

    expect(
      screen.getByRole('link', { name: /REELKEEPER/ }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Amber Coast')).toBeInTheDocument();
    expect(screen.getByText('Da verificare')).toBeInTheDocument();
  });

  it('opens a library detail and replaces candidates after rematch', async () => {
    const updatedItem: ApiInboxItem = {
      ...inboxItem,
      status: 'needs_review',
      candidates: [
        {
          candidate: { id: 44, title: 'Another Amber Coast', year: 2004 },
          titleScore: 90,
          score: 90,
          yearMatch: 'exact',
        },
      ],
      updatedAt: '2025-01-02T10:00:00.000Z',
    };
    const fetchMock = mockApi(updatedItem);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Libreria' }));
    expect(
      await screen.findByRole('heading', { name: 'Libreria' }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Apri Amber Coast (2004)' }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Amber Coast' }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: /Riesegui abbinamento/ }),
    );
    expect(await screen.findByText('Another Amber Coast')).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/inbox/${itemId}/rematch`,
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(screen.getByText('Revisione')).toBeInTheDocument();
  });

  it('edits metadata with explicit approval and locks changed fields', async () => {
    const fetchMock = mockApi();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />);

    fireEvent.click(await screen.findByText('Amber Coast'));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Modifica metadati' }),
    );
    const titleInput = await screen.findByRole('textbox', { name: 'Titolo' });
    fireEvent.change(titleInput, { target: { value: 'Manual title' } });
    expect(titleInput).toHaveValue('Manual title');

    fireEvent.click(screen.getByRole('button', { name: 'Salva modifiche' }));
    expect(
      await screen.findByText(
        'Metadati salvati e registrati nella cronologia.',
      ),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/inbox/${itemId}/metadata`,
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          tmdbId: 33,
          metadata: { title: 'Manual title' },
          lockedFields: ['title'],
          approved: true,
        }),
      }),
    );
  });

  it('displays operation history and asks before undoing a batch', async () => {
    const batch: ApiHistoryBatch = {
      id: '4b104e2c-8e42-4bc2-8d62-45b1aa12d0c8',
      status: 'completed',
      createdAt: '2025-01-01T10:00:00.000Z',
      completedAt: '2025-01-01T10:00:01.000Z',
      undoneAt: null,
      errorMessage: null,
      operations: [
        {
          type: 'write_nfo',
          sourcePath: null,
          destinationPath: 'Amber Coast (2004)/Amber Coast.nfo',
          status: 'completed',
        },
      ],
    };
    const fetchMock = mockApi(inboxItem, [batch]);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Cronologia' }));
    expect(await screen.findByText('Scrittura NFO')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Annulla' }));

    expect(confirm).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/history/${batch.id}/undo`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ approved: true }),
        }),
      );
    });
  });
});
