import Fastify from 'fastify';
import {
  ApiErrorResponseSchema,
  ApiHealthResponseSchema,
  ApiHistoryResponseSchema,
  ApiHistoryUndoRequestSchema,
  ApiHistoryUndoResponseSchema,
  ApiInboxItemSchema,
  ApiInboxListResponseSchema,
  ApiLibraryResponseSchema,
  ApiMovieMetadataEditRequestSchema,
  ApiMovieMetadataEditResponseSchema,
  ApiMovieMetadataResponseSchema,
} from '@reelkeeper/shared';
import type { SqliteDatabase } from './db/connection.js';
import type { InboxEventBus } from './inbox-events.js';
import {
  getInboxItem,
  InboxRematchError,
  listInboxItems,
  rematchInboxItem,
} from './filesystem/library-watcher.js';
import type {
  InboxItem,
  LibraryWatcher,
} from './filesystem/library-watcher.js';
import { scanLibrary } from './filesystem/library-scanner.js';
import type { MovieSearchProvider } from './recognizer.js';
import type { MovieMetadataWriter } from './filesystem/metadata-writer.js';
import type { OperationExecutor } from './filesystem/operation-executor.js';

/**
 * Dependencies used by the API and its server lifecycle.
 */
export interface ServerOptions {
  /** SQLite database containing persistent inbox items. */
  database?: SqliteDatabase;
  /** Event bus used to stream watcher updates to browser clients. */
  inboxEvents?: InboxEventBus;
  /** Optional watcher started and stopped with the Fastify server. */
  watcher?: Pick<LibraryWatcher, 'start' | 'stop'>;
  /** Root scanned by the Library page and rematch operation. */
  libraryRoot?: string;
  /** Provider used when the user explicitly rematches an inbox item. */
  searchProvider?: MovieSearchProvider;
  /** Approval-gated writer used by the manual metadata editor. */
  metadataWriter?: Pick<MovieMetadataWriter, 'read' | 'edit'>;
  /** Reversible operation log used by history and undo endpoints. */
  operationExecutor?: Pick<OperationExecutor, 'listHistory' | 'undoBatch'>;
}

/**
 * Creates the Fastify application without starting a network listener.
 *
 * @param options Database, event bus, and optional watcher dependencies.
 * @returns A configured Fastify instance.
 */
