import {
  recognizeMovieFilename,
  type MovieSearchProvider,
} from './recognizer.js';

describe('recognizeMovieFilename', () => {
  it('searches and ranks candidates for a parsed title and year', async () => {
    const requested: Array<{ query: string; year?: number }> = [];
    const provider: MovieSearchProvider = {
      async searchMovies(query, year) {
        requested.push({ query, year });
        return [
          { id: 1, title: 'Amber Coast', year: 2004 },
          { id: 2, title: 'Amber Coast', year: 2010 },
        ];
      },
    };

    const result = await recognizeMovieFilename(
      'Amber.Coast.2004.1080p.mkv',
      provider,
    );

    expect(requested).toEqual([{ query: 'Amber Coast', year: 2004 }]);
    expect(result.status).toBe('candidates_found');
    expect(result.candidates.map(({ candidate }) => candidate.id)).toEqual([
      1, 2,
    ]);
  });

  it('keeps missing-year results in manual review', async () => {
    const provider: MovieSearchProvider = {
      async searchMovies() {
        return [{ id: 1, title: 'Blade Runner 2049', year: 2017 }];
      },
    };

    const result = await recognizeMovieFilename(
      'Blade Runner 2049.mkv',
      provider,
    );

    expect(result.status).toBe('needs_review');
    expect(result.reviewReason).toBe('missing_year');
    expect(result.candidates).toHaveLength(1);
  });

  it('returns review results for unparseable filenames and empty searches', async () => {
    const provider: MovieSearchProvider = {
      async searchMovies() {
        return [];
      },
    };

    await expect(
      recognizeMovieFilename('   ', provider),
    ).resolves.toMatchObject({
      status: 'needs_review',
      reviewReason: 'unparseable_filename',
      candidates: [],
    });
    await expect(
      recognizeMovieFilename('Amber Coast 2004.mkv', provider),
    ).resolves.toMatchObject({
      status: 'needs_review',
      reviewReason: 'no_candidates',
      candidates: [],
    });
  });
});
