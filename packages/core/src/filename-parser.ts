const VIDEO_EXTENSION =
  /\.(mkv|mp4|avi|mov|wmv|m4v|mpg|mpeg|ts|m2ts|webm|flv|ogv|3gp)$/i;
const YEAR_TOKEN =
  /(?:^|[\s._-])((?:18[89]\d|19\d{2}|20\d{2}))(?!\d)(?=$|[\s._-])/g;
const PARENTHESIZED_YEAR =
  /(?:\(|\[)\s*((?:18[89]\d|19\d{2}|20\d{2}))\s*(?:\)|\])/g;
const RELEASE_METADATA =
  /\b(?:480p|576p|720p|1080p|1440p|2160p|4320p|4k|8k|blu[\s._-]?ray|web[\s._-]?(?:dl|rip)|hdtv|dvdrip|brrip|bdrip|hdrip|remux|x26[45]|h\.?26[45]|hevc|av1|hdr10?|proper|repack|limited|internal|aac|dts|ddp\d*)\b/i;

/**
 * Explains why a parsed filename should be reviewed before matching.
 */
export type ParseReviewReason = 'missing_year' | 'ambiguous_year' | null;

/**
 * Contains the title information extracted from a movie filename.
 */
export interface ParsedMovieName {
  /** Normalized title text with release separators converted to spaces. */
  title: string;
  /** Release year, or null when it is missing or ambiguous. */
  year: number | null;
  /** Lowercase video extension without the dot, or null when absent. */
  extension: string | null;
  /** Indicates that a human should verify the missing or ambiguous year. */
  reviewReason: ParseReviewReason;
}

interface YearOccurrence {
  year: number;
  start: number;
}

/**
 * Extracts a movie title, year, and video extension from a noisy filename.
 *
 * A filename with no reliable title returns null. Missing or conflicting years
 * remain explicit in the result so callers can route them to manual review.
 *
 * @param input The movie filename, optionally including a directory path.
 * @returns Parsed filename details, or null when no title can be extracted.
 */
export function parseMovieFilename(input: string): ParsedMovieName | null {
  const filename = input.trim().split(/[\\/]/).at(-1) ?? '';
  if (!filename) {
    return null;
  }

  const extensionMatch = filename.match(VIDEO_EXTENSION);
  const extension = extensionMatch?.[1]?.toLowerCase() ?? null;
  const stem = extensionMatch
    ? filename.slice(0, -extensionMatch[0].length)
    : filename;

  if (!stem.trim()) {
    return null;
  }

  const occurrences = findYearOccurrences(stem);
  const validParenthesized = findParenthesizedYears(stem);
  const candidates =
    validParenthesized.length > 0
      ? validParenthesized
      : occurrences.filter((occurrence) => occurrence.start > 0);

  const distinctYears = new Set(candidates.map(({ year }) => year));
  const selectedYear = distinctYears.size === 1 ? candidates[0] : undefined;
  const ambiguous = distinctYears.size > 1;
  const titleEnd =
    selectedYear?.start ??
    (ambiguous ? candidates[0]?.start : undefined) ??
    releaseMetadataStart(stem);
  const title = normalizeFilenameTitle(stem.slice(0, titleEnd ?? stem.length));

  if (!title) {
    return null;
  }

  const reviewReason: ParseReviewReason = ambiguous
    ? 'ambiguous_year'
    : selectedYear
      ? null
      : 'missing_year';

  return {
    title,
    year: selectedYear?.year ?? null,
    extension,
    reviewReason,
  };
}

function findYearOccurrences(stem: string): YearOccurrence[] {
  const currentYear = new Date().getFullYear();
  const latestPlausibleYear = currentYear + 2;

  return Array.from(stem.matchAll(YEAR_TOKEN), (match) => {
    const year = Number(match[1]);
    const start = match.index ?? 0;
    const tokenStart = start + match[0].indexOf(match[1] ?? '');
    return {
      year,
      start: tokenStart,
    };
  }).filter(
    ({ year, start }) =>
      year >= 1888 && year <= latestPlausibleYear && start > 0,
  );
}

function findParenthesizedYears(stem: string): YearOccurrence[] {
  const currentYear = new Date().getFullYear();
  const latestPlausibleYear = currentYear + 2;

  return Array.from(stem.matchAll(PARENTHESIZED_YEAR), (match) => {
    const year = Number(match[1]);
    const start = match.index ?? 0;
    return {
      year,
      start,
    };
  }).filter(({ year }) => year >= 1888 && year <= latestPlausibleYear);
}

function releaseMetadataStart(stem: string): number | undefined {
  return RELEASE_METADATA.exec(stem)?.index;
}

function normalizeFilenameTitle(value: string): string {
  return value
    .replace(/[._]/g, ' ')
    .replace(/[\s-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
