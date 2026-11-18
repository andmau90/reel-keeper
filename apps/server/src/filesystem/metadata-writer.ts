import { lstat, readFile, realpath } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import {
  KodiNfoFieldSchema,
  MovieMetadataEditValuesSchema,
} from '@reelkeeper/shared';
import type {
  MovieMetadataEditValues,
  MovieMetadataValues,
} from '@reelkeeper/shared';
import {
  applyKodiNfoEdits,
  mergeKodiNfo,
  readKodiNfo,
  type KodiNfoField,
  type KodiNfoMetadata,
} from '../kodi-nfo.js';
import type { SqliteDatabase } from '../db/connection.js';
import type { TmdbClient } from '../tmdb-client.js';
import type { OperationBatchResult } from './operation-executor.js';
import { OperationExecutor } from './operation-executor.js';

const ARTWORK_NAMES = {
  poster: 'poster.jpg',
  fanart: 'fanart.jpg',
} as const;

/**
 * Identifies a movie and the user-approved metadata refresh options.
 */
export interface RefreshMovieMetadataRequest {
  /** TMDB movie selected by the user. */
  tmdbId: number;
  /** Movie video path, relative to the library root. */
  videoPath: string;
  /** Fields retained from the existing NFO during refresh. */
  lockedFields?: readonly KodiNfoField[];
  /** Replaces existing canonical artwork when true and approved. */
  replaceArtwork?: boolean;
}

/**
 * Describes a user's approved NFO metadata edits.
 */
export interface EditMovieMetadataRequest {
  /** TMDB movie selected by the user. */
  tmdbId: number;
  /** Movie video path, relative to the library root. */
  videoPath: string;
  /** Explicitly edited metadata fields. */
  metadata: MovieMetadataEditValues;
  /** Fields retained from future TMDB refreshes. */
  lockedFields: readonly KodiNfoField[];
}

/**
 * Current NFO values and persisted field-lock configuration.
 */
export interface CurrentMovieMetadata {
  tmdbId: number | null;
  lockedFields: KodiNfoField[];
  metadata: MovieMetadataValues;
}

/**
 * Fetches metadata and applies an approval-gated NFO/artwork refresh.
 */
export class MovieMetadataWriter {
  private readonly database: SqliteDatabase;
  private readonly libraryRoot: string;
  private readonly tmdb: TmdbClient;
  private readonly executor: OperationExecutor;

  /**
   * Creates the metadata writer.
   *
   * @param libraryRoot Absolute movie-library root.
   * @param tmdb Authenticated TMDB client.
   * @param executor Reversible filesystem operation executor.
   */
  constructor(
    database: SqliteDatabase,
    libraryRoot: string,
    tmdb: TmdbClient,
    executor: OperationExecutor,
  ) {
    this.database = database;
    this.libraryRoot = libraryRoot;
    this.tmdb = tmdb;
    this.executor = executor;
  }

  /**
   * Creates a Kodi NFO and missing artwork, or explicitly replaces artwork.
   *
   * Existing artwork is preserved unless replaceArtwork is true. Every
   * resulting filesystem change still requires explicit approval.
   *
   * @param request Selected movie and refresh options.
   * @param approved Explicit approval for the resulting file writes.
   * @returns The reversible operation batch.
   * @throws If approval is absent, source paths are unsafe, or requests fail.
   */
  async refresh(
    request: RefreshMovieMetadataRequest,
    approved: boolean,
  ): Promise<OperationBatchResult> {
    if (!approved) {
      throw new Error('Explicit approval is required before changing files.');
    }

    const root = await realpath(this.libraryRoot);
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory()) {
      throw new Error('The configured movie-library root is not a directory.');
    }
    const { folder, videoName } = parseVideoPath(request.videoPath);
    const folderPath = resolve(root, folder);
    const folderInfo = await lstat(folderPath);
    if (folderInfo.isSymbolicLink() || !folderInfo.isDirectory()) {
      throw new Error(`Unsafe movie folder: ${folder}`);
    }

    const videoPath = resolve(folderPath, videoName);
    const videoInfo = await lstat(videoPath);
    if (videoInfo.isSymbolicLink() || !videoInfo.isFile()) {
      throw new Error(
        `Movie video is not a regular file: ${request.videoPath}`,
      );
    }

