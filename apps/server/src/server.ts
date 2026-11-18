import { createServer } from './index.js';
import { loadServerConfig } from './config.js';
import { openDatabase } from './db/connection.js';
import { SqliteTmdbSearchCache } from './db/tmdb-search-cache.js';
import { MovieMetadataWriter } from './filesystem/metadata-writer.js';
import { OperationExecutor } from './filesystem/operation-executor.js';
import { LibraryWatcher } from './filesystem/library-watcher.js';
import { InboxEventBus } from './inbox-events.js';
import { TmdbClient } from './tmdb-client.js';

async function runServer(): Promise<void> {
  const config = loadServerConfig();
  const accessToken = process.env.TMDB_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error('TMDB_ACCESS_TOKEN must be configured.');
  }

  const database = openDatabase(config.dataDirectory);
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const inboxEvents = new InboxEventBus();
    const tmdb = new TmdbClient({
      accessToken,
      cache: new SqliteTmdbSearchCache(database),
    });
    const operationExecutor = new OperationExecutor(
      database,
      config.libraryRoot,
      config.dataDirectory,
    );
    const metadataWriter = new MovieMetadataWriter(
      database,
      config.libraryRoot,
      tmdb,
      operationExecutor,
    );
    const watcher = new LibraryWatcher({
      database,
      libraryRoot: config.libraryRoot,
      provider: tmdb,
      pollIntervalMs: config.watcherPollIntervalMs,
      stablePolls: config.watcherStablePolls,
      onInboxItemUpdated: (item) => inboxEvents.publish(item),
      onError: (error) => {
        server?.log.error({ err: error }, 'Library watcher error');
      },
    });
    server = createServer({
      database,
      inboxEvents,
      libraryRoot: config.libraryRoot,
      searchProvider: tmdb,
      metadataWriter,
      operationExecutor,
      watcher,
    });
    const address = await server.listen({
      host: config.listenHost,
      port: config.listenPort,
    });
    server.log.info({ address }, 'ReelKeeper server listening');

    let shutdownPromise: Promise<void> | undefined;
    const shutdown = () => {
      if (!shutdownPromise) {
        shutdownPromise = (async () => {
          try {
            await server?.close();
          } finally {
            database.close();
          }
        })();
      }
      void shutdownPromise.catch((error: unknown) => {
        console.error('ReelKeeper shutdown failed:', error);
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    try {
      await server?.close();
    } catch (closeError) {
      database.close();
      throw new AggregateError(
        [error, closeError],
        'Server startup failed and Fastify cleanup also failed.',
        { cause: closeError },
      );
    }
    database.close();
    throw error;
  }
}

void runServer().catch((error: unknown) => {
  console.error('ReelKeeper server failed to start:', error);
  process.exitCode = 1;
});
