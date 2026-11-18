import { z } from 'zod';

const TmdbSearchResponseSchema = z.object({
  results: z.array(
    z.object({
      id: z.number().int().positive(),
      title: z.string().nullish(),
      original_title: z.string().nullish(),
      release_date: z.string().nullish(),
      overview: z.string().nullish(),
      poster_path: z.string().nullish(),
      backdrop_path: z.string().nullish(),
    }),
  ),
});

const TmdbMovieDetailsSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1),
  originalTitle: z.string(),
  year: z.number().int().nullable(),
  releaseDate: z.string().nullable(),
  overview: z.string(),
  tagline: z.string(),
  runtime: z.number().int().positive().nullable(),
  genres: z.array(z.string()),
  studios: z.array(z.string()),
  directors: z.array(z.string()),
  actors: z.array(z.object({ name: z.string(), character: z.string() })),
  voteAverage: z.number().nullable(),
  voteCount: z.number().int().nonnegative().nullable(),
  posterPath: z.string().nullable(),
  backdropPath: z.string().nullable(),
});

const TMDB_API_URL = 'https://api.themoviedb.org/3/search/movie';
const ENGLISH_FALLBACK_LANGUAGE = 'en-US';
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Validates cached and returned TMDB movie search results.
 */
export const TmdbMovieSearchResultSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1),
  originalTitle: z.string(),
  year: z.number().int().nullable(),
  overview: z.string(),
  releaseDate: z.string().nullable(),
  posterPath: z.string().nullable(),
  backdropPath: z.string().nullable(),
});

const TmdbSearchResultsSchema = z.array(TmdbMovieSearchResultSchema);
const TmdbMovieDetailsResponseSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().nullish(),
  original_title: z.string().nullish(),
  release_date: z.string().nullish(),
  overview: z.string().nullish(),
  tagline: z.string().nullish(),
  runtime: z.number().int().positive().nullish(),
  genres: z.array(z.object({ id: z.number(), name: z.string() })).default([]),
  production_companies: z
    .array(z.object({ id: z.number(), name: z.string() }))
    .default([]),
  vote_average: z.number().nullish(),
  vote_count: z.number().int().nonnegative().nullish(),
  poster_path: z.string().nullish(),
  backdrop_path: z.string().nullish(),
  credits: z
    .object({
      crew: z
        .array(z.object({ name: z.string(), job: z.string() }).passthrough())
        .default([]),
      cast: z
        .array(
          z
            .object({
              name: z.string(),
              character: z.string().nullish(),
              order: z.number().int().nonnegative().nullish(),
            })
            .passthrough(),
        )
        .default([]),
    })
    .optional(),
});

/**
 * A movie search result with the metadata returned by TMDB.
 */
export type TmdbMovieSearchResult = z.infer<typeof TmdbMovieSearchResultSchema>;

/**
 * Movie details used to create or refresh a Kodi NFO file.
 */
export interface TmdbMovieDetails {
  id: number;
  title: string;
  originalTitle: string;
  year: number | null;
  releaseDate: string | null;
  overview: string;
  tagline: string;
  runtime: number | null;
  genres: string[];
  studios: string[];
  directors: string[];
  actors: Array<{ name: string; character: string }>;
  voteAverage: number | null;
  voteCount: number | null;
  posterPath: string | null;
  backdropPath: string | null;
}

/**
 * Provides the cache operations used by the TMDB client.
 */
export interface TmdbSearchCache {
  /**
   * Retrieves an unexpired search result.
   *
   * @param key Normalized search request key.
   * @param now Current time in epoch milliseconds.
   * @returns Cached results, or undefined when unavailable or expired.
   */
  get(key: string, now: number): unknown | undefined;

  /**
   * Stores a search result with its expiration time.
   *
   * @param key Normalized search request key.
   * @param results TMDB search results.
   * @param fetchedAt Fetch time in epoch milliseconds.
   * @param expiresAt Expiration time in epoch milliseconds.
   */
  set(
    key: string,
    payload: unknown,
    fetchedAt: number,
    expiresAt: number,
  ): void;
}

/**
 * Configures TMDB access and the in-memory search cache.
 */
