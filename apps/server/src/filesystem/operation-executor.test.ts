import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/connection.js';
import { OperationExecutor } from './operation-executor.js';
import type { MovieMovePlan } from '@reelkeeper/core';

async function createFixture() {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'reelkeeper-executor-'),
  );
  const libraryRoot = join(temporaryDirectory, 'movies');
  const dataDirectory = join(temporaryDirectory, 'data');
  await mkdir(libraryRoot);
  const database = openDatabase(dataDirectory);

  return {
    temporaryDirectory,
    libraryRoot,
    database,
    executor: new OperationExecutor(database, libraryRoot, dataDirectory),
  };
}

const looseFilePlan: MovieMovePlan = {
  status: 'ready',
  reviewReason: null,
  requiresApproval: true,
  operations: [
    { type: 'mkdir', to: 'Amber Coast (2004)' },
    {
      type: 'move',
      from: 'Amber.Coast.2004.mkv',
      to: 'Amber Coast (2004)/Amber Coast (2004).mkv',
    },
  ],
};

describe('OperationExecutor', () => {
  it('applies and reverses a logged batch in the correct order', async () => {
    const fixture = await createFixture();
    try {
      await writeFile(
        join(fixture.libraryRoot, 'Amber.Coast.2004.mkv'),
        'video bytes',
      );

      const batch = await fixture.executor.executePlan(looseFilePlan, true);
      expect(
        await readFile(
          join(
            fixture.libraryRoot,
            'Amber Coast (2004)',
            'Amber Coast (2004).mkv',
          ),
          'utf8',
        ),
      ).toBe('video bytes');

      await expect(
        fixture.executor.undoBatch(batch.batchId),
      ).resolves.toMatchObject({ status: 'undone' });
      expect(
        await readFile(
          join(fixture.libraryRoot, 'Amber.Coast.2004.mkv'),
          'utf8',
        ),
      ).toBe('video bytes');
      await expect(
        readdir(join(fixture.libraryRoot, 'Amber Coast (2004)')),
      ).rejects.toThrow();

      const storedBatch = fixture.database
        .prepare<[string], { status: string }>(
          'SELECT status FROM operation_batches WHERE id = ?',
        )
        .get(batch.batchId);
      expect(storedBatch?.status).toBe('undone');
    } finally {
      fixture.database.close();
      await rm(fixture.temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('requires explicit approval before applying a plan', async () => {
    const fixture = await createFixture();
    try {
      await expect(
        fixture.executor.executePlan(looseFilePlan, false),
      ).rejects.toThrow('Explicit approval is required');

      const batches = fixture.database
        .prepare<[], { count: number }>(
          'SELECT COUNT(*) AS count FROM operation_batches',
        )
        .get();
      expect(batches?.count).toBe(0);
    } finally {
      fixture.database.close();
      await rm(fixture.temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('writes and removes approved NFO/image files when undoing the batch', async () => {
    const fixture = await createFixture();
    const folder = join(fixture.libraryRoot, 'Amber Coast (2004)');
    try {
      await mkdir(folder);
      const batch = await fixture.executor.writeFiles(
        [
          {
            type: 'write_nfo',
            path: 'Amber Coast (2004)/Amber Coast (2004).nfo',
            content: '<movie><title>Amber Coast</title></movie>',
          },
          {
            type: 'write_image',
            path: 'Amber Coast (2004)/poster.jpg',
            content: new Uint8Array([0xff, 0xd8, 0xff]),
          },
        ],
        true,
      );

      expect(
        await readFile(join(folder, 'Amber Coast (2004).nfo'), 'utf8'),
      ).toContain('Amber Coast');
      expect(await readFile(join(folder, 'poster.jpg'))).toEqual(
        Buffer.from([0xff, 0xd8, 0xff]),
      );
      expect(
        fixture.database
          .prepare<[], { count: number }>(
            `SELECT COUNT(*) AS count FROM operations
             WHERE type IN ('write_nfo', 'write_image')
               AND output_hash IS NOT NULL`,
          )
          .get()?.count,
      ).toBe(2);

      await fixture.executor.undoBatch(batch.batchId);
      await expect(readFile(join(folder, 'poster.jpg'))).rejects.toThrow();
      await expect(
        readFile(join(folder, 'Amber Coast (2004).nfo')),
      ).rejects.toThrow();
    } finally {
      fixture.database.close();
      await rm(fixture.temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('backs up replaced files and refuses to overwrite edits during undo', async () => {
    const fixture = await createFixture();
    const folder = join(fixture.libraryRoot, 'Amber Coast (2004)');
    const nfoPath = join(folder, 'movie.nfo');
    try {
      await mkdir(folder);
      await writeFile(nfoPath, '<movie><title>My title</title></movie>');
      const batch = await fixture.executor.writeFiles(
        [
          {
            type: 'write_nfo',
            path: 'Amber Coast (2004)/movie.nfo',
            content: '<movie><title>TMDB title</title></movie>',
          },
        ],
        true,
      );

      expect(await readFile(nfoPath, 'utf8')).toContain('TMDB title');
      expect(
        fixture.database
          .prepare<[], { backup_exists: number; backup_path: string | null }>(
            'SELECT backup_exists, backup_path FROM operations',
          )
          .get(),
      ).toMatchObject({ backup_exists: 1 });
      await fixture.executor.undoBatch(batch.batchId);
      expect(await readFile(nfoPath, 'utf8')).toBe(
        '<movie><title>My title</title></movie>',
      );

      const nextBatch = await fixture.executor.writeFiles(
        [
          {
            type: 'write_nfo',
            path: 'Amber Coast (2004)/movie.nfo',
            content: '<movie><title>Another title</title></movie>',
          },
        ],
        true,
      );
      await writeFile(nfoPath, 'user edit');

      await expect(
        fixture.executor.undoBatch(nextBatch.batchId),
      ).rejects.toThrow('file changed after it was written');
      expect(await readFile(nfoPath, 'utf8')).toBe('user edit');
    } finally {
      fixture.database.close();
      await rm(fixture.temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('rolls back completed steps when a later filesystem operation fails', async () => {
    const fixture = await createFixture();
    const plan: MovieMovePlan = {
      ...looseFilePlan,
      operations: [
        { type: 'mkdir', to: 'Amber Coast (2004)' },
        ...looseFilePlan.operations.slice(1),
      ],
    };

    try {
      await expect(fixture.executor.executePlan(plan, true)).rejects.toThrow();
      expect(await readdir(fixture.libraryRoot)).toEqual([]);

      const storedBatch = fixture.database
        .prepare<[], { status: string }>('SELECT status FROM operation_batches')
        .get();
      expect(storedBatch?.status).toBe('failed');
    } finally {
      fixture.database.close();
      await rm(fixture.temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('refuses traversal paths before recording a batch', async () => {
    const fixture = await createFixture();
    const unsafePlan: MovieMovePlan = {
      ...looseFilePlan,
      operations: [
        { type: 'move', from: '../outside.mkv', to: 'safe/outside.mkv' },
      ],
    };

    try {
      await expect(
        fixture.executor.executePlan(unsafePlan, true),
      ).rejects.toThrow('Invalid relative movie-library path');
      const batches = fixture.database
        .prepare<[], { count: number }>(
          'SELECT COUNT(*) AS count FROM operation_batches',
        )
        .get();
      expect(batches?.count).toBe(0);
    } finally {
      fixture.database.close();
      await rm(fixture.temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('preserves user files and records partial undo when a source path is occupied', async () => {
    const fixture = await createFixture();
    try {
      await writeFile(
        join(fixture.libraryRoot, 'Amber.Coast.2004.mkv'),
        'original',
      );
      const batch = await fixture.executor.executePlan(looseFilePlan, true);
      await writeFile(
        join(fixture.libraryRoot, 'Amber.Coast.2004.mkv'),
        'user data',
      );

      await expect(fixture.executor.undoBatch(batch.batchId)).rejects.toThrow(
        'original path is occupied',
      );
      expect(
        await readFile(
          join(fixture.libraryRoot, 'Amber.Coast.2004.mkv'),
          'utf8',
        ),
      ).toBe('user data');
      const storedBatch = fixture.database
        .prepare<[string], { status: string }>(
          'SELECT status FROM operation_batches WHERE id = ?',
        )
        .get(batch.batchId);
      expect(storedBatch?.status).toBe('partial_undo');
    } finally {
      fixture.database.close();
      await rm(fixture.temporaryDirectory, { recursive: true, force: true });
    }
  });
});
