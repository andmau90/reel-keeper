import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanLibrary } from './library-scanner.js';

describe('scanLibrary', () => {
  it('scans loose files and one-level movie folders without recursion', async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), 'reelkeeper-scanner-'),
    );
    const libraryRoot = join(temporaryDirectory, 'movies');
    await mkdir(libraryRoot);

    try {
      await writeFile(join(libraryRoot, 'Amber.Coast.2004.mkv'), 'video');
      await writeFile(join(libraryRoot, 'Amber.Coast.2004.en.srt'), 'subtitle');
      await mkdir(join(libraryRoot, 'Existing Movie'));
      await writeFile(
        join(libraryRoot, 'Existing Movie', 'Existing Movie.mkv'),
        'video',
      );
      await writeFile(join(libraryRoot, 'Existing Movie', 'poster.jpg'), 'art');
      await mkdir(join(libraryRoot, 'Nested'));
      await mkdir(join(libraryRoot, 'Nested', 'Child'));
      await writeFile(
        join(libraryRoot, 'Nested', 'Child', 'Hidden.Movie.mkv'),
        'video',
      );

      const result = await scanLibrary(libraryRoot);

      expect(result.entries).toEqual([
        {
          kind: 'loose_file',
          sourcePath: 'Amber.Coast.2004.mkv',
          companions: ['Amber.Coast.2004.en.srt'],
        },
        {
          kind: 'existing_folder',
          folderPath: 'Existing Movie',
          videoPaths: ['Existing Movie/Existing Movie.mkv'],
          companions: ['Existing Movie/poster.jpg'],
        },
      ]);
      expect(result.existingPaths).toContain(
        'Existing Movie/Existing Movie.mkv',
      );
      expect(
        result.entries.some(
          (entry) =>
            entry.kind === 'loose_file' &&
            entry.sourcePath.includes('Hidden.Movie'),
        ),
      ).toBe(false);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('reports an unreadable root instead of silently returning an empty scan', async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), 'reelkeeper-scanner-'),
    );
    const missingRoot = join(temporaryDirectory, 'missing');

    try {
      await expect(scanLibrary(missingRoot)).rejects.toThrow();
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