export interface TmdbClientOptions {
  /** TMDB API Read Access Token; never included in the request URL. */
  accessToken: string;
  /** Fetch implementation, injectable for tests. */
  fetcher?: typeof fetch;
  /** Cache lifetime in milliseconds. */
  cacheTtlMs?: number;
  /** Clock implementation, injectable for deterministic cache tests. */
  now?: () => number;
  /** Search cache implementation; defaults to an in-memory cache. */
  cache?: TmdbSearchCache;
}

interface CachedSearch {
  expiresAt: number;
  payload: unknown;
}

class MemoryTmdbSearchCache implements TmdbSearchCache {
  private readonly cache = new Map<string, CachedSearch>();

  get(key: string, now: number): unknown | undefined {
    const cached = this.cache.get(key);
    if (!cached) {
      return undefined;
    }
    if (cached.expiresAt <= now) {
      this.cache.delete(key);
      return undefined;
    }
    return cached.payload;
  }

  set(
    key: string,
    payload: unknown,
    fetchedAt: number,
    expiresAt: number,
  ): void {
    for (const [cachedKey, cached] of this.cache) {
      if (cached.expiresAt <= fetchedAt) {
        this.cache.delete(cachedKey);
      }
    }
    this.cache.set(key, { payload, expiresAt });
  }
}

/**
 * Searches TMDB with Bearer authentication, language fallback, and caching.
 */
export class TmdbClient {
  private readonly accessToken: string;
  private readonly fetcher: typeof fetch;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly cache: TmdbSearchCache;

  /**
   * Creates a TMDB client.
   *
   * @param options Authentication and test/cache options.
   * @throws If the token is empty or the cache lifetime is invalid.
   */
  constructor(options: TmdbClientOptions) {
    if (!options.accessToken.trim()) {
      throw new Error('TMDB_ACCESS_TOKEN must be configured.');
    }

    const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    if (!Number.isFinite(cacheTtlMs) || cacheTtlMs < 0) {
      throw new Error('TMDB cache lifetime must be a non-negative number.');
    }

    this.accessToken = options.accessToken;
    this.fetcher = options.fetcher ?? fetch;
    this.cacheTtlMs = cacheTtlMs;
    this.now = options.now ?? Date.now;
    this.cache = options.cache ?? new MemoryTmdbSearchCache();
  }

  /**
   * Searches for movie candidates and fills missing localized fields from English.
   *
   * @param query Movie title to search for.
   * @param year Optional release year used to narrow the provider query.
   * @param language Primary response language.
   * @returns Candidates in provider order, with localized values preferred.
   * @throws If TMDB rejects the request or returns an invalid response.
   */
  async searchMovies(
    query: string,
    year?: number,
    language = 'it-IT',
  ): Promise<TmdbMovieSearchResult[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      throw new Error('A non-empty movie title is required for TMDB search.');
    }

    const primaryResults = await this.fetchSearch(
      normalizedQuery,
      year,
      language,
    );
    if (
      language === ENGLISH_FALLBACK_LANGUAGE ||
      (primaryResults.length > 0 &&
        primaryResults.every(
          (result) =>
            Boolean(result.title?.trim()) && Boolean(result.overview?.trim()),
        ))
    ) {
      return primaryResults;
    }

