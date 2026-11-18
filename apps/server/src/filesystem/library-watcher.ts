import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { ScoredMovieCandidate } from '@reelkeeper/core';
import { ScoredMovieCandidateSchema } from '@reelkeeper/shared';
import { z } from 'zod';
import type { SqliteDatabase } from '../db/connection.js';
import {
  recognizeMovieFilename,
  type MovieSearchProvider,
} from '../recognizer.js';
import { scanLibrary } from './library-scanner.js';

export type InboxStatus =
  | 'observing'
  | 'queued'
  | 'processing'
  | 'candidates_found'
  | 'needs_review'
  | 'error'
  | 'missing';

interface InboxRow {
  id: string;
  source_path: string;
  video_path: string | null;
  file_signature: string;
  stable_intervals: number;
  last_sampled_at: number;
  status: InboxStatus;
}

interface ObservedFile {
  sourcePath: string;
  videoPath: string | null;
  videoPaths: string[];
  signature: string;
}

const ScoredMovieCandidatesSchema = z.array(ScoredMovieCandidateSchema);

/**
 * Persisted queue item exposed for inbox views and later API endpoints.
 */
export interface InboxItem {
  id: string;
  sourcePath: string;
  videoPath: string | null;
  fileSignature: string;
  stableIntervals: number;
  status: InboxStatus;
  parsedTitle: string | null;
  parsedYear: number | null;
  candidates: ScoredMovieCandidate[];
  reviewReason: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

/**
 * An expected conflict while trying to rematch an inbox item.
 */
export class InboxRematchError extends Error {
  readonly statusCode: 404 | 409;

  constructor(message: string, statusCode: 404 | 409) {
    super(message);
    this.name = 'InboxRematchError';
    this.statusCode = statusCode;
  }
}

/**
 * Polls the shallow library, waits for stable files, and recognizes one item
 * at a time without making filesystem changes.
 */
export class LibraryWatcher {
  private readonly database: SqliteDatabase;
  private readonly libraryRoot: string;
  private readonly provider: MovieSearchProvider;
  private readonly pollIntervalMs: number;
  private readonly stablePolls: number;
  private readonly onError: (error: Error) => void;
  private readonly onInboxItemUpdated: ((item: InboxItem) => void) | undefined;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | undefined;
  private pollPromise: Promise<void> | undefined;
  private workerPromise: Promise<void> | undefined;

  /**
   * Creates the watcher and its single-worker recognition queue.
   *
   * @param options Database, library, timing, provider, and error callback.
   * @throws If polling or stability settings are invalid.
   */
  constructor(options: {
    database: SqliteDatabase;
    libraryRoot: string;
    provider: MovieSearchProvider;
    pollIntervalMs: number;
    stablePolls: number;
    onError: (error: Error) => void;
    onInboxItemUpdated?: (item: InboxItem) => void;
    now?: () => number;
  }) {
    if (
      !Number.isSafeInteger(options.pollIntervalMs) ||
      options.pollIntervalMs <= 0 ||
      options.pollIntervalMs > 2_147_483_647
    ) {
      throw new Error('Watcher poll interval must be a positive whole number.');
    }
    if (
      !Number.isSafeInteger(options.stablePolls) ||
      options.stablePolls <= 0
    ) {
      throw new Error(
        'Watcher stability polls must be a positive whole number.',
      );
    }
    this.database = options.database;
    this.libraryRoot = options.libraryRoot;
    this.provider = options.provider;
    this.pollIntervalMs = options.pollIntervalMs;
    this.stablePolls = options.stablePolls;
    this.onError = options.onError;
    this.onInboxItemUpdated = options.onInboxItemUpdated;
    this.now = options.now ?? Date.now;
  }

  /**
   * Recovers interrupted items, scans immediately, then starts polling.
   *
   * @throws If recovery or the initial scan fails.
   */
  async start(): Promise<void> {
    if (this.timer) {
      return;
    }
    this.database
      .prepare(
        `UPDATE inbox_items
         SET status = 'queued', updated_at = ?
         WHERE status = 'processing'`,
      )
      .run(new Date().toISOString());
    await this.pollOnce();
    this.timer = setInterval(() => {
      void this.pollOnce().catch((error: unknown) =>
        this.onError(toError(error)),
      );
    }, this.pollIntervalMs);
  }

  /**
   * Stops polling and waits for active scans and recognition work to finish.
   */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.waitForIdle();
  }

  /**
   * Runs one scan; concurrent callers share the same scan.
   *
   * @returns When observations have been persisted and queue work has started.
   * @throws If scanning or queue-state persistence fails.
   */
  async pollOnce(): Promise<void> {
    if (!this.pollPromise) {
      this.pollPromise = this.scanAndRecord().finally(() => {
        this.pollPromise = undefined;
      });
    }
    await this.pollPromise;
    this.startWorker();
  }

