import { rankMovieCandidates, scoreMovieCandidate } from './match-scoring.js';
import type { ParsedMovieName } from './filename-parser.js';
import type { MovieCandidate } from './match-scoring.js';

const parsedMovie: ParsedMovieName = {
  title: 'Amelie',
  year: 2001,
  extension: 'mkv',
  reviewReason: null,
};

describe('scoreMovieCandidate', () => {
  it('gives an exact title and year the maximum score', () => {
    expect(
      scoreMovieCandidate(parsedMovie, {
        id: 1,
        title: 'Amélie',
        year: 2001,
      }),
    ).toEqual({
      candidate: { id: 1, title: 'Amélie', year: 2001 },
      titleScore: 100,
      score: 100,
      yearMatch: 'exact',
    });
  });

  it('lowers confidence when the candidate year conflicts', () => {
    const result = scoreMovieCandidate(parsedMovie, {
      id: 2,
      title: 'Amélie',
      year: 2010,
    });

    expect(result.titleScore).toBe(100);
    expect(result.score).toBe(60);
    expect(result.yearMatch).toBe('mismatch');
  });

  it('does not penalize a missing candidate year', () => {
    const result = scoreMovieCandidate(parsedMovie, {
      id: 3,
      title: 'Amélie',
    });

    expect(result.score).toBe(80);
    expect(result.yearMatch).toBe('unknown');
  });

  it('ranks the matching year first and preserves ties', () => {
    const candidates: MovieCandidate[] = [
      { id: 1, title: 'Amélie', year: 2010 },
      { id: 2, title: 'Amélie', year: 2001 },
      { id: 3, title: 'Amelie', year: 2001 },
    ];

    expect(
      rankMovieCandidates(parsedMovie, candidates).map(
        ({ candidate }) => candidate.id,
      ),
    ).toEqual([2, 3, 1]);
  });
});
