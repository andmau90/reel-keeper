import { TmdbClient } from './tmdb-client.js';

function response(
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('TmdbClient', () => {
  it('uses Bearer authentication and sends the title, year, and language', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return response({
        results: [
          {
            id: 1,
            title: 'Costa d’ambra',
            original_title: 'Amber Coast',
            release_date: '2004-04-03',
            overview: 'A story.',
          },
        ],
      });
    };
    const client = new TmdbClient({
      accessToken: 'test-access-token',
      fetcher,
      now: () => 100,
    });

    const results = await client.searchMovies('Amber Coast', 2004);
    const request = requests[0];
    const url = new URL(request?.url ?? 'https://example.test');
    const headers = new Headers(request?.init?.headers);

    expect(url.searchParams.get('query')).toBe('Amber Coast');
    expect(url.searchParams.get('primary_release_year')).toBe('2004');
    expect(url.searchParams.get('language')).toBe('it-IT');
    expect(headers.get('authorization')).toBe('Bearer test-access-token');
    expect(results[0]).toMatchObject({
      title: 'Costa d’ambra',
      originalTitle: 'Amber Coast',
      year: 2004,
    });
    expect(request?.url).not.toContain('test-access-token');
  });

  it('fills missing localized fields from the English response', async () => {
    const languages: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      const language = url.searchParams.get('language') ?? '';
      languages.push(language);
      return language === 'it-IT'
        ? response({
            results: [
              {
                id: 1,
                title: 'Costa d’ambra',
                original_title: 'Amber Coast',
                release_date: '2004-04-03',
                overview: '',
              },
            ],
          })
        : response({
            results: [
              {
                id: 1,
                title: 'Amber Coast',
                original_title: 'Amber Coast',
                release_date: '2004-04-03',
                overview: 'English overview.',
              },
            ],
          });
    };
    const client = new TmdbClient({
      accessToken: 'test-access-token',
      fetcher,
      now: () => 100,
    });

    const results = await client.searchMovies('Amber Coast');

    expect(languages).toEqual(['it-IT', 'en-US']);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: 'Costa d’ambra',
      overview: 'English overview.',
    });
  });

  it('falls back to English search results when the localized search is empty', async () => {
    const fetcher: typeof fetch = async (input) => {
      const language = new URL(String(input)).searchParams.get('language');
      return response({
        results:
          language === 'it-IT'
            ? []
            : [
                {
                  id: 2,
                  title: 'Quiet Planet',
                  original_title: 'Quiet Planet',
                  release_date: '1998-01-01',
                  overview: 'English overview.',
                },
              ],
      });
    };
    const client = new TmdbClient({
      accessToken: 'test-access-token',
      fetcher,
      now: () => 100,
    });

    await expect(client.searchMovies('Quiet Planet')).resolves.toMatchObject([
      { id: 2, title: 'Quiet Planet', year: 1998 },
    ]);
  });

  it('caches repeated searches for the configured lifetime', async () => {
    let requestCount = 0;
    const fetcher: typeof fetch = async () => {
      requestCount += 1;
      return response({
        results: [
          {
            id: 1,
            title: 'Amber Coast',
            original_title: 'Amber Coast',
            release_date: '2004-04-03',
            overview: 'A story.',
          },
        ],
      });
    };
    const client = new TmdbClient({
      accessToken: 'test-access-token',
      fetcher,
      now: () => 100,
    });

    await client.searchMovies('Amber Coast', 2004);
    await client.searchMovies('Amber Coast', 2004);

    expect(requestCount).toBe(1);
  });

  it('reports authentication and rate-limit errors explicitly', async () => {
    const unauthorized = new TmdbClient({
      accessToken: 'test-access-token',
      fetcher: async () => response({}, 401),
    });
    const rateLimited = new TmdbClient({
      accessToken: 'test-access-token',
      fetcher: async () => response({}, 429, { 'Retry-After': '8' }),
    });

    await expect(unauthorized.searchMovies('Amber Coast')).rejects.toThrow(
      'TMDB authentication failed',
    );
    await expect(rateLimited.searchMovies('Amber Coast')).rejects.toThrow(
      'retry after 8 seconds',
    );
  });

  it('retrieves localized movie details and maps genres, credits, and ratings', async () => {
    const client = new TmdbClient({
      accessToken: 'test-access-token',
      fetcher: async () =>
        response({
          id: 33,
          title: 'Costa d’ambra',
          original_title: 'Amber Coast',
          release_date: '2004-04-03',
          overview: 'Una storia.',
          tagline: 'Una frase.',
          runtime: 108,
          genres: [{ id: 18, name: 'Dramma' }],
          production_companies: [{ id: 1, name: 'Studio' }],
          vote_average: 7.4,
          vote_count: 900,
          poster_path: '/poster.jpg',
          backdrop_path: '/backdrop.jpg',
          credits: {
            crew: [{ name: 'Ada Director', job: 'Director' }],
            cast: [{ name: 'Actor One', character: 'Lead', order: 0 }],
          },
        }),
    });

    await expect(client.getMovieDetails(33)).resolves.toMatchObject({
      id: 33,
      title: 'Costa d’ambra',
      originalTitle: 'Amber Coast',
      year: 2004,
      genres: ['Dramma'],
      studios: ['Studio'],
      directors: ['Ada Director'],
      actors: [{ name: 'Actor One', character: 'Lead' }],
      voteAverage: 7.4,
      posterPath: '/poster.jpg',
    });
  });

  it('fills missing localized detail fields from the English endpoint', async () => {
    const requestedLanguages: string[] = [];
    const client = new TmdbClient({
      accessToken: 'test-access-token',
      fetcher: async (input) => {
        const url = new URL(String(input));
        const language = url.searchParams.get('language') ?? '';
        requestedLanguages.push(language);
        const isEnglish = language === 'en-US';
        return response({
          id: 33,
          title: isEnglish ? 'Amber Coast' : 'Costa d’ambra',
          original_title: 'Amber Coast',
          release_date: '2004-04-03',
          overview: isEnglish ? 'English plot.' : '',
          tagline: '',
          genres: isEnglish ? [{ id: 18, name: 'Drama' }] : [],
          production_companies: [],
          credits: {
            crew: isEnglish ? [{ name: 'Ada Director', job: 'Director' }] : [],
            cast: isEnglish
              ? [{ name: 'Actor One', character: 'Lead', order: 0 }]
              : [],
          },
        });
      },
    });

    await expect(client.getMovieDetails(33)).resolves.toMatchObject({
      title: 'Costa d’ambra',
      overview: 'English plot.',
      genres: ['Drama'],
      directors: ['Ada Director'],
      actors: [{ name: 'Actor One', character: 'Lead' }],
    });
    expect(requestedLanguages).toEqual(['it-IT', 'en-US']);
  });

  it('downloads only image responses from the TMDB image host', async () => {
    let requestUrl = '';
    let requestHeaders: Headers | undefined;
    const client = new TmdbClient({
      accessToken: 'test-access-token',
      fetcher: async (input, init) => {
        requestUrl = String(input);
        requestHeaders = new Headers(init?.headers);
        return new Response(new Uint8Array([0xff, 0xd8]), {
          headers: { 'content-type': 'image/jpeg' },
        });
      },
    });

    await expect(
      client.downloadArtwork('/poster.jpg', 'w500'),
    ).resolves.toEqual(new Uint8Array([0xff, 0xd8]));
    expect(requestUrl).toBe('https://image.tmdb.org/t/p/w500/poster.jpg');
    expect(requestHeaders?.has('authorization')).toBe(false);
    await expect(client.downloadArtwork('/../secret', 'w500')).rejects.toThrow(
      'invalid artwork path',
    );
  });

  it('rejects invalid client configuration and empty queries', async () => {
    expect(() => new TmdbClient({ accessToken: ' ' })).toThrow(
      'TMDB_ACCESS_TOKEN',
    );
    const client = new TmdbClient({ accessToken: 'test-access-token' });

    await expect(client.searchMovies('  ')).rejects.toThrow(
      'non-empty movie title',
    );
  });
});