  /**
   * Waits for current recognition work to drain.
   */
  async waitForIdle(): Promise<void> {
    while (this.pollPromise || this.workerPromise) {
      await Promise.all(
        [this.pollPromise, this.workerPromise].filter(isPromise),
      );
    }
  }

  private async scanAndRecord(): Promise<void> {
    const scan = await scanLibrary(this.libraryRoot);
    const root = resolve(this.libraryRoot);
    const observations: ObservedFile[] = [];

    for (const entry of scan.entries) {
      if (entry.kind === 'loose_file') {
        const observation = await observeVideo(root, entry.sourcePath, [
          entry.sourcePath,
        ]);
        if (observation) {
          observations.push(observation);
        }
        continue;
      }

      const sourcePath =
        entry.videoPaths.length === 1
          ? (entry.videoPaths[0] ?? entry.folderPath)
          : entry.folderPath;
      const observation = await observeVideo(
        root,
        sourcePath,
        entry.videoPaths,
        entry.videoPaths.length === 1 ? sourcePath : null,
      );
      if (observation) {
        observations.push(observation);
      }
    }

    const seenPaths = new Set(observations.map(({ sourcePath }) => sourcePath));
    const sampledAt = this.now();
    const now = new Date(sampledAt).toISOString();
    for (const observation of observations) {
      this.recordObservation(observation, now, sampledAt);
    }

    const existingRows = this.database
      .prepare<[], { id: string; source_path: string }>(
        "SELECT id, source_path FROM inbox_items WHERE status != 'missing'",
      )
      .all();
    const markMissing = this.database.prepare(
      `UPDATE inbox_items
       SET status = 'missing', updated_at = ?
       WHERE source_path = ?`,
    );
    for (const row of existingRows) {
      if (!seenPaths.has(row.source_path)) {
        markMissing.run(now, row.source_path);
        this.publishInboxItem(row.id);
      }
    }
  }

  private recordObservation(
    observation: ObservedFile,
    now: string,
    sampledAt: number,
  ): void {
    const existing = this.database
      .prepare<[string], InboxRow>(
        `SELECT id, source_path, video_path, file_signature,
                stable_intervals, last_sampled_at, status
         FROM inbox_items WHERE source_path = ?`,
      )
      .get(observation.sourcePath);

    if (!existing) {
      const id = randomUUID();
      this.database
        .prepare(
          `INSERT INTO inbox_items (
             id, source_path, video_path, file_signature, stable_intervals,
             last_sampled_at, status, candidates, created_at, updated_at,
             last_seen_at
           ) VALUES (?, ?, ?, ?, 0, ?, 'observing', '[]', ?, ?, ?)`,
        )
        .run(
          id,
          observation.sourcePath,
          observation.videoPath,
          observation.signature,
          sampledAt,
          now,
          now,
          now,
        );
      this.publishInboxItem(id);
      return;
    }

    if (
      existing.file_signature !== observation.signature ||
      existing.status === 'missing'
    ) {
      this.database
        .prepare(
          `UPDATE inbox_items
           SET video_path = ?, file_signature = ?, stable_intervals = 0,
               last_sampled_at = ?,
               status = 'observing', parsed_title = NULL, parsed_year = NULL,
               candidates = '[]', review_reason = NULL, error_message = NULL,
               updated_at = ?, last_seen_at = ?
           WHERE id = ?`,
        )
        .run(
          observation.videoPath,
          observation.signature,
          sampledAt,
          now,
          now,
          existing.id,
        );
      this.publishInboxItem(existing.id);
      return;
    }

    if (sampledAt - existing.last_sampled_at < this.pollIntervalMs) {
      this.database
        .prepare('UPDATE inbox_items SET last_seen_at = ? WHERE id = ?')
        .run(now, existing.id);
      return;
    }

    const stableIntervals = existing.stable_intervals + 1;
    let status = existing.status;
    let reviewReason: string | null = null;
    if (status === 'observing' && stableIntervals >= this.stablePolls) {
      if (observation.videoPath === null) {
        status = 'needs_review';
        reviewReason = 'multiple_videos';
      } else {
        status = 'queued';
      }
    }

    this.database
      .prepare(
        `UPDATE inbox_items
         SET stable_intervals = ?, status = ?, review_reason = COALESCE(?, review_reason),
             last_sampled_at = ?, updated_at = ?, last_seen_at = ?
         WHERE id = ?`,
      )
      .run(
        stableIntervals,
        status,
        reviewReason,
        sampledAt,
        now,
        now,
        existing.id,
      );
    if (status !== existing.status) {
      this.publishInboxItem(existing.id);
    }
  }