    const details = await this.tmdb.getMovieDetails(request.tmdbId);
    const nfoPath = `${folder}/${videoStem(videoName)}.nfo`;
    const nfoAbsolutePath = resolve(folderPath, `${videoStem(videoName)}.nfo`);
    const existingNfo = await readOptionalTextFile(nfoAbsolutePath, nfoPath);
    const storedState = this.getStoredState(request.videoPath);
    const nfo = mergeKodiNfo(existingNfo, toKodiMetadata(details), [
      ...new Set([
        ...(storedState?.lockedFields ?? []),
        ...(request.lockedFields ?? []),
      ]),
    ]);

    const writes: Array<{
      type: 'write_nfo' | 'write_image';
      path: string;
      content: string | Uint8Array;
    }> = [{ type: 'write_nfo', path: nfoPath, content: nfo }];

    const replaceArtwork = request.replaceArtwork ?? false;
    if (details.posterPath) {
      const path = `${folder}/${ARTWORK_NAMES.poster}`;
      if (
        replaceArtwork ||
        !(await fileExists(resolve(folderPath, ARTWORK_NAMES.poster), path))
      ) {
        writes.push({
          type: 'write_image',
          path,
          content: await this.tmdb.downloadArtwork(details.posterPath, 'w500'),
        });
      }
    }
    if (details.backdropPath) {
      const path = `${folder}/${ARTWORK_NAMES.fanart}`;
      if (
        replaceArtwork ||
        !(await fileExists(resolve(folderPath, ARTWORK_NAMES.fanart), path))
      ) {
        writes.push({
          type: 'write_image',
          path,
          content: await this.tmdb.downloadArtwork(
            details.backdropPath,
            'w780',
          ),
        });
      }
    }

    return this.executor.writeFiles(writes, approved);
  }

  /**
   * Reads current NFO fields and persistent manual locks.
   *
   * @param videoPath Movie video path, relative to the library root.
   * @returns Editable metadata and the selected TMDB ID.
   * @throws If paths are unsafe or the existing NFO is invalid.
   */
  async read(videoPath: string): Promise<CurrentMovieMetadata> {
    const { nfoPath, nfoAbsolutePath } = await this.movieNfoPaths(videoPath);
    const xml = await readOptionalTextFile(nfoAbsolutePath, nfoPath);
    const document = readKodiNfo(xml);
    const state = this.getStoredState(videoPath);
    return {
      tmdbId: state?.tmdbId ?? document.tmdbId,
      lockedFields: state?.lockedFields ?? [],
      metadata: document.metadata,
    };
  }

  /**
   * Applies approved user edits to one movie NFO and persists its locks.
   *
   * @param request Selected TMDB movie, edited values, and field locks.
   * @param approved Explicit user approval for the NFO write.
   * @returns The reversible operation batch and updated metadata state.
   * @throws If approval is absent, paths are unsafe, or requests fail.
   */
  async edit(
    request: EditMovieMetadataRequest,
    approved: boolean,
  ): Promise<{ batch: OperationBatchResult; current: CurrentMovieMetadata }> {
    if (!approved) {
      throw new Error('Explicit approval is required before changing files.');
    }

    const parsedEdits = MovieMetadataEditValuesSchema.parse(request.metadata);
    const { nfoPath, nfoAbsolutePath } = await this.movieNfoPaths(
      request.videoPath,
    );
    const existingNfo = await readOptionalTextFile(nfoAbsolutePath, nfoPath);
    const details = toKodiMetadata(
      await this.tmdb.getMovieDetails(request.tmdbId),
    );
    const editedFields = new Set<KodiNfoField>(
      KodiNfoFieldSchema.options.filter((field) =>
        Object.hasOwn(parsedEdits, field),
      ),
    );
    const locksForMerge = request.lockedFields.filter(
      (field) => !editedFields.has(field),
    );
    const merged = mergeKodiNfo(existingNfo, details, locksForMerge);
    const nfo = applyKodiNfoEdits(merged, parsedEdits);
    const batch = await this.executor.writeFiles(
      [{ type: 'write_nfo', path: nfoPath, content: nfo }],
      true,
    );

    try {
      this.database
        .prepare(
          `INSERT INTO movie_metadata_state
             (video_path, tmdb_id, locked_fields, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(video_path) DO UPDATE SET
             tmdb_id = excluded.tmdb_id,
             locked_fields = excluded.locked_fields,
             updated_at = excluded.updated_at`,
        )
        .run(
          request.videoPath,
          request.tmdbId,
          JSON.stringify(request.lockedFields),
          new Date().toISOString(),
        );
    } catch (error) {
      try {
        await this.executor.undoBatch(batch.batchId);
      } catch (undoError) {
        throw new AggregateError(
          [error, undoError],
          'Metadata state could not be saved and the NFO write could not be undone.',
          { cause: undoError },
        );
      }
      throw new Error(
        'Metadata state could not be saved; the NFO write was undone.',
        { cause: error },
      );
    }

    return { batch, current: await this.read(request.videoPath) };
  }

  private async movieNfoPaths(videoPath: string): Promise<{
    nfoPath: string;
    nfoAbsolutePath: string;
  }> {
    const root = await realpath(this.libraryRoot);
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory()) {
      throw new Error('The configured movie-library root is not a directory.');
    }
    const { folder, videoName } = parseVideoPath(videoPath);
    const folderPath = resolve(root, folder);
    const folderInfo = await lstat(folderPath);
    if (folderInfo.isSymbolicLink() || !folderInfo.isDirectory()) {
      throw new Error(`Unsafe movie folder: ${folder}`);
    }

    const videoAbsolutePath = resolve(folderPath, videoName);
    const videoInfo = await lstat(videoAbsolutePath);
    if (videoInfo.isSymbolicLink() || !videoInfo.isFile()) {
      throw new Error(`Movie video is not a regular file: ${videoPath}`);
    }
    const nfoName = `${videoStem(videoName)}.nfo`;
    return {
      nfoPath: `${folder}/${nfoName}`,
      nfoAbsolutePath: resolve(folderPath, nfoName),
    };
  }

  private getStoredState(
    videoPath: string,
  ): { tmdbId: number; lockedFields: KodiNfoField[] } | undefined {
    const state = this.database
      .prepare<[string], { tmdb_id: number; locked_fields: string }>(
        'SELECT tmdb_id, locked_fields FROM movie_metadata_state WHERE video_path = ?',
      )
      .get(videoPath);
    if (!state) {
      return undefined;
    }
    const lockedFields: unknown = JSON.parse(state.locked_fields);
    const parsedFields = KodiNfoFieldSchema.array().parse(lockedFields);
    return { tmdbId: state.tmdb_id, lockedFields: parsedFields };
  }
}

