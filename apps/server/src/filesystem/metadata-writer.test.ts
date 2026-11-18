import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/connection.js';
import { TmdbClient } from '../tmdb-client.js';
import { OperationExecutor } from './operation-executor.js';
import { MovieMetadataWriter } from './metadata-writer.js';

const folderName = 'Amber Coast (2004)';
const videoName = `${folderName}.mkv`;

const details = {
  id: 33,
  title: 'Amber Coast',
  original_title: 'Amber Coast',
  release_date: '2004-04-03',
  overview: 'A story.',
  tagline: 'A phrase.',
  runtime: 108,
  genres: [{ id: 18, name: 'Drama' }],
  production_companies: [{ id: 1, name: 'Studio' }],
  vote_average: 7.4,
  vote_count: 900,
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  credits: {
    crew: [{ name: 'Ada Director', job: 'Director' }],
    cast: [{ name: 'Actor One', character: 'Lead', order: 0 }],
  },
};

async function createFixture() {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'reelkeeper-metadata-'),
  );
  const libraryRoot = join(temporaryDirectory, 'movies');
  const dataDirectory = join(temporaryDirectory, 'data');
  const folder = join(libraryRoot, folderName);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, videoName), 'video');
  const database = openDatabase(dataDirectory);
  const requests: string[] = [];
  const tmdb = new TmdbClient({
    accessToken: 'test-access-token',
    fetcher: async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.startsWith('https://image.tmdb.org/')) {
        return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
          headers: { 'content-type': 'image/jpeg' },
        });
      }
      return new Response(JSON.stringify(details));
    },
  });
  const executor = new OperationExecutor(database, libraryRoot, dataDirectory);

  return {
    temporaryDirectory,
    libraryRoot,
    folder,
    database,
    requests,
    writer: new MovieMetadataWriter(database, libraryRoot, tmdb, executor),
    executor,
  };
}