    const englishResults = await this.fetchSearch(
      normalizedQuery,
      year,
      ENGLISH_FALLBACK_LANGUAGE,
    );
    return mergeSearchResults(primaryResults, englishResults);
  }

  /**
   * Retrieves localized movie metadata, credits, and artwork paths.
   *
   * @param movieId TMDB movie identifier.
   * @param language Primary response language.
   * @returns Details with missing localized values filled from English.
   * @throws If TMDB rejects the request or returns an invalid response.
   */
  async getMovieDetails(
    movieId: number,
    language = 'it-IT',
  ): Promise<TmdbMovieDetails> {
    if (!Number.isSafeInteger(movieId) || movieId <= 0) {
      throw new Error('A positive TMDB movie ID is required.');
    }

    const primary = await this.fetchMovieDetails(movieId, language);
    if (language === ENGLISH_FALLBACK_LANGUAGE || !hasMissingDetails(primary)) {
      return primary;
    }

    const english = await this.fetchMovieDetails(
      movieId,
      ENGLISH_FALLBACK_LANGUAGE,
    );
    return mergeMovieDetails(primary, english);
  }

  /**
   * Downloads an artwork image from TMDB's image host.
   *
   * @param imagePath Image path returned by TMDB.
   * @param size Approved TMDB image size.
   * @returns Image bytes.
   * @throws If the path or image response is invalid.
   */
  async downloadArtwork(
    imagePath: string,
    size: 'w500' | 'w780' | 'original',
  ): Promise<Uint8Array> {
    const segments = imagePath.split('/').slice(1);
    if (
      !/^\/[A-Za-z0-9_./-]+$/.test(imagePath) ||
      segments.some(
        (segment) => !segment || segment === '.' || segment === '..',
      )
    ) {
      throw new Error('TMDB returned an invalid artwork path.');
    }
    if (!['w500', 'w780', 'original'].includes(size)) {
      throw new Error('TMDB artwork size is invalid.');
    }

    const response = await this.fetcher(
      `https://image.tmdb.org/t/p/${size}${imagePath}`,
      {
        headers: { Accept: 'image/*' },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      throw new Error(
        `TMDB artwork request failed with status ${response.status}.`,
      );
    }
    const contentType = response.headers
      .get('content-type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase();
    if (!contentType?.startsWith('image/')) {
      throw new Error('TMDB returned a non-image artwork response.');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0) {
      throw new Error('TMDB returned an empty artwork image.');
    }
    return bytes;
  }

  private async fetchSearch(
    query: string,
    year: number | undefined,
    language: string,
  ): Promise<TmdbMovieSearchResult[]> {
    const params = new URLSearchParams({
      query,
      include_adult: 'false',
      language,
    });
    if (year !== undefined) {
      params.set('primary_release_year', String(year));
    }

    const cacheKey = params.toString();
    const now = this.now();
    const cached = this.cache.get(cacheKey, now);
    if (cached !== undefined) {
      return TmdbSearchResultsSchema.parse(cached);
    }

    const payload = await this.fetchJson(`${TMDB_API_URL}?${cacheKey}`);
    const parsedResponse = TmdbSearchResponseSchema.parse(payload);
    const results = parsedResponse.results.map(toSearchResult);
    const fetchedAt = this.now();
    this.cache.set(cacheKey, results, fetchedAt, fetchedAt + this.cacheTtlMs);
    return results;
  }

  private async fetchMovieDetails(
    movieId: number,
    language: string,
  ): Promise<TmdbMovieDetails> {
    const params = new URLSearchParams({
      language,
      append_to_response: 'credits',
    });
    const cacheKey = `movie:${movieId}:${params.toString()}`;
    const now = this.now();
    const cached = this.cache.get(cacheKey, now);
    if (cached !== undefined) {
      return TmdbMovieDetailsSchema.parse(cached);
    }

    const payload = await this.fetchJson(
      `https://api.themoviedb.org/3/movie/${movieId}?${params.toString()}`,
    );
    const response = TmdbMovieDetailsResponseSchema.parse(payload);
    const details = toMovieDetails(response);
    const fetchedAt = this.now();
    this.cache.set(cacheKey, details, fetchedAt, fetchedAt + this.cacheTtlMs);
    return details;
  }

  private async fetchJson(url: string): Promise<unknown> {
    const response = await this.fetcher(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 401) {
      throw new Error(
        'TMDB authentication failed; check the TMDB API Read Access Token.',
      );
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      throw new Error(
        retryAfter
          ? `TMDB rate limit reached; retry after ${retryAfter} seconds.`
          : 'TMDB rate limit reached; retry later.',
      );
    }
    if (!response.ok) {
      throw new Error(`TMDB request failed with status ${response.status}.`);
    }
    return response.json();
  }
}

function toSearchResult(
  result: z.infer<typeof TmdbSearchResponseSchema>['results'][number],
): TmdbMovieSearchResult {
  const originalTitle = result.original_title?.trim() ?? '';
  const title = result.title?.trim() || originalTitle;
  const releaseDate = result.release_date?.trim() || null;

  return TmdbMovieSearchResultSchema.parse({
    id: result.id,
    title,
    originalTitle,
    year: parseReleaseYear(releaseDate),
    overview: result.overview?.trim() ?? '',
    releaseDate,
    posterPath: result.poster_path ?? null,
    backdropPath: result.backdrop_path ?? null,
  });
}

function mergeSearchResults(
  primaryResults: TmdbMovieSearchResult[],
  englishResults: TmdbMovieSearchResult[],
): TmdbMovieSearchResult[] {
  const englishById = new Map(
    englishResults.map((result) => [result.id, result]),
  );
  const primaryIds = new Set(primaryResults.map((result) => result.id));
  const merged: TmdbMovieSearchResult[] = [];

  for (const id of [
    ...primaryResults.map((result) => result.id),
    ...englishResults
      .filter((result) => !primaryIds.has(result.id))
      .map((result) => result.id),
  ]) {
    const primary = primaryResults.find((result) => result.id === id);
    const english = englishById.get(id);
    const title =
      primary?.title.trim() ||
      english?.title.trim() ||
      primary?.originalTitle.trim() ||
      english?.originalTitle.trim();

    if (!title) {
      continue;
    }

    const originalTitle =
      primary?.originalTitle.trim() || english?.originalTitle.trim() || title;
    const releaseDate = primary?.releaseDate || english?.releaseDate || null;
    merged.push({
      id,
      title,
      originalTitle,
      year: parseReleaseYear(releaseDate),
      overview: primary?.overview || english?.overview || '',
      releaseDate,
      posterPath: primary?.posterPath || english?.posterPath || null,
      backdropPath: primary?.backdropPath || english?.backdropPath || null,
    });
  }

  return merged;
}

function toMovieDetails(
  response: z.infer<typeof TmdbMovieDetailsResponseSchema>,
): TmdbMovieDetails {
  const originalTitle = response.original_title?.trim() ?? '';
  const title = response.title?.trim() || originalTitle;
  const releaseDate = response.release_date?.trim() || null;
  const credits = response.credits;

  return TmdbMovieDetailsSchema.parse({
    id: response.id,
    title,
    originalTitle,
    year: parseReleaseYear(releaseDate),
    releaseDate,
    overview: response.overview?.trim() ?? '',
    tagline: response.tagline?.trim() ?? '',
    runtime: response.runtime ?? null,
    genres: uniqueNames(response.genres.map((genre) => genre.name)),
    studios: uniqueNames(
      response.production_companies.map((company) => company.name),
    ),
    directors: uniqueNames(
      credits?.crew
        .filter((member) => member.job.toLowerCase() === 'director')
        .map((member) => member.name) ?? [],
    ),
    actors:
      credits?.cast
        .slice()
        .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
        .map((actor) => ({
          name: actor.name.trim(),
          character: actor.character?.trim() ?? '',
        }))
        .filter((actor) => actor.name.length > 0) ?? [],
    voteAverage: response.vote_average ?? null,
    voteCount: response.vote_count ?? null,
    posterPath: response.poster_path ?? null,
    backdropPath: response.backdrop_path ?? null,
  });
}

function hasMissingDetails(details: TmdbMovieDetails): boolean {
  return (
    !details.overview ||
    !details.tagline ||
    details.genres.length === 0 ||
    details.studios.length === 0 ||
    details.directors.length === 0 ||
    details.actors.length === 0
  );
}

function mergeMovieDetails(
  primary: TmdbMovieDetails,
  english: TmdbMovieDetails,
): TmdbMovieDetails {
  const releaseDate = primary.releaseDate || english.releaseDate;
  return TmdbMovieDetailsSchema.parse({
    ...primary,
    title: primary.title || english.title || primary.originalTitle,
    originalTitle: primary.originalTitle || english.originalTitle,
    year: parseReleaseYear(releaseDate),
    releaseDate,
    overview: primary.overview || english.overview,
    tagline: primary.tagline || english.tagline,
    runtime: primary.runtime ?? english.runtime,
    genres: primary.genres.length > 0 ? primary.genres : english.genres,
    studios: primary.studios.length > 0 ? primary.studios : english.studios,
    directors:
      primary.directors.length > 0 ? primary.directors : english.directors,
    actors: primary.actors.length > 0 ? primary.actors : english.actors,
    voteAverage: primary.voteAverage ?? english.voteAverage,
    voteCount: primary.voteCount ?? english.voteCount,
    posterPath: primary.posterPath || english.posterPath,
    backdropPath: primary.backdropPath || english.backdropPath,
  });
}

function uniqueNames(names: string[]): string[] {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))];
}

function parseReleaseYear(releaseDate: string | null): number | null {
  const year = releaseDate?.match(/^(\d{4})-\d{2}-\d{2}$/)?.[1];
  return year ? Number(year) : null;
}