function parseVideoPath(videoPath: string): {
  folder: string;
  videoName: string;
} {
  const segments = videoPath.split('/');
  if (
    segments.length !== 2 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.includes('\\') ||
        /^[a-z]:/i.test(segment),
    )
  ) {
    throw new Error(
      'Movie video path must be a file directly inside one movie folder.',
    );
  }
  const [folder, videoName] = segments;
  if (!folder || !videoName || !extname(videoName)) {
    throw new Error('Movie video path must include a file extension.');
  }
  return { folder, videoName };
}

function videoStem(videoName: string): string {
  const extension = extname(videoName);
  return videoName.slice(0, -extension.length);
}

async function readOptionalTextFile(
  absolutePath: string,
  relativePath: string,
): Promise<string | null> {
  if (!(await fileExists(absolutePath, relativePath))) {
    return null;
  }
  return readFile(absolutePath, 'utf8');
}

async function fileExists(
  absolutePath: string,
  relativePath: string,
): Promise<boolean> {
  try {
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Unsafe metadata file path: ${relativePath}`);
    }
    return true;
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
}

function toKodiMetadata(details: {
  id: number;
  title: string;
  originalTitle: string;
  year: number | null;
  releaseDate: string | null;
  overview: string;
  tagline: string;
  runtime: number | null;
  genres: string[];
  studios: string[];
  directors: string[];
  actors: Array<{ name: string; character: string }>;
  voteAverage: number | null;
  voteCount: number | null;
}): KodiNfoMetadata {
  return {
    tmdbId: details.id,
    title: details.title,
    originalTitle: details.originalTitle,
    year: details.year,
    releaseDate: details.releaseDate,
    plot: details.overview,
    tagline: details.tagline,
    runtime: details.runtime,
    genres: details.genres,
    studios: details.studios,
    directors: details.directors,
    actors: details.actors,
    voteAverage: details.voteAverage,
    voteCount: details.voteCount,
  };
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