describe('MovieMetadataWriter', () => {
  it('creates a Kodi NFO and missing artwork as one approved batch', async () => {
    const fixture = await createFixture();
    try {
      const batch = await fixture.writer.refresh(
        { tmdbId: 33, videoPath: `${folderName}/${videoName}` },
        true,
      );

      expect(batch.operations.map((operation) => operation.type)).toEqual([
        'write_nfo',
        'write_image',
        'write_image',
      ]);
      const nfo = await readFile(
        join(fixture.folder, `${folderName}.nfo`),
        'utf8',
      );
      expect(nfo).toContain('<title>Amber Coast</title>');
      expect(nfo).toContain(
        '<uniqueid type="tmdb" default="true">33</uniqueid>',
      );
      expect(await readFile(join(fixture.folder, 'poster.jpg'))).toEqual(
        Buffer.from([0xff, 0xd8, 0xff]),
      );
      expect(await readFile(join(fixture.folder, 'fanart.jpg'))).toEqual(
        Buffer.from([0xff, 0xd8, 0xff]),
      );
      expect(
        fixture.requests.filter((url) => url.includes('image.tmdb.org')),
      ).toHaveLength(2);

      await fixture.executor.undoBatch(batch.batchId);
      await expect(
        readFile(join(fixture.folder, `${folderName}.nfo`)),
      ).rejects.toThrow();
      await expect(
        readFile(join(fixture.folder, 'poster.jpg')),
      ).rejects.toThrow();
    } finally {
      fixture.database.close();
      await rm(fixture.temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('preserves existing artwork and locked NFO fields on refresh', async () => {
    const fixture = await createFixture();
    try {
      await writeFile(join(fixture.folder, 'poster.jpg'), 'user poster');
      await writeFile(join(fixture.folder, 'fanart.jpg'), 'user fanart');
      await writeFile(
        join(fixture.folder, `${folderName}.nfo`),
        '<movie><title>My title</title><custom>Keep me</custom></movie>',
      );

      const batch = await fixture.writer.refresh(
        {
          tmdbId: 33,
          videoPath: `${folderName}/${videoName}`,
          lockedFields: ['title'],
        },
        true,
      );

      expect(batch.operations).toHaveLength(1);
      expect(await readFile(join(fixture.folder, 'poster.jpg'), 'utf8')).toBe(
        'user poster',
      );
      expect(await readFile(join(fixture.folder, 'fanart.jpg'), 'utf8')).toBe(
        'user fanart',
      );
      const nfo = await readFile(
        join(fixture.folder, `${folderName}.nfo`),
        'utf8',
      );
      expect(nfo).toContain('<title>My title</title>');
      expect(nfo).toContain('<custom>Keep me</custom>');
      expect(nfo).toContain('<plot>A story.</plot>');
      expect(
        fixture.requests.filter((url) => url.includes('image.tmdb.org')),
      ).toHaveLength(0);
    } finally {
      fixture.database.close();
      await rm(fixture.temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('replaces artwork only when requested and restores it on undo', async () => {
    const fixture = await createFixture();
    try {
      await writeFile(join(fixture.folder, 'poster.jpg'), 'existing poster');
      const batch = await fixture.writer.refresh(
        {
          tmdbId: 33,
          videoPath: `${folderName}/${videoName}`,
          replaceArtwork: true,
        },
        true,
      );

      expect(await readFile(join(fixture.folder, 'poster.jpg'))).toEqual(
        Buffer.from([0xff, 0xd8, 0xff]),
      );
      await fixture.executor.undoBatch(batch.batchId);
      expect(await readFile(join(fixture.folder, 'poster.jpg'), 'utf8')).toBe(
        'existing poster',
      );
      await expect(
        readFile(join(fixture.folder, 'fanart.jpg')),
      ).rejects.toThrow();
    } finally {
      fixture.database.close();
      await rm(fixture.temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('saves manual edits, persists locks, and respects them on refresh', async () => {
    const fixture = await createFixture();
    const videoPath = `${folderName}/${videoName}`;
    try {
      const result = await fixture.writer.edit(
        {
          tmdbId: 33,
          videoPath,
          metadata: { title: 'My title', genres: [] },
          lockedFields: ['title', 'genres'],
        },
        true,
      );
      expect(result.current.lockedFields).toEqual(['title', 'genres']);
      expect(result.current.metadata.title).toBe('My title');
      expect(
        await readFile(join(fixture.folder, `${folderName}.nfo`), 'utf8'),
      ).toContain('<title>My title</title>');

      await fixture.writer.refresh({ tmdbId: 33, videoPath }, true);
      const refreshedNfo = await readFile(
        join(fixture.folder, `${folderName}.nfo`),
        'utf8',
      );
      expect(refreshedNfo).toContain('<title>My title</title>');
      expect(refreshedNfo).not.toContain('<genre>');
    } finally {
      fixture.database.close();
      await rm(fixture.temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('requires approval and rejects unsafe video paths before contacting TMDB', async () => {
    const fixture = await createFixture();
    try {
      await expect(
        fixture.writer.refresh(
          { tmdbId: 33, videoPath: `${folderName}/${videoName}` },
          false,
        ),
      ).rejects.toThrow('Explicit approval is required');
      await expect(
        fixture.writer.edit(
          {
            tmdbId: 33,
            videoPath: `${folderName}/${videoName}`,
            metadata: { title: 'No approval' },
            lockedFields: ['title'],
          },
          false,
        ),
      ).rejects.toThrow('Explicit approval is required');
      await expect(
        fixture.writer.refresh(
          { tmdbId: 33, videoPath: '../outside.mkv' },
          true,
        ),
      ).rejects.toThrow('directly inside one movie folder');
      expect(fixture.requests).toEqual([]);
    } finally {
      fixture.database.close();
      await rm(fixture.temporaryDirectory, { recursive: true, force: true });
    }
  });
});