export function createServer(options: ServerOptions = {}) {
  const server = Fastify({ logger: true });

  server.get('/api/health', async () =>
    ApiHealthResponseSchema.parse({ status: 'ok' }),
  );

  server.get('/api/inbox', async (_request, reply) => {
    if (!options.database) {
      return reply.code(503).send(
        ApiErrorResponseSchema.parse({
          error: 'Inbox database is not configured.',
        }),
      );
    }

    return ApiInboxListResponseSchema.parse({
      items: listInboxItems(options.database).map(toApiInboxItem),
    });
  });

  server.get<{ Params: { id: string } }>(
    '/api/inbox/:id',
    async (request, reply) => {
      if (!options.database) {
        return reply.code(503).send(
          ApiErrorResponseSchema.parse({
            error: 'Inbox database is not configured.',
          }),
        );
      }

      const item = getInboxItem(options.database, request.params.id);
      if (!item) {
        return reply
          .code(404)
          .send(
            ApiErrorResponseSchema.parse({ error: 'Inbox item not found.' }),
          );
      }
      return ApiInboxItemSchema.parse(toApiInboxItem(item));
    },
  );

  server.get<{ Params: { id: string } }>(
    '/api/inbox/:id/metadata',
    async (request, reply) => {
      if (!options.database || !options.metadataWriter) {
        return reply.code(503).send(
          ApiErrorResponseSchema.parse({
            error: 'Manual metadata editing is not configured.',
          }),
        );
      }

      const item = getInboxItem(options.database, request.params.id);
      if (!item) {
        return reply
          .code(404)
          .send(
            ApiErrorResponseSchema.parse({ error: 'Inbox item not found.' }),
          );
      }
      if (!item.videoPath) {
        return reply.code(409).send(
          ApiErrorResponseSchema.parse({
            error: 'This inbox item has no single movie video to edit.',
          }),
        );
      }

      const current = await options.metadataWriter.read(item.videoPath);
      return ApiMovieMetadataResponseSchema.parse(current);
    },
  );

  server.put<{ Params: { id: string }; Body: unknown }>(
    '/api/inbox/:id/metadata',
    async (request, reply) => {
      if (!options.database || !options.metadataWriter) {
        return reply.code(503).send(
          ApiErrorResponseSchema.parse({
            error: 'Manual metadata editing is not configured.',
          }),
        );
      }

      const parsed = ApiMovieMetadataEditRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(
          ApiErrorResponseSchema.parse({
            error: 'A valid metadata edit and explicit approval are required.',
          }),
        );
      }

      const item = getInboxItem(options.database, request.params.id);
      if (!item) {
        return reply
          .code(404)
          .send(
            ApiErrorResponseSchema.parse({ error: 'Inbox item not found.' }),
          );
      }
      if (!item.videoPath) {
        return reply.code(409).send(
          ApiErrorResponseSchema.parse({
            error: 'This inbox item has no single movie video to edit.',
          }),
        );
      }
      if (
        !item.candidates.some(
          (candidate) => candidate.candidate.id === parsed.data.tmdbId,
        )
      ) {
        return reply.code(400).send(
          ApiErrorResponseSchema.parse({
            error: 'The TMDB match must be one of this item’s candidates.',
          }),
        );
      }

      const result = await options.metadataWriter.edit(
        {
          tmdbId: parsed.data.tmdbId,
          videoPath: item.videoPath,
          metadata: parsed.data.metadata,
          lockedFields: parsed.data.lockedFields,
        },
        parsed.data.approved,
      );
      return ApiMovieMetadataEditResponseSchema.parse({
        batchId: result.batch.batchId,
        current: result.current,
      });
    },
  );

  server.get('/api/library', async (_request, reply) => {
    if (!options.database || !options.libraryRoot) {
      return reply.code(503).send(
        ApiErrorResponseSchema.parse({
          error: 'Library scan is not configured.',
        }),
      );
    }

    const scan = await scanLibrary(options.libraryRoot);
    const folders = scan.entries
      .filter((entry) => entry.kind === 'existing_folder')
      .map((entry) => {
        const sourcePath =
          entry.videoPaths.length === 1
            ? (entry.videoPaths[0] ?? entry.folderPath)
            : entry.folderPath;
        const inboxItem = options.database
          ?.prepare<[string], { id: string }>(
            'SELECT id FROM inbox_items WHERE source_path = ?',
          )
          .get(sourcePath);
        return {
          folderPath: entry.folderPath,
          videoPaths: entry.videoPaths,
          companions: entry.companions,
          inboxItemId: inboxItem?.id ?? null,
        };
      });

    return ApiLibraryResponseSchema.parse({ folders });
  });

  server.post<{ Params: { id: string } }>(
    '/api/inbox/:id/rematch',
    async (request, reply) => {
      if (
        !options.database ||
        !options.libraryRoot ||
        !options.searchProvider
      ) {
        return reply.code(503).send(
          ApiErrorResponseSchema.parse({
            error: 'Inbox rematching is not configured.',
          }),
        );
      }

      try {
        const item = await rematchInboxItem(
          options.database,
          options.libraryRoot,
          request.params.id,
          options.searchProvider,
        );
        options.inboxEvents?.publish(item);
        return ApiInboxItemSchema.parse(toApiInboxItem(item));
      } catch (error) {
        if (error instanceof InboxRematchError) {
          return reply
            .code(error.statusCode)
            .send(ApiErrorResponseSchema.parse({ error: error.message }));
        }
        throw error;
      }
    },
  );

  server.get('/api/history', async (_request, reply) => {
    if (!options.operationExecutor) {
      return reply.code(503).send(
        ApiErrorResponseSchema.parse({
          error: 'Operation history is not configured.',
        }),
      );
    }

    return ApiHistoryResponseSchema.parse({
      batches: options.operationExecutor.listHistory(),
    });
  });

  server.post<{ Params: { id: string }; Body: unknown }>(
    '/api/history/:id/undo',
    async (request, reply) => {
      if (!options.operationExecutor) {
        return reply.code(503).send(
          ApiErrorResponseSchema.parse({
            error: 'Operation history is not configured.',
          }),
        );
      }
      if (!ApiHistoryUndoRequestSchema.safeParse(request.body).success) {
        return reply.code(400).send(
          ApiErrorResponseSchema.parse({
            error: 'Explicit approval is required before undoing operations.',
          }),
        );
      }

      const history = options.operationExecutor.listHistory();
      const batch = history.find((entry) => entry.id === request.params.id);
      if (!batch) {
        return reply.code(404).send(
          ApiErrorResponseSchema.parse({
            error: 'Operation batch was not found.',
          }),
        );
      }
      if (batch.status !== 'completed' && batch.status !== 'partial_undo') {
        return reply.code(409).send(
          ApiErrorResponseSchema.parse({
            error: `Operation batch cannot be undone from ${batch.status}.`,
          }),
        );
      }

      const result = await options.operationExecutor.undoBatch(batch.id);
      return ApiHistoryUndoResponseSchema.parse(result);
    },
  );

  server.get('/api/events', (request, reply) => {
    if (!options.database || !options.inboxEvents) {
      return reply.code(503).send(
        ApiErrorResponseSchema.parse({
          error: 'Inbox event stream is not configured.',
        }),
      );
    }

    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, data: unknown) => {
      if (!response.destroyed) {
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };
    const unsubscribe = options.inboxEvents.subscribe((item) => {
      send('inbox.updated', toApiInboxItem(item));
    });
    const heartbeat = setInterval(() => {
      if (!response.destroyed) {
        response.write(': heartbeat\n\n');
      }
    }, 15_000);
    let closed = false;
    const cleanup = () => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      request.raw.off('close', cleanup);
      response.off('close', cleanup);
    };
    request.raw.on('close', cleanup);
    response.on('close', cleanup);

    send(
      'inbox.snapshot',
      ApiInboxListResponseSchema.parse({
        items: listInboxItems(options.database).map(toApiInboxItem),
      }),
    );
    return reply;
  });

  if (options.watcher) {
    server.addHook('onReady', async () => {
      await options.watcher?.start();
    });
    server.addHook('onClose', async () => {
      await options.watcher?.stop();
    });
  }

  return server;
}

function toApiInboxItem(item: InboxItem) {
  return ApiInboxItemSchema.parse({
    id: item.id,
    sourcePath: item.sourcePath,
    videoPath: item.videoPath,
    status: item.status,
    parsedTitle: item.parsedTitle,
    parsedYear: item.parsedYear,
    candidates: item.candidates,
    reviewReason: item.reviewReason,
    errorMessage: item.errorMessage,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    lastSeenAt: item.lastSeenAt,
  });
}
