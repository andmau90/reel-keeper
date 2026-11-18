import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadServerConfig } from './config.js';

describe('loadServerConfig', () => {
  it('requires both the data directory and movie-library root', () => {
    expect(() => loadServerConfig({})).toThrow('REELKEEPER_DATA_DIR');
    expect(() =>
      loadServerConfig({ REELKEEPER_DATA_DIR: '/volume1/appdata/reelkeeper' }),
    ).toThrow('MOVIE_LIBRARY_ROOT');
  });

  it('normalizes paths and rejects application data inside the movie library', () => {
    const libraryRoot = join(tmpdir(), 'reelkeeper-movies');
    const dataDirectory = join(tmpdir(), 'reelkeeper-appdata');
    expect(
      loadServerConfig({
        REELKEEPER_DATA_DIR: dataDirectory,
        MOVIE_LIBRARY_ROOT: libraryRoot,
      }),
    ).toEqual({
      dataDirectory: resolve(dataDirectory),
      libraryRoot: resolve(libraryRoot),
      listenHost: '127.0.0.1',
      listenPort: 3000,
      watcherPollIntervalMs: 5000,
      watcherStablePolls: 3,
    });

    expect(() =>
      loadServerConfig({
        REELKEEPER_DATA_DIR: join(libraryRoot, 'appdata'),
        MOVIE_LIBRARY_ROOT: libraryRoot,
      }),
    ).toThrow('must be outside');
  });

  it('configures watcher timing and rejects invalid intervals', () => {
    const config = loadServerConfig({
      REELKEEPER_DATA_DIR: join(tmpdir(), 'reelkeeper-appdata'),
      MOVIE_LIBRARY_ROOT: join(tmpdir(), 'reelkeeper-movies'),
      WATCHER_POLL_INTERVAL_SECONDS: '4',
      WATCHER_STABILITY_SECONDS: '10',
      REELKEEPER_HOST: 'localhost',
      REELKEEPER_PORT: '8080',
    });

    expect(config.watcherPollIntervalMs).toBe(4000);
    expect(config.watcherStablePolls).toBe(3);
    expect(config.listenHost).toBe('localhost');
    expect(config.listenPort).toBe(8080);
    expect(() =>
      loadServerConfig({
        REELKEEPER_DATA_DIR: join(tmpdir(), 'reelkeeper-appdata'),
        MOVIE_LIBRARY_ROOT: join(tmpdir(), 'reelkeeper-movies'),
        WATCHER_POLL_INTERVAL_SECONDS: '0',
      }),
    ).toThrow('WATCHER_POLL_INTERVAL_SECONDS');
  });
});
