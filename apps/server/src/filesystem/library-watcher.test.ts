import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MovieSearchProvider } from '../recognizer.js';
import { openDatabase, type SqliteDatabase } from '../db/connection.js';
import { listInboxItems, LibraryWatcher } from './library-watcher.js';

async function createFixture(provider?: MovieSearchProvider) {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'reelkeeper-watcher-'),
  );
  const libraryRoot = join(temporaryDirectory, 'movies');
  const dataDirectory = join(temporaryDirectory, 'data');
  await mkdir(libraryRoot);
  const database = openDatabase(dataDirectory);
  const errors: Error[] = [];
  const requests: Array<{ query: string; year?: number }> = [];
  let now = Date.now();
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const searchProvider: MovieSearchProvider = provider ?? {
    async searchMovies(query, year) {
      requests.push({ query, year });
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeRequests -= 1;
      return [{ id: 1, title: query, year }];
    },
  };
  const watcher = new LibraryWatcher({
    database,
    libraryRoot,
    provider: searchProvider,
    pollIntervalMs: 5000,
    stablePolls: 3,
    onError: (error) => errors.push(error),
    now: () => now,
  });

  return {
    temporaryDirectory,
    libraryRoot,
    dataDirectory,
    database,
    errors,
    requests,
    watcher,
    advanceClock: (milliseconds = 5000) => {
      now += milliseconds;
    },
    getNow: () => now,
    getMaxActiveRequests: () => maxActiveRequests,
  };
}

describe('LibraryWatcher', () => {
  it('waits for three unchanged intervals before recognizing a file', async () => {
    const fixture = await createFixture();
    const videoPath = join(fixture.libraryRoot, 'Amber.Coast.2004.mkv');
    try {
      await writeFile(videoPath, 'video bytes');

      await fixture.watcher.pollOnce();
      fixture.advanceClock();
      await fixture.watcher.pollOnce();
      fixture.advanceClock();
      await fixture.watcher.pollOnce();
      await fixture.watcher.waitForIdle();
      expect(listInboxItems(fixture.database)[0]).toMatchObject({
        sourcePath: 'Amber.Coast.2004.mkv',
        status: 'observing',
        stableIntervals: 2,
      });
      expect(fixture.requests).toEqual([]);

      fixture.advanceClock();
      await fixture.watcher.pollOnce();
      await fixture.watcher.waitForIdle();

      expect(listInboxItems(fixture.database)[0]).toMatchObject({
        status: 'candidates_found',
        parsedTitle: 'Amber Coast',
        parsedYear: 2004,
        stableIntervals: 3,
        candidates: [{ candidate: { id: 1 }, score: 100 }],
      });
      expect(fixture.requests).toEqual([{ query: 'Amber Coast', year: 2004 }]);
      expect(await readFile(videoPath, 'utf8')).toBe('video bytes');
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.watcher.stop();
      fixture.database.close();
      await rm(fixture.temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('does not count repeated scans faster than the configured poll interval', async () => {
    const fixture = await createFixture();
    try {
      await writeFile(
        join(fixture.libraryRoot, 'Amber.Coast.2004.mkv'),
        'video bytes',
      );
      await fixture.watcher.pollOnce();
      await fixture.watcher.pollOnce();
      await fixture.watcher.pollOnce();
      expect(listInboxItems(fixture.database)[0]?.stableIntervals).toBe(0);

      fixture.advanceClock(4999);
      await fixture.watcher.pollOnce();
      expect(listInboxItems(fixture.database)[0]?.stableIntervals).toBe(0);

      fixture.advanceClock(1);
      await fixture.watcher.pollOnce();
      expect(listInboxItems(fixture.database)[0]?.stableIntervals).toBe(1);
    } finally {
      await fixture.watcher.stop();
      fixture.database.close();
      await rm(fixture.temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('recognizes multiple stable files with concurrency fixed at one', async () => {
    const fixture = await createFixture();
    try {
      await writeFile(
        join(fixture.libraryRoot, 'Amber.Coast.2004.mkv'),
        'amber',
      );
      await writeFile(
        join(fixture.libraryRoot, 'Quiet.Planet.1998.mkv'),
        'quiet',
      );

      for (let poll = 0; poll < 4; poll += 1) {
        await fixture.watcher.pollOnce();
        fixture.advanceClock();
      }
      await fixture.watcher.waitForIdle();

      expect(fixture.getMaxActiveRequests()).toBe(1);
      expect(fixture.requests).toHaveLength(2);
      expect(
        listInboxItems(fixture.database).map((item) => item.status),
      ).toEqual(['candidates_found', 'candidates_found']);
    } finally {
      await fixture.watcher.stop();
      fixture.database.close();
      await rm(fixture.temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('marks stable multi-video folders for review without choosing a video', async () => {
    const fixture = await createFixture();
    const folder = join(fixture.libraryRoot, 'Collection');
    try {
      await mkdir(folder);
      await writeFile(join(folder, 'Part.One.2001.mkv'), 'one');
      await writeFile(join(folder, 'Part.Two.2001.mkv'), 'two');

      for (let poll = 0; poll < 4; poll += 1) {
        await fixture.watcher.pollOnce();
        fixture.advanceClock();
      }
      await fixture.watcher.waitForIdle();

      expect(listInboxItems(fixture.database)).toMatchObject([
        {
          sourcePath: 'Collection',
          videoPath: null,
          status: 'needs_review',
          reviewReason: 'multiple_videos',
        },
      ]);
      expect(fixture.requests).toEqual([]);
    } finally {
      await fixture.watcher.stop();
      fixture.database.close();
      await rm(fixture.temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('recovers interrupted queue work from SQLite after reopening the database', async () => {
    const fixture = await createFixture();
    const videoName = 'Amber.Coast.2004.mkv';
    try {
      await writeFile(join(fixture.libraryRoot, videoName), 'video bytes');
      await fixture.watcher.pollOnce();
      await fixture.watcher.waitForIdle();
      const item = listInboxItems(fixture.database)[0];
      expect(item).toBeDefined();
      fixture.database
        .prepare(`UPDATE inbox_items SET status = 'processing' WHERE id = ?`)
        .run(item?.id);
      fixture.database.close();

      const database: SqliteDatabase = openDatabase(fixture.dataDirectory);
      const watcher = new LibraryWatcher({
        database,
        libraryRoot: fixture.libraryRoot,
        provider: {
          async searchMovies(query, year) {
            return [{ id: 1, title: query, year }];
          },
        },
        pollIntervalMs: 5000,
        stablePolls: 3,
        onError: (error) => fixture.errors.push(error),
        now: fixture.getNow,
      });

      try {
        await watcher.start();
        await watcher.waitForIdle();
        expect(listInboxItems(database)[0]).toMatchObject({
          status: 'candidates_found',
          parsedTitle: 'Amber Coast',
        });
      } finally {
        await watcher.stop();
        database.close();
      }
    } finally {
      await fixture.watcher.stop();
      await rm(fixture.temporaryDirectory, { recursive: true, force: true });
    }
  });
});
