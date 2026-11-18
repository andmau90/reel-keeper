import type { ParsedMovieName } from './filename-parser.js';

/**
 * A movie result returned by a metadata provider.
 */
export interface MovieCandidate {
  /** Provider-specific movie identifier. */
  id: number;
  /** Localized or original movie title. */
  title: string;
  /** Alternate title used when comparing a filename with metadata. */
  originalTitle?: string | null;
  /** Release year when the provider supplies one. */
  year?: number | null;
}

/**
 * Describes whether the candidate's year agrees with the parsed filename.
 */
export type YearMatch = 'exact' | 'mismatch' | 'unknown';

/**
 * A candidate together with its title and combined match scores.
 */
export interface ScoredMovieCandidate {
  /** The original metadata candidate. */
  candidate: MovieCandidate;
  /** Title similarity from 0 to 100. */
  titleScore: number;
  /** Combined title and year score from 0 to 100. */
  score: number;
  /** Year comparison result. */
  yearMatch: YearMatch;
}

/**
 * Scores one metadata candidate against a parsed movie filename.
 *
 * Title similarity combines token overlap and edit distance. A known exact
 * year adds confidence, while a known conflicting year lowers the score.
 *
 * @param movie The parsed title and year from the filename.
 * @param candidate A candidate returned by a metadata provider.
 * @returns The candidate with component and combined scores.
 */
export function scoreMovieCandidate(
  movie: ParsedMovieName,
  candidate: MovieCandidate,
): ScoredMovieCandidate {
  const titleScore = Math.max(
    calculateTitleSimilarity(movie.title, candidate.title),
    candidate.originalTitle
      ? calculateTitleSimilarity(movie.title, candidate.originalTitle)
      : 0,
  );
  const yearMatch: YearMatch =
    movie.year === null || candidate.year == null
      ? 'unknown'
      : movie.year === candidate.year
        ? 'exact'
        : 'mismatch';
  const yearAdjustment =
    yearMatch === 'exact' ? 20 : yearMatch === 'mismatch' ? -20 : 0;
  const score = Math.max(
    0,
    Math.min(100, Math.round(titleScore * 0.8 + yearAdjustment)),
  );

  return { candidate, titleScore, score, yearMatch };
}

/**
 * Scores and sorts candidates from the strongest match to the weakest.
 *
 * Candidate order is preserved for equal scores, which makes ranking stable
 * when a provider returns ties.
 *
 * @param movie The parsed title and year from the filename.
 * @param candidates Metadata candidates to score.
 * @returns Candidates sorted by descending match score.
 */
export function rankMovieCandidates(
  movie: ParsedMovieName,
  candidates: MovieCandidate[],
): ScoredMovieCandidate[] {
  return candidates
    .map((candidate, index) => ({
      result: scoreMovieCandidate(movie, candidate),
      index,
    }))
    .sort(
      (left, right) =>
        right.result.score - left.result.score || left.index - right.index,
    )
    .map(({ result }) => result);
}

function calculateTitleSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeTitle(left);
  const normalizedRight = normalizeTitle(right);

  if (!normalizedLeft || !normalizedRight) {
    return 0;
  }

  if (normalizedLeft === normalizedRight) {
    return 100;
  }

  const leftTokens = new Set(normalizedLeft.split(' '));
  const rightTokens = new Set(normalizedRight.split(' '));
  const sharedTokenCount = [...leftTokens].filter((token) =>
    rightTokens.has(token),
  ).length;
  const tokenDice =
    (2 * sharedTokenCount) / (leftTokens.size + rightTokens.size);
  const editSimilarity =
    1 -
    levenshteinDistance(normalizedLeft, normalizedRight) /
      Math.max(normalizedLeft.length, normalizedRight.length);

  return Math.round((tokenDice * 0.7 + editSimilarity * 0.3) * 100);
}

function normalizeTitle(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function levenshteinDistance(left: string, right: string): number {
  const leftCharacters = Array.from(left);
  const rightCharacters = Array.from(right);
  let previousRow = Array.from(
    { length: rightCharacters.length + 1 },
    (_, index) => index,
  );

  for (let leftIndex = 0; leftIndex < leftCharacters.length; leftIndex += 1) {
    const currentRow = [leftIndex + 1];

    for (
      let rightIndex = 0;
      rightIndex < rightCharacters.length;
      rightIndex += 1
    ) {
      const substitutionCost =
        leftCharacters[leftIndex] === rightCharacters[rightIndex] ? 0 : 1;
      currentRow.push(
        Math.min(
          (previousRow[rightIndex + 1] ?? 0) + 1,
          (currentRow[rightIndex] ?? 0) + 1,
          (previousRow[rightIndex] ?? 0) + substitutionCost,
        ),
      );
    }

    previousRow = currentRow;
  }

  return previousRow[rightCharacters.length] ?? 0;
}
