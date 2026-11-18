import { formatMovieFolderName, planMove } from './move-planner.js';
import type { MoviePlacementRequest } from '@reelkeeper/shared';

const movie = { title: 'The: Amber Coast?', year: 2004 };
const folderName = 'The - Amber Coast- (2004)';

describe('formatMovieFolderName', () => {
  it('replaces invalid SMB characters using the configured mapping', () => {
    expect(formatMovieFolderName(movie.title, movie.year)).toBe(folderName);
  });
});

describe('planMove', () => {
  it('moves a loose movie and its linked subtitle into a new folder', () => {
    const input: MoviePlacementRequest = {
      kind: 'loose_file',
      sourcePath: 'Amber.Coast.2004.1080p.mkv',
      movie: { title: 'Amber Coast', year: 2004 },
      companions: ['Amber.Coast.2004.1080p.en.srt'],
      existingPaths: [
        'Amber.Coast.2004.1080p.mkv',
        'Amber.Coast.2004.1080p.en.srt',
      ],
    };

    expect(planMove(input)).toEqual({
      status: 'ready',
      reviewReason: null,
      requiresApproval: true,
      operations: [
        { type: 'mkdir', to: 'Amber Coast (2004)' },
        {
          type: 'move',
          from: 'Amber.Coast.2004.1080p.mkv',
          to: 'Amber Coast (2004)/Amber Coast (2004).mkv',
        },
        {
          type: 'move',
          from: 'Amber.Coast.2004.1080p.en.srt',
          to: 'Amber Coast (2004)/Amber Coast (2004).en.srt',
        },
      ],
    });
  });

  it('renames an existing folder before renaming its files', () => {
    const input: MoviePlacementRequest = {
      kind: 'existing_folder',
      folderPath: 'Old Amber',
      videoPaths: ['Old Amber/rough-cut.mkv'],
      movie: { title: 'Amber Coast', year: 2004 },
      companions: ['Old Amber/rough-cut.ita.srt'],
      existingPaths: [
        'Old Amber',
        'Old Amber/rough-cut.mkv',
        'Old Amber/rough-cut.ita.srt',
      ],
    };

    expect(planMove(input)).toMatchObject({
      status: 'ready',
      requiresApproval: true,
      operations: [
        {
          type: 'rename',
          from: 'Old Amber',
          to: 'Amber Coast (2004)',
        },
        {
          type: 'rename',
          from: 'Amber Coast (2004)/rough-cut.mkv',
          to: 'Amber Coast (2004)/Amber Coast (2004).mkv',
        },
        {
          type: 'rename',
          from: 'Amber Coast (2004)/rough-cut.ita.srt',
          to: 'Amber Coast (2004)/Amber Coast (2004).ita.srt',
        },
      ],
    });
  });

  it('returns no operations when a folder and its video are already canonical', () => {
    const input: MoviePlacementRequest = {
      kind: 'existing_folder',
      folderPath: 'Amber Coast (2004)',
      videoPaths: ['Amber Coast (2004)/Amber Coast (2004).mkv'],
      movie: { title: 'Amber Coast', year: 2004 },
      companions: ['Amber Coast (2004)/Amber Coast (2004).nfo'],
      existingPaths: [
        'Amber Coast (2004)',
        'Amber Coast (2004)/Amber Coast (2004).mkv',
        'Amber Coast (2004)/Amber Coast (2004).nfo',
      ],
    };

    expect(planMove(input)).toEqual({
      status: 'no_op',
      reviewReason: null,
      requiresApproval: false,
      operations: [],
    });
  });

  it('keeps folder-level artwork with an existing movie folder', () => {
    const input: MoviePlacementRequest = {
      kind: 'existing_folder',
      folderPath: 'Amber Coast (2004)',
      videoPaths: ['Amber Coast (2004)/Amber Coast (2004).mkv'],
      movie: { title: 'Amber Coast', year: 2004 },
      companions: [
        'Amber Coast (2004)/poster.jpg',
        'Amber Coast (2004)/fanart.jpg',
      ],
      existingPaths: [
        'Amber Coast (2004)',
        'Amber Coast (2004)/Amber Coast (2004).mkv',
        'Amber Coast (2004)/poster.jpg',
        'Amber Coast (2004)/fanart.jpg',
      ],
    };

    expect(planMove(input).status).toBe('no_op');
  });

  it('routes a missing release year to review', () => {
    const input: MoviePlacementRequest = {
      kind: 'loose_file',
      sourcePath: 'Amber.Coast.mkv',
      movie: { title: 'Amber Coast', year: null },
    };

    expect(planMove(input)).toMatchObject({
      status: 'review',
      reviewReason: 'missing_year',
      operations: [],
    });
  });

  it('marks case-only directory renames for an intermediate name', () => {
    const input: MoviePlacementRequest = {
      kind: 'existing_folder',
      folderPath: 'amber coast (2004)',
      videoPaths: ['amber coast (2004)/Amber Coast (2004).mkv'],
      movie: { title: 'Amber Coast', year: 2004 },
      existingPaths: [
        'amber coast (2004)',
        'amber coast (2004)/Amber Coast (2004).mkv',
      ],
    };

    expect(planMove(input).operations[0]).toEqual({
      type: 'rename',
      from: 'amber coast (2004)',
      to: 'Amber Coast (2004)',
      requiresIntermediateRename: true,
    });
  });

  it('reviews folders containing multiple videos', () => {
    const input: MoviePlacementRequest = {
      kind: 'existing_folder',
      folderPath: 'Old Amber',
      videoPaths: ['Old Amber/one.mkv', 'Old Amber/two.mp4'],
      movie: { title: 'Amber Coast', year: 2004 },
    };

    expect(planMove(input)).toMatchObject({
      status: 'review',
      reviewReason: 'multiple_videos',
      operations: [],
    });
  });

  it('reviews unlinked companions and pre-existing destinations', () => {
    const unmatchedCompanion: MoviePlacementRequest = {
      kind: 'loose_file',
      sourcePath: 'Amber.Coast.2004.mkv',
      movie: { title: 'Amber Coast', year: 2004 },
      companions: ['unrelated.en.srt'],
    };
    const occupiedDestination: MoviePlacementRequest = {
      kind: 'loose_file',
      sourcePath: 'Amber.Coast.2004.mkv',
      movie: { title: 'Amber Coast', year: 2004 },
      existingPaths: ['Amber.Coast.2004.mkv', 'Amber Coast (2004)'],
    };

    expect(planMove(unmatchedCompanion).reviewReason).toBe(
      'unmatched_companion',
    );
    expect(planMove(occupiedDestination).reviewReason).toBe(
      'destination_exists',
    );
  });

  it('reviews nested or unsafe paths instead of escaping the library root', () => {
    const nestedFile: MoviePlacementRequest = {
      kind: 'loose_file',
      sourcePath: 'nested/Amber.Coast.2004.mkv',
      movie: { title: 'Amber Coast', year: 2004 },
    };
    const traversal: MoviePlacementRequest = {
      kind: 'loose_file',
      sourcePath: '../outside.mkv',
      movie: { title: 'Amber Coast', year: 2004 },
    };

    expect(planMove(nestedFile).reviewReason).toBe('ambiguous_layout');
    expect(planMove(traversal).reviewReason).toBe('invalid_path');
  });
});