  private startWorker(): void {
    if (this.workerPromise) {
      return;
    }
    this.workerPromise = this.drainQueue()
      .catch((error: unknown) => this.onError(toError(error)))
      .finally(() => {
        this.workerPromise = undefined;
        if (this.hasQueuedItems()) {
          this.startWorker();
        }
      });
  }

  private async drainQueue(): Promise<void> {
    while (true) {
      const item = this.database
        .prepare<[], InboxRow>(
          `SELECT id, source_path, video_path, file_signature,
                  stable_intervals, status
           FROM inbox_items
           WHERE status = 'queued'
           ORDER BY created_at, id
           LIMIT 1`,
        )
        .get();
      if (!item) {
        return;
      }
      this.database
        .prepare(
          `UPDATE inbox_items
           SET status = 'processing', updated_at = ?
           WHERE id = ? AND status = 'queued'`,
        )
        .run(new Date().toISOString(), item.id);
      this.publishInboxItem(item.id);
      await this.processItem(item);
    }
  }

  private async processItem(item: InboxRow): Promise<void> {
    if (!item.video_path) {
      this.setReview(item, 'multiple_videos');
      return;
    }

    try {
      const currentSignature = await signatureForVideo(
        resolve(this.libraryRoot),
        item.video_path,
      );
      if (currentSignature !== item.file_signature) {
        return;
      }

      const recognition = await recognizeMovieFilename(
        basename(item.video_path),
        this.provider,
      );
      const finalSignature = await signatureForVideo(
        resolve(this.libraryRoot),
        item.video_path,
      );
      if (finalSignature !== item.file_signature) {
        return;
      }

      const status = recognition.status;
      this.database
        .prepare(
          `UPDATE inbox_items
           SET status = ?, parsed_title = ?, parsed_year = ?, candidates = ?,
               review_reason = ?, error_message = NULL, updated_at = ?
           WHERE id = ? AND status = 'processing' AND file_signature = ?`,
        )
        .run(
          status,
          recognition.parsed?.title ?? null,
          recognition.parsed?.year ?? null,
          JSON.stringify(recognition.candidates),
          recognition.reviewReason,
          new Date().toISOString(),
          item.id,
          item.file_signature,
        );
      this.publishInboxItem(item.id);
    } catch (error) {
      this.database
        .prepare(
          `UPDATE inbox_items
           SET status = 'error', error_message = ?, updated_at = ?
           WHERE id = ? AND status = 'processing' AND file_signature = ?`,
        )
        .run(
          errorMessage(error),
          new Date().toISOString(),
          item.id,
          item.file_signature,
        );
      this.publishInboxItem(item.id);
    }
  }

