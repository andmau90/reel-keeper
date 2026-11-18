import type {
  MovieMetadataEditValues,
  MovieMetadataValues,
} from '@reelkeeper/shared';
import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';

const ARRAY_TAGS = new Set([
  'actor',
  'director',
  'genre',
  'studio',
  'uniqueid',
]);

const parser = new XMLParser({
  attributeNamePrefix: '@_',
  ignoreAttributes: false,
  isArray: (tagName) => ARRAY_TAGS.has(tagName),
  parseTagValue: false,
  trimValues: true,
});

const builder = new XMLBuilder({
  attributeNamePrefix: '@_',
  format: true,
  ignoreAttributes: false,
  suppressBooleanAttributes: false,
  suppressEmptyNode: false,
});

/**
 * Fields populated from TMDB and eligible for a user lock.
 */
export type KodiNfoField =
  | 'title'
  | 'originalTitle'
  | 'year'
  | 'releaseDate'
  | 'plot'
  | 'tagline'
  | 'runtime'
  | 'genres'
  | 'studios'
  | 'directors'
  | 'actors'
  | 'rating';

/**
 * TMDB values mapped into Kodi's movie NFO structure.
 */
export interface KodiNfoMetadata {
  tmdbId: number;
  title: string;
  originalTitle: string;
  year: number | null;
  releaseDate: string | null;
  plot: string;
  tagline: string;
  runtime: number | null;
  genres: string[];
  studios: string[];
  directors: string[];
  actors: Array<{ name: string; character: string }>;
  voteAverage: number | null;
  voteCount: number | null;
}

/**
 * Parsed editable values and TMDB identity from a Kodi movie NFO.
 */
export interface KodiNfoDocument {
  tmdbId: number | null;
  metadata: MovieMetadataValues;
}

/**
 * Reads editable metadata from a Kodi NFO, defaulting missing values to empty.
 *
 * @param xml Existing NFO contents, or null when no NFO exists.
 * @returns Parsed editable fields and the TMDB identifier.
 * @throws If the existing NFO is malformed or has no movie root.
 */
export function readKodiNfo(xml: string | null): KodiNfoDocument {
  const movie = xml ? parseMovie(xml) : {};
  const tmdbId = toArray(movie['uniqueid']).find(
    (id) => isRecord(id) && String(id['@_type']).toLowerCase() === 'tmdb',
  );
  return {
    tmdbId:
      tmdbId && isRecord(tmdbId)
        ? positiveInteger(readText(tmdbId['#text']))
        : null,
    metadata: {
      title: readText(movie['title']),
      originalTitle: readText(movie['originaltitle']),
      year: positiveInteger(readText(movie['year'])),
      releaseDate: readText(movie['premiered']) || null,
      plot: readText(movie['plot']),
      tagline: readText(movie['tagline']),
      runtime: positiveInteger(readText(movie['runtime'])),
      genres: readTextArray(movie['genre']),
      studios: readTextArray(movie['studio']),
      directors: readTextArray(movie['director']),
      actors: toArray(movie['actor'])
        .filter(isRecord)
        .map((actor) => ({
          name: readText(actor['name']),
          character: readText(actor['role']),
        }))
        .filter((actor) => actor.name.length > 0),
    },
  };
}

/**
 * Merges TMDB metadata into a Kodi NFO while retaining unrelated XML content.
 *
 * @param existingXml Existing NFO contents, or null when creating a new file.
 * @param metadata Metadata selected from TMDB.
 * @param lockedFields Fields that must remain as currently written.
 * @returns Formatted Kodi movie XML.
 * @throws If the existing NFO is malformed or has no movie root.
 */
export function mergeKodiNfo(
  existingXml: string | null,
  metadata: KodiNfoMetadata,
  lockedFields: readonly KodiNfoField[] = [],
): string {
  const movie = existingXml ? parseMovie(existingXml) : {};
  const locked = new Set(lockedFields);

  setValue(movie, 'title', 'title', metadata.title, locked);
  setValue(
    movie,
    'originaltitle',
    'originalTitle',
    metadata.originalTitle,
    locked,
  );
  setValue(movie, 'year', 'year', metadata.year, locked);
  setValue(movie, 'premiered', 'releaseDate', metadata.releaseDate, locked);
  setValue(movie, 'plot', 'plot', metadata.plot, locked);
  setValue(movie, 'tagline', 'tagline', metadata.tagline, locked);
  setValue(movie, 'runtime', 'runtime', metadata.runtime, locked);
  setArray(movie, 'genre', 'genres', metadata.genres, locked);
  setArray(movie, 'studio', 'studios', metadata.studios, locked);
  setArray(movie, 'director', 'directors', metadata.directors, locked);
  setActors(movie, metadata.actors, locked);
  setRating(movie, metadata, locked);
  setTmdbId(movie, metadata.tmdbId);

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${builder.build({ movie })}`;
}

/**
 * Applies explicitly edited fields to a merged Kodi NFO.
 *
 * @param xml Valid merged Kodi NFO XML.
 * @param edits Fields explicitly changed by the user.
 * @returns Updated Kodi movie XML.
 * @throws If the NFO is malformed or has no movie root.
 */
export function applyKodiNfoEdits(
  xml: string,
  edits: MovieMetadataEditValues,
): string {
  const movie = parseMovie(xml);
  setEditedValue(movie, 'title', edits.title);
  setEditedValue(movie, 'originaltitle', edits.originalTitle);
  setEditedValue(movie, 'year', edits.year);
  setEditedValue(movie, 'premiered', edits.releaseDate);
  setEditedValue(movie, 'plot', edits.plot);
  setEditedValue(movie, 'tagline', edits.tagline);
  setEditedValue(movie, 'runtime', edits.runtime);
  setEditedArray(movie, 'genre', edits.genres);
  setEditedArray(movie, 'studio', edits.studios);
  setEditedArray(movie, 'director', edits.directors);
  if (edits.actors !== undefined) {
    const actors = edits.actors
      .filter((actor) => actor.name.trim().length > 0)
      .map((actor) => ({
        name: actor.name.trim(),
        role: actor.character.trim(),
      }));
    if (actors.length > 0) {
      movie['actor'] = actors;
    } else {
      delete movie['actor'];
    }
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${builder.build({ movie })}`;
}

