import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './connection.js';
import { SqliteTmdbSearchCache } from './tmdb-search-cache.js';
import { TmdbClient, type TmdbMovieSearchResult } from '../tmdb-client.js';

const searchResults: TmdbMovieSearchResult[] = [
  {
    id: 1,
    title: 'Amber Coast',
    originalTitle: 'Amber Coast',
    year: 2004,
    overview: 'A story.',
    releaseDate: '2004-04-03',
    posterPath: null,
    backdropPath: null,
  },
];

describe('SqliteTmdbSearchCache', () => {
  it('persists valid results and removes expired cache entries', async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), 'reelkeeper-cache-'),
    );
    const database = openDatabase(join(temporaryDirectory, 'data'));

    try {
      const cache = new SqliteTmdbSearchCache(database);
      cache.set('query=Amber+Coast', searchResults, 100, 200);

      expect(cache.get('query=Amber+Coast', 199)).toEqual(searchResults);
      expect(cache.get('query=Amber+Coast', 200)).toBeUndefined();
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM tmdb_cache').get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('lets separate TMDB clients reuse the persistent search cache', async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), 'reelkeeper-cache-'),
    );
    const database = openDatabase(join(temporaryDirectory, 'data'));
    let requestCount = 0;
    const fetcher: typeof fetch = async () => {
      requestCount += 1;
      return new Response(
        JSON.stringify({
          results: [
            {
              id: 1,
              title: 'Amber Coast',
              original_title: 'Amber Coast',
              release_date: '2004-04-03',
              overview: 'A story.',
            },
          ],
        }),
      );
    };

    try {
      const firstClient = new TmdbClient({
        accessToken: 'test-access-token',
        fetcher,
        now: () => 100,
        cache: new SqliteTmdbSearchCache(database),
      });
      const secondClient = new TmdbClient({
        accessToken: 'test-access-token',
        fetcher,
        now: () => 200,
        cache: new SqliteTmdbSearchCache(database),
      });

      await firstClient.searchMovies('Amber Coast', 2004);
      await secondClient.searchMovies('Amber Coast', 2004);

      expect(requestCount).toBe(1);
    } finally {
      database.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
