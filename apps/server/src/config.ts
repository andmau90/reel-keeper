import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Contains the required runtime paths for the server.
 */
export interface ServerConfig {
  /** NAS-local directory for SQLite, logs, and application data. */
  dataDirectory: string;
  /** Root directory containing loose files and movie folders. */
  libraryRoot: string;
  /** Network interface used by the server listener. */
  listenHost: string;
  /** TCP port used by the server listener. */
  listenPort: number;
  /** Interval between library scans, in milliseconds. */
  watcherPollIntervalMs: number;
  /** Number of unchanged poll intervals required before processing. */
  watcherStablePolls: number;
}

/**
 * Reads required paths and prevents application data from entering the library.
 *
 * @param environment Process environment or a test environment.
 * @returns Normalized server paths.
 * @throws If either path is missing or the data directory is within the library.
 */
export function loadServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const dataDirectory = environment.REELKEEPER_DATA_DIR?.trim();
  const libraryRoot = environment.MOVIE_LIBRARY_ROOT?.trim();

  if (!dataDirectory) {
    throw new Error('REELKEEPER_DATA_DIR must be configured.');
  }
  if (!libraryRoot) {
    throw new Error('MOVIE_LIBRARY_ROOT must be configured.');
  }

  const resolvedDataDirectory = resolve(dataDirectory);
  const resolvedLibraryRoot = resolve(libraryRoot);
  const relativeDataPath = relative(resolvedLibraryRoot, resolvedDataDirectory);
  if (
    relativeDataPath === '' ||
    (!relativeDataPath.startsWith(`..${sep}`) &&
      relativeDataPath !== '..' &&
      !isAbsolute(relativeDataPath))
  ) {
    throw new Error('REELKEEPER_DATA_DIR must be outside MOVIE_LIBRARY_ROOT.');
  }

  const pollIntervalSeconds = readPositiveInteger(
    environment.WATCHER_POLL_INTERVAL_SECONDS,
    5,
    'WATCHER_POLL_INTERVAL_SECONDS',
  );
  const stabilitySeconds = readPositiveInteger(
    environment.WATCHER_STABILITY_SECONDS,
    15,
    'WATCHER_STABILITY_SECONDS',
  );
  const listenHost = environment.REELKEEPER_HOST?.trim() || '127.0.0.1';
  if (/[\\/\s]/.test(listenHost)) {
    throw new Error('REELKEEPER_HOST must be a hostname or IP address.');
  }
  const listenPort = readPositiveInteger(
    environment.REELKEEPER_PORT,
    3000,
    'REELKEEPER_PORT',
  );
  if (listenPort > 65_535) {
    throw new Error('REELKEEPER_PORT must be between 1 and 65535.');
  }
  const watcherPollIntervalMs = pollIntervalSeconds * 1000;
  if (watcherPollIntervalMs > 2_147_483_647) {
    throw new Error('WATCHER_POLL_INTERVAL_SECONDS is too large.');
  }

  return {
    dataDirectory: resolvedDataDirectory,
    libraryRoot: resolvedLibraryRoot,
    listenHost,
    listenPort,
    watcherPollIntervalMs,
    watcherStablePolls: Math.ceil(stabilitySeconds / pollIntervalSeconds),
  };
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive whole number.`);
  }
  return parsed;
}
