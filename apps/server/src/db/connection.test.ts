import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './connection.js';

describe('openDatabase', () => {
  it('creates the schema and applies each migration once', async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), 'reelkeeper-database-'),
    );
    const dataDirectory = join(temporaryDirectory, 'data');

    try {
      const firstConnection = openDatabase(dataDirectory);
      try {
        expect(
          firstConnection
            .prepare('SELECT version FROM schema_migrations')
            .all(),
        ).toEqual([
          { version: '001' },
          { version: '002' },
          { version: '003' },
          { version: '004' },
        ]);
        expect(
          firstConnection
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operations'",
            )
            .get(),
        ).toEqual({ name: 'operations' });
        expect(
          firstConnection
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'movie_metadata_state'",
            )
            .get(),
        ).toEqual({ name: 'movie_metadata_state' });
      } finally {
        firstConnection.close();
      }

      const secondConnection = openDatabase(dataDirectory);
      try {
        expect(
          secondConnection
            .prepare('SELECT COUNT(*) AS count FROM schema_migrations')
            .get(),
        ).toEqual({ count: 4 });
      } finally {
        secondConnection.close();
      }
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