function parseMovie(xml: string): Record<string, unknown> {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new Error(
      `The existing Kodi NFO is invalid XML: ${validation.err.msg}.`,
    );
  }

  const parsed: unknown = parser.parse(xml);
  if (!isRecord(parsed) || !isRecord(parsed['movie'])) {
    throw new Error('The existing Kodi NFO must have a <movie> root element.');
  }
  return parsed['movie'];
}

function setEditedValue(
  movie: Record<string, unknown>,
  tag: string,
  value: string | number | null | undefined,
): void {
  if (value === undefined) {
    return;
  }
  if (value === null || (typeof value === 'string' && !value.trim())) {
    delete movie[tag];
    return;
  }
  movie[tag] = String(value).trim();
}

function setEditedArray(
  movie: Record<string, unknown>,
  tag: string,
  values: string[] | undefined,
): void {
  if (values === undefined) {
    return;
  }
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  if (normalized.length > 0) {
    movie[tag] = normalized;
  } else {
    delete movie[tag];
  }
}

function readText(value: unknown): string {
  if (isRecord(value)) {
    return readText(value['#text']);
  }
  return value === undefined || value === null ? '' : String(value).trim();
}

function readTextArray(value: unknown): string[] {
  return toArray(value)
    .map(readText)
    .filter((entry) => entry.length > 0);
}

function positiveInteger(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function setValue(
  movie: Record<string, unknown>,
  tag: string,
  field: KodiNfoField,
  value: string | number | null,
  locked: ReadonlySet<KodiNfoField>,
): void {
  if (locked.has(field) || value === null || value === '') {
    return;
  }
  movie[tag] = String(value);
}

function setArray(
  movie: Record<string, unknown>,
  tag: string,
  field: KodiNfoField,
  values: string[],
  locked: ReadonlySet<KodiNfoField>,
): void {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  if (locked.has(field) || normalized.length === 0) {
    return;
  }
  movie[tag] = normalized;
}

function setActors(
  movie: Record<string, unknown>,
  actors: KodiNfoMetadata['actors'],
  locked: ReadonlySet<KodiNfoField>,
): void {
  if (locked.has('actors') || actors.length === 0) {
    return;
  }
  movie['actor'] = actors
    .filter((actor) => actor.name.trim().length > 0)
    .map((actor) => ({
      name: actor.name.trim(),
      role: actor.character.trim(),
    }));
}

function setRating(
  movie: Record<string, unknown>,
  metadata: KodiNfoMetadata,
  locked: ReadonlySet<KodiNfoField>,
): void {
  if (locked.has('rating') || metadata.voteAverage === null) {
    return;
  }

  const ratings = isRecord(movie['ratings']) ? movie['ratings'] : {};
  const existing = toArray(ratings['rating']);
  const otherRatings = existing.filter(
    (rating) =>
      !isRecord(rating) ||
      String(rating['@_name'] ?? '').toLowerCase() !== 'themoviedb',
  );
  ratings['rating'] = [
    ...otherRatings,
    {
      '@_name': 'themoviedb',
      '@_max': '10',
      '@_default': 'true',
      value: String(metadata.voteAverage),
      votes: String(metadata.voteCount ?? 0),
    },
  ];
  movie['ratings'] = ratings;
}

function setTmdbId(movie: Record<string, unknown>, tmdbId: number): void {
  const ids = toArray(movie['uniqueid']);
  const index = ids.findIndex(
    (id) => isRecord(id) && String(id['@_type']).toLowerCase() === 'tmdb',
  );
  const tmdbValue = {
    ...(index >= 0 && isRecord(ids[index]) ? ids[index] : {}),
    '@_type': 'tmdb',
    '@_default': 'true',
    '#text': String(tmdbId),
  };
  if (index >= 0) {
    ids[index] = tmdbValue;
  } else {
    ids.push(tmdbValue);
  }
  movie['uniqueid'] = ids;
}

function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
