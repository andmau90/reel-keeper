import { parseMovieFilename } from '@reelkeeper/core';
import { rankMovieCandidates } from '@reelkeeper/core';
import type {
  MovieCandidate,
  ParsedMovieName,
  ScoredMovieCandidate,
} from '@reelkeeper/core';

/**
 * Describes the provider capability required by the movie recognizer.
 */
export interface MovieSearchProvider {
  /**
   * Searches metadata candidates by title and optional release year.
   *
   * @param query Parsed movie title.
   * @param year Parsed release year, when known.
   * @returns Candidates returned by a metadata provider.
   */
  searchMovies(query: string, year?: number): Promise<MovieCandidate[]>;
}

/**
 * Contains parsed input and ranked candidates for a movie filename.
 */
export interface MovieRecognitionResult {
  /** Parsed title and year, or null when no title could be extracted. */
  parsed: ParsedMovieName | null;
  /** Ranked candidates for manual selection. */
  candidates: ScoredMovieCandidate[];
  /** Indicates whether candidates are available or the item needs review. */
  status: 'candidates_found' | 'needs_review';
  /** Reason for manual review, or null when candidates were found. */
  reviewReason:
    | 'ambiguous_year'
    | 'missing_year'
    | 'no_candidates'
    | 'unparseable_filename'
    | null;
}

/**
 * Parses a filename, searches TMDB, and ranks candidates without auto-applying.
 *
 * @param filename Movie filename to recognize.
 * @param provider Metadata search provider.
 * @returns Ranked candidate results or a review outcome.
 */
export async function recognizeMovieFilename(
  filename: string,
  provider: MovieSearchProvider,
): Promise<MovieRecognitionResult> {
  const parsed = parseMovieFilename(filename);
  if (!parsed) {
    return {
      parsed: null,
      candidates: [],
      status: 'needs_review',
      reviewReason: 'unparseable_filename',
    };
  }

  const candidates = rankMovieCandidates(
    parsed,
    await provider.searchMovies(parsed.title, parsed.year ?? undefined),
  );

  if (parsed.reviewReason || candidates.length === 0) {
    return {
      parsed,
      candidates,
      status: 'needs_review',
      reviewReason: parsed.reviewReason ?? 'no_candidates',
    };
  }

  return {
    parsed,
    candidates,
    status: 'candidates_found',
    reviewReason: null,
  };
}