  private setReview(item: InboxRow, reason: string): void {
    this.database
      .prepare(
        `UPDATE inbox_items
         SET status = 'needs_review', review_reason = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(reason, new Date().toISOString(), item.id);
    this.publishInboxItem(item.id);
  }

  private publishInboxItem(id: string): void {
    if (!id) {
      return;
    }
    try {
      const item = getInboxItem(this.database, id);
      if (item) {
        this.onInboxItemUpdated?.(item);
      }
    } catch (error) {
      this.onError(toError(error));
    }
  }

  private hasQueuedItems(): boolean {
    return Boolean(
      this.database
        .prepare<[], { id: string }>(
          "SELECT id FROM inbox_items WHERE status = 'queued' LIMIT 1",
        )
        .get(),
    );
  }
}

/**
 * Lists persisted inbox items in creation order.
 *
 * @param database Open ReelKeeper SQLite connection.
 * @returns Validated queue rows with candidate payloads parsed from JSON.
 */
export function listInboxItems(database: SqliteDatabase): InboxItem[] {
  return database
    .prepare<[], RawInboxItem>(`${INBOX_ITEM_SELECT} ORDER BY created_at, id`)
    .all()
    .map(toInboxItem);
}

/**
 * Retrieves one persisted inbox item.
 *
 * @param database Open ReelKeeper SQLite connection.
 * @param id Inbox item identifier.
 * @returns The item, or undefined when it does not exist.
 */
export function getInboxItem(
  database: SqliteDatabase,
  id: string,
): InboxItem | undefined {
  const row = database
    .prepare<[string], RawInboxItem>(`${INBOX_ITEM_SELECT} WHERE id = ?`)
    .get(id);
  return row ? toInboxItem(row) : undefined;
}

/**
 * Reruns filename recognition and replaces the stored candidates.
 *
 * @param database Open ReelKeeper SQLite connection.
 * @param libraryRoot Absolute movie-library root.
 * @param id Inbox item identifier.
 * @param provider TMDB-compatible movie search provider.
 * @returns The updated persistent inbox item.
 * @throws If the item or video is unavailable or changes during recognition.
 */
export async function rematchInboxItem(
  database: SqliteDatabase,
  libraryRoot: string,
  id: string,
  provider: MovieSearchProvider,
): Promise<InboxItem> {
  const item = getInboxItem(database, id);
  if (!item) {
    throw new InboxRematchError('Inbox item not found.', 404);
  }
  if (!item.videoPath || item.status === 'missing') {
    throw new InboxRematchError(
      'This inbox item does not have an available single video to rematch.',
      409,
    );
  }
  if (
    item.status !== 'candidates_found' &&
    item.status !== 'needs_review' &&
    item.status !== 'error'
  ) {
    throw new InboxRematchError(
      'Wait for initial recognition to finish before rematching.',
      409,
    );
  }

  const root = resolve(libraryRoot);
  const before = await signatureForVideo(root, item.videoPath);
  if (before !== item.fileSignature) {
    throw new InboxRematchError(
      'The video changed; wait for it to stabilize before rematching.',
      409,
    );
  }

  const recognition = await recognizeMovieFilename(
    basename(item.videoPath),
    provider,
  );
  const after = await signatureForVideo(root, item.videoPath);
  if (after !== before) {
    throw new InboxRematchError(
      'The video changed during rematching; wait for it to stabilize.',
      409,
    );
  }

  const result = database
    .prepare(
      `UPDATE inbox_items
       SET status = ?, parsed_title = ?, parsed_year = ?, candidates = ?,
           review_reason = ?, error_message = NULL, updated_at = ?
       WHERE id = ? AND file_signature = ? AND status != 'missing'`,
    )
    .run(
      recognition.status,
      recognition.parsed?.title ?? null,
      recognition.parsed?.year ?? null,
      JSON.stringify(recognition.candidates),
      recognition.reviewReason,
      new Date().toISOString(),
      item.id,
      item.fileSignature,
    );
  if (result.changes !== 1) {
    throw new InboxRematchError(
      'The inbox item changed while rematching; refresh and try again.',
      409,
    );
  }

  const updatedItem = getInboxItem(database, item.id);
  if (!updatedItem) {
    throw new Error(`Inbox item ${item.id} disappeared after rematching.`);
  }
  return updatedItem;
}

type RawInboxItem = Omit<InboxItem, 'candidates'> & { candidates: string };

const INBOX_ITEM_SELECT = `SELECT id, source_path AS sourcePath,
                                  video_path AS videoPath,
                                  file_signature AS fileSignature,
                                  stable_intervals AS stableIntervals,
                                  status, parsed_title AS parsedTitle,
                                  parsed_year AS parsedYear, candidates,
                                  review_reason AS reviewReason,
                                  error_message AS errorMessage,
                                  created_at AS createdAt,
                                  updated_at AS updatedAt,
                                  last_seen_at AS lastSeenAt
                           FROM inbox_items`;

function toInboxItem(row: RawInboxItem): InboxItem {
  return { ...row, candidates: parseCandidates(row.candidates) };
}

async function observeVideo(
  root: string,
  sourcePath: string,
  videoPaths: string[],
  videoPath: string | null = sourcePath,
): Promise<ObservedFile | null> {
  const snapshots: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const path of videoPaths.slice().sort()) {
    const segments = validateVideoPath(path);
    const absolutePath = resolve(root, ...segments);
    try {
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(`Unsafe movie video path: ${path}`);
      }
      snapshots.push({ path, size: info.size, mtimeMs: info.mtimeMs });
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) {
        return null;
      }
      throw error;
    }
  }
  if (snapshots.length !== videoPaths.length || snapshots.length === 0) {
    return null;
  }
  return {
    sourcePath,
    videoPath,
    videoPaths,
    signature: JSON.stringify(snapshots),
  };
}

async function signatureForVideo(
  root: string,
  videoPath: string,
): Promise<string> {
  const observation = await observeVideo(root, videoPath, [videoPath]);
  if (!observation) {
    throw new Error(`Movie video disappeared while processing: ${videoPath}`);
  }
  return observation.signature;
}

function parseCandidates(serialized: string): ScoredMovieCandidate[] {
  const candidates: unknown = JSON.parse(serialized);
  return ScoredMovieCandidatesSchema.parse(candidates);
}

function validateVideoPath(videoPath: string): string[] {
  const segments = videoPath.split('/');
  if (
    segments.length > 2 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.includes('\\') ||
        /^[a-z]:/i.test(segment),
    )
  ) {
    throw new Error(`Invalid relative movie video path: ${videoPath}`);
  }
  return segments;
}

function isPromise(value: Promise<void> | undefined): value is Promise<void> {
  return value !== undefined;
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
