import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiInboxItem } from '@reelkeeper/shared';
import { openDatabase } from './db/connection.js';
import type { InboxItem } from './filesystem/library-watcher.js';
import type { CurrentMovieMetadata } from './filesystem/metadata-writer.js';
import { InboxEventBus } from './inbox-events.js';
import { createServer } from './index.js';

describe('server health endpoint', () => {
  it('returns the shared health response', async () => {
    const server = createServer();

    try {
      const response = await server.inject({
        method: 'GET',
        url: '/api/health',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
    } finally {
      await server.close();
    }
  });

  it('starts and stops the watcher with the server lifecycle', async () => {
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const server = createServer({ watcher: { start, stop } });

    await server.ready();
    expect(start).toHaveBeenCalledOnce();
    await server.close();
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe('inbox API and SSE', () => {
  it('lists and retrieves persisted inbox items', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'reelkeeper-api-'));
    const database = openDatabase(temporaryDirectory);
    const item = insertInboxItem(database);
    const server = createServer({ database });

    try {
      const list = await server.inject({ method: 'GET', url: '/api/inbox' });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toMatchObject({
        items: [{ id: item.id, sourcePath: item.sourcePath }],
      });

      const detail = await server.inject({
        method: 'GET',
        url: `/api/inbox/${item.id}`,
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject(item);

      const missing = await server.inject({
        method: 'GET',
        url: '/api/inbox/00000000-0000-4000-8000-000000000000',
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: 'Inbox item not found.' });
    } finally {
      await server.close();
      database.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('lists scanned movie folders and replaces candidates on rematch', async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), 'reelkeeper-library-api-'),
    );
    const dataDirectory = join(temporaryDirectory, 'data');
    const libraryRoot = join(temporaryDirectory, 'movies');
    const folderPath = 'Amber Coast (2004)';
    const videoPath = `${folderPath}/Amber.Coast.2004.mkv`;
    const videoAbsolutePath = join(
      libraryRoot,
      folderPath,
      'Amber.Coast.2004.mkv',
    );
    await mkdir(join(libraryRoot, folderPath), { recursive: true });
    await writeFile(videoAbsolutePath, 'video bytes');
    const info = await lstat(videoAbsolutePath);
    const signature = JSON.stringify([
      { path: videoPath, size: info.size, mtimeMs: info.mtimeMs },
    ]);
    const database = openDatabase(dataDirectory);
    const item = insertInboxItem(database, videoPath, signature);
    const server = createServer({
      database,
      libraryRoot,
      searchProvider: {
        async searchMovies(query, year) {
          return [{ id: 2, title: query, year }];
        },
      },
    });

    try {
      const library = await server.inject({
        method: 'GET',
        url: '/api/library',
      });
      expect(library.statusCode).toBe(200);
      expect(library.json()).toMatchObject({
        folders: [
          {
            folderPath,
            videoPaths: [videoPath],
            inboxItemId: item.id,
          },
        ],
      });

      const rematch = await server.inject({
        method: 'POST',
        url: `/api/inbox/${item.id}/rematch`,
      });
      expect(rematch.statusCode).toBe(200);
      expect(rematch.json()).toMatchObject({
        id: item.id,
        status: 'candidates_found',
        candidates: [{ candidate: { id: 2 }, score: 100 }],
      });
    } finally {
      await server.close();
      database.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('reads and edits manual metadata only for an item candidate with approval', async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), 'reelkeeper-metadata-api-'),
    );
    const database = openDatabase(temporaryDirectory);
    const item = insertInboxItem(database);
    const metadata: CurrentMovieMetadata = {
      tmdbId: 1,
      lockedFields: ['title'],
      metadata: {
        title: 'Amber Coast',
        originalTitle: 'Amber Coast',
        year: 2004,
        releaseDate: null,
        plot: '',
        tagline: '',
        runtime: null,
        genres: [],
        studios: [],
        directors: [],
        actors: [],
      },
    };
    const edit = vi.fn(async () => ({
      batch: {
        batchId: '4b104e2c-8e42-4bc2-8d62-45b1aa12d0c8',
        status: 'completed' as const,
        operations: [],
      },
      current: metadata,
    }));
    const server = createServer({
      database,
      metadataWriter: {
        async read() {
          return metadata;
        },
        edit,
      },
    });

    try {
      const current = await server.inject({
        method: 'GET',
        url: `/api/inbox/${item.id}/metadata`,
      });
      expect(current.statusCode).toBe(200);
      expect(current.json()).toMatchObject(metadata);

      const unapproved = await server.inject({
        method: 'PUT',
        url: `/api/inbox/${item.id}/metadata`,
        payload: {
          tmdbId: 1,
          metadata: { title: 'Manual title' },
          lockedFields: ['title'],
          approved: false,
        },
      });
      expect(unapproved.statusCode).toBe(400);

      const invalidCandidate = await server.inject({
        method: 'PUT',
        url: `/api/inbox/${item.id}/metadata`,
        payload: {
          tmdbId: 2,
          metadata: { title: 'Manual title' },
          lockedFields: ['title'],
          approved: true,
        },
      });
      expect(invalidCandidate.statusCode).toBe(400);
      expect(edit).not.toHaveBeenCalled();

      const updated = await server.inject({
        method: 'PUT',
        url: `/api/inbox/${item.id}/metadata`,
        payload: {
          tmdbId: 1,
          metadata: { title: 'Manual title' },
          lockedFields: ['title'],
          approved: true,
        },
      });
      expect(updated.statusCode).toBe(200);
      expect(edit).toHaveBeenCalledWith(
        {
          tmdbId: 1,
          videoPath: item.videoPath,
          metadata: { title: 'Manual title' },
          lockedFields: ['title'],
        },
        true,
      );
    } finally {
      await server.close();
      database.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('lists operation history and requires approval before undo', async () => {
    const batch = {
      id: '4b104e2c-8e42-4bc2-8d62-45b1aa12d0c8',
      status: 'completed' as const,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      undoneAt: null,
      errorMessage: null,
      operations: [
        {
          type: 'write_nfo' as const,
          sourcePath: null,
          destinationPath: 'Amber Coast (2004)/Amber Coast.nfo',
          status: 'completed' as const,
        },
      ],
    };
    const undoBatch = vi.fn(async (batchId: string) => ({
      batchId,
      status: 'undone' as const,
    }));
    const server = createServer({
      operationExecutor: {
        listHistory: () => [batch],
        undoBatch,
      },
    });
    try {
      const history = await server.inject({
        method: 'GET',
        url: '/api/history',
      });
      expect(history.statusCode).toBe(200);
      expect(history.json()).toEqual({ batches: [batch] });

      const unapproved = await server.inject({
        method: 'POST',
        url: `/api/history/${batch.id}/undo`,
        payload: { approved: false },
      });
      expect(unapproved.statusCode).toBe(400);

      const undone = await server.inject({
        method: 'POST',
        url: `/api/history/${batch.id}/undo`,
        payload: { approved: true },
      });
      expect(undone.statusCode).toBe(200);
      expect(undone.json()).toEqual({ batchId: batch.id, status: 'undone' });
      expect(undoBatch).toHaveBeenCalledWith(batch.id);
    } finally {
      await server.close();
    }
  });

  it('streams a snapshot and full item updates over SSE', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'reelkeeper-sse-'));
    const database = openDatabase(temporaryDirectory);
    const item = insertInboxItem(database);
    const inboxEvents = new InboxEventBus();
    const server = createServer({ database, inboxEvents });
    const abortController = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      const address = await server.listen({
        host: '127.0.0.1',
        port: 0,
      });
      const response = await fetch(`${address}/api/events`, {
        signal: abortController.signal,
      });
      expect(response.status).toBe(200);
      reader = response.body?.getReader();
      expect(reader).toBeDefined();
      const decoder = new TextDecoder();
      const snapshot = await reader?.read();
      expect(decoder.decode(snapshot?.value)).toContain(
        'event: inbox.snapshot',
      );

      inboxEvents.publish({
        ...item,
        fileSignature: '{}',
        stableIntervals: 3,
        status: 'needs_review',
        reviewReason: 'missing_year',
        updatedAt: new Date().toISOString(),
      } satisfies InboxItem);
      const update = await reader?.read();
      expect(decoder.decode(update?.value)).toContain('event: inbox.updated');
      expect(decoder.decode(update?.value)).toContain(item.id);
    } finally {
      abortController.abort();
      await reader?.cancel().catch(() => undefined);
      await server.close();
      database.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('returns an explicit unavailable response without API dependencies', async () => {
    const server = createServer();
    try {
      const response = await server.inject({
        method: 'GET',
        url: '/api/inbox',
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: 'Inbox database is not configured.',
      });
    } finally {
      await server.close();
    }
  });
});

function insertInboxItem(
  database: ReturnType<typeof openDatabase>,
  sourcePath = 'Amber.Coast.2004.mkv',
  fileSignature = '{}',
): ApiInboxItem {
  const item: ApiInboxItem = {
    id: '54e6accf-93f0-4775-ac6d-2a840c79aa31',
    sourcePath,
    videoPath: sourcePath,
    status: 'candidates_found',
    parsedTitle: 'Amber Coast',
    parsedYear: 2004,
    candidates: [
      {
        candidate: { id: 1, title: 'Amber Coast', year: 2004 },
        titleScore: 100,
        score: 100,
        yearMatch: 'exact',
      },
    ],
    reviewReason: null,
    errorMessage: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };
  database
    .prepare(
      `INSERT INTO inbox_items (
         id, source_path, video_path, file_signature, stable_intervals,
         last_sampled_at, status, parsed_title, parsed_year, candidates,
         created_at, updated_at, last_seen_at
       ) VALUES (?, ?, ?, ?, 3, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      item.id,
      item.sourcePath,
      item.videoPath,
      fileSignature,
      Date.now(),
      item.status,
      item.parsedTitle,
      item.parsedYear,
      JSON.stringify(item.candidates),
      item.createdAt,
      item.updatedAt,
      item.lastSeenAt,
    );
  return item;
}
