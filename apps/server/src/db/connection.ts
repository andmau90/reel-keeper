import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import Database from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof Database>;

const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL('../../migrations/', import.meta.url),
);

/**
 * Opens a local SQLite database, configures it, and applies pending migrations.
 *
 * @param dataDirectory Local application data directory.
 * @returns An open database connection.
 * @throws If the directory, database, or a migration cannot be accessed.
 */
export function openDatabase(dataDirectory: string): SqliteDatabase {
  if (!dataDirectory.trim()) {
    throw new Error('REELKEEPER_DATA_DIR must be configured.');
  }

  mkdirSync(dataDirectory, { recursive: true });
  const database = new Database(join(dataDirectory, 'reelkeeper.sqlite'));
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  try {
    applyMigrations(database);
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
}

/**
 * Applies ordered SQL migrations that have not yet been recorded.
 *
 * @param database Open SQLite connection.
 * @throws If a migration cannot be read or executed.
 */
export function applyMigrations(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const migrationFiles = readdirSync(MIGRATIONS_DIRECTORY)
    .filter((name) => /^\d+_[\w-]+\.sql$/.test(name))
    .sort(
      (left, right) =>
        Number(left.slice(0, left.indexOf('_'))) -
          Number(right.slice(0, right.indexOf('_'))) ||
        left.localeCompare(right),
    );

  for (const filename of migrationFiles) {
    const version = filename.slice(0, filename.indexOf('_'));
    const isApplied = database
      .prepare('SELECT version FROM schema_migrations WHERE version = ?')
      .get(version);

    if (isApplied) {
      continue;
    }

    const migration = readFileSync(
      join(MIGRATIONS_DIRECTORY, filename),
      'utf8',
    );
    const apply = database.transaction(() => {
      database.exec(migration);
      database
        .prepare(
          'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        )
        .run(version, new Date().toISOString());
    });
    apply();
  }
}

export type { SqliteDatabase };
