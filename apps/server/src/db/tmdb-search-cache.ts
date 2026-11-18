import type { TmdbSearchCache } from '../tmdb-client.js';
import type { SqliteDatabase } from './connection.js';

interface CachedSearchRow {
  payload: string;
  expires_at: number;
}

/**
 * Persists TMDB API responses in the application SQLite database.
 */
export class SqliteTmdbSearchCache implements TmdbSearchCache {
  private readonly database: SqliteDatabase;

  /**
   * Creates the cache adapter.
   *
   * @param database Open ReelKeeper SQLite connection.
   */
  constructor(database: SqliteDatabase) {
    this.database = database;
  }

  /**
   * Returns unexpired cached payloads and removes expired rows.
   *
   * @param key Normalized search request key.
   * @param now Current time in epoch milliseconds.
   * @returns Cached payload, or undefined when unavailable or expired.
   */
  get(key: string, now: number): unknown | undefined {
    const row = this.database
      .prepare<[string], CachedSearchRow>(
        'SELECT payload, expires_at FROM tmdb_cache WHERE cache_key = ?',
      )
      .get(key);
    if (!row) {
      return undefined;
    }

    if (row.expires_at <= now) {
      this.database
        .prepare('DELETE FROM tmdb_cache WHERE cache_key = ?')
        .run(key);
      return undefined;
    }

    const payload: unknown = JSON.parse(row.payload);
    return payload;
  }

  /**
   * Stores a payload and its expiration timestamps.
   *
   * @param key Normalized search request key.
   * @param payload TMDB API response.
   * @param fetchedAt Fetch time in epoch milliseconds.
   * @param expiresAt Expiration time in epoch milliseconds.
   */
  set(
    key: string,
    payload: unknown,
    fetchedAt: number,
    expiresAt: number,
  ): void {
    this.database
      .prepare(
        `INSERT INTO tmdb_cache (cache_key, payload, fetched_at, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
           payload = excluded.payload,
           fetched_at = excluded.fetched_at,
           expires_at = excluded.expires_at`,
      )
      .run(key, JSON.stringify(payload), fetchedAt, expiresAt);
  }
}
