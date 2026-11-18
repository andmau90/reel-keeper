import { z } from 'zod';

/**
 * Validates the server health response shared by the API and web client.
 */
export const ApiHealthResponseSchema = z.object({
  status: z.literal('ok'),
});

/**
 * Represents the response returned by the health endpoint.
 */
export type ApiHealthResponse = z.infer<typeof ApiHealthResponseSchema>;

/**
 * Validates states returned by the persistent recognition inbox.
 */
export const InboxStatusSchema = z.enum([
  'observing',
  'queued',
  'processing',
  'candidates_found',
  'needs_review',
  'error',
  'missing',
]);

/**
 * Validates one scored TMDB candidate stored in the inbox.
 */
export const ScoredMovieCandidateSchema = z.object({
  candidate: z.object({
    id: z.number().int().positive(),
    title: z.string().min(1),
    originalTitle: z.string().nullish().optional(),
    year: z.number().int().nullish().optional(),
  }),
  titleScore: z.number().min(0).max(100),
  score: z.number().min(0).max(100),
  yearMatch: z.enum(['exact', 'mismatch', 'unknown']),
});

/**
 * Validates an inbox item returned to the frontend.
 */
export const ApiInboxItemSchema = z.object({
  id: z.string().uuid(),
  sourcePath: z.string().min(1),
  videoPath: z.string().min(1).nullable(),
  status: InboxStatusSchema,
  parsedTitle: z.string().nullable(),
  parsedYear: z.number().int().nullable(),
  candidates: z.array(ScoredMovieCandidateSchema),
  reviewReason: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
});

/**
 * Validates a paged-in-memory inbox list response.
 */
export const ApiInboxListResponseSchema = z.object({
  items: z.array(ApiInboxItemSchema),
});

/**
 * Represents the API inbox item.
 */
export type ApiInboxItem = z.infer<typeof ApiInboxItemSchema>;

/**
 * Represents the API inbox list response.
 */
export type ApiInboxListResponse = z.infer<typeof ApiInboxListResponseSchema>;

/**
 * Validates one existing movie folder returned by the library scan.
 */
export const ApiLibraryFolderSchema = z.object({
  folderPath: z.string().min(1),
  videoPaths: z.array(z.string().min(1)).min(1),
  companions: z.array(z.string().min(1)),
  inboxItemId: z.string().uuid().nullable(),
});

/**
 * Validates the existing movie-folder list response.
 */
export const ApiLibraryResponseSchema = z.object({
  folders: z.array(ApiLibraryFolderSchema),
});

/**
 * Represents a scanned movie folder and its inbox association.
 */
export type ApiLibraryFolder = z.infer<typeof ApiLibraryFolderSchema>;

/**
 * Represents the API library response.
 */
export type ApiLibraryResponse = z.infer<typeof ApiLibraryResponseSchema>;

/**
 * Fields supported by Kodi NFO metadata editing and refresh locks.
 */
export const KodiNfoFieldSchema = z.enum([
  'title',
  'originalTitle',
  'year',
  'releaseDate',
  'plot',
  'tagline',
  'runtime',
  'genres',
  'studios',
  'directors',
  'actors',
  'rating',
]);

/**
 * Represents a Kodi NFO field that can be locked.
 */
export type KodiNfoField = z.infer<typeof KodiNfoFieldSchema>;

/**
 * Editable metadata values sent to and returned by the API.
 */
export const MovieMetadataValuesSchema = z
  .object({
    title: z.string(),
    originalTitle: z.string(),
    year: z.number().int().nullable(),
    releaseDate: z.string().nullable(),
    plot: z.string(),
    tagline: z.string(),
    runtime: z.number().int().positive().nullable(),
    genres: z.array(z.string()),
    studios: z.array(z.string()),
    directors: z.array(z.string()),
    actors: z.array(z.object({ name: z.string(), character: z.string() })),
  })
  .strict();

/**
 * Validates only the metadata fields explicitly changed by a user.
 */
export const MovieMetadataEditValuesSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    originalTitle: z.string().optional(),
    year: z.number().int().min(1888).max(2100).nullable().optional(),
    releaseDate: z.string().nullable().optional(),
    plot: z.string().optional(),
    tagline: z.string().optional(),
    runtime: z.number().int().positive().nullable().optional(),
    genres: z.array(z.string()).optional(),
    studios: z.array(z.string()).optional(),
    directors: z.array(z.string()).optional(),
    actors: z
      .array(z.object({ name: z.string(), character: z.string() }))
      .optional(),
  })
  .strict();

/**
 * Validates current NFO metadata and persisted field locks.
 */
export const ApiMovieMetadataResponseSchema = z.object({
  tmdbId: z.number().int().positive().nullable(),
  lockedFields: z.array(KodiNfoFieldSchema),
  metadata: MovieMetadataValuesSchema,
});

/**
 * Validates user-edited metadata and explicit filesystem approval.
 */
export const ApiMovieMetadataEditRequestSchema = z.object({
  tmdbId: z.number().int().positive(),
  metadata: MovieMetadataEditValuesSchema,
  lockedFields: z.array(KodiNfoFieldSchema),
  approved: z.literal(true),
});

/**
 * Validates the result of an approved manual metadata edit.
 */
export const ApiMovieMetadataEditResponseSchema = z.object({
  batchId: z.string().uuid(),
  current: ApiMovieMetadataResponseSchema,
});

/**
 * Represents editable metadata values.
 */
export type MovieMetadataValues = z.infer<typeof MovieMetadataValuesSchema>;

/**
 * Represents only fields explicitly changed by a user.
 */
export type MovieMetadataEditValues = z.infer<
  typeof MovieMetadataEditValuesSchema
>;
/**
 * Represents a current metadata response.
 */
export type ApiMovieMetadataResponse = z.infer<
  typeof ApiMovieMetadataResponseSchema
>;

/**
 * Represents an approved manual metadata edit.
 */
export type ApiMovieMetadataEditRequest = z.infer<
  typeof ApiMovieMetadataEditRequestSchema
>;

/**
 * Represents the result of a manual metadata edit.
 */
export type ApiMovieMetadataEditResponse = z.infer<
  typeof ApiMovieMetadataEditResponseSchema
>;

const OperationStatusSchema = z.enum([
  'pending',
  'completed',
  'failed',
  'undone',
]);

/**
 * Validates an operation included in a history batch.
 */
export const ApiHistoryOperationSchema = z.object({
  type: z.enum(['mkdir', 'move', 'rename', 'write_nfo', 'write_image']),
  sourcePath: z.string().nullable(),
  destinationPath: z.string(),
  status: OperationStatusSchema,
});

/**
 * Validates one reversible operation batch in the history view.
 */
export const ApiHistoryBatchSchema = z.object({
  id: z.string().uuid(),
  status: z.enum([
    'pending',
    'completed',
    'failed',
    'partial_failure',
    'undoing',
    'partial_undo',
    'undone',
  ]),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  undoneAt: z.string().datetime().nullable(),
  errorMessage: z.string().nullable(),
  operations: z.array(ApiHistoryOperationSchema),
});

/**
 * Validates the operation history response.
 */
export const ApiHistoryResponseSchema = z.object({
  batches: z.array(ApiHistoryBatchSchema),
});

/**
 * Validates explicit confirmation before undoing an operation batch.
 */
export const ApiHistoryUndoRequestSchema = z.object({
  approved: z.literal(true),
});

/**
 * Validates the result of a completed operation undo.
 */
export const ApiHistoryUndoResponseSchema = z.object({
  batchId: z.string().uuid(),
  status: z.literal('undone'),
});

/**
 * Represents an operation history batch.
 */
export type ApiHistoryBatch = z.infer<typeof ApiHistoryBatchSchema>;

/**
 * Validates API error responses.
 */
export const ApiErrorResponseSchema = z.object({
  error: z.string().min(1),
});

const MovieMetadataSchema = z.object({
  title: z.string().trim().min(1),
  year: z.number().int().min(1888).max(2100).nullable(),
});

/**
 * Validates an input to the pure movie placement planner.
 */
export const MoviePlacementRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('loose_file'),
    sourcePath: z.string().min(1),
    movie: MovieMetadataSchema,
    companions: z.array(z.string().min(1)).default([]),
    existingPaths: z.array(z.string().min(1)).default([]),
  }),
  z.object({
    kind: z.literal('existing_folder'),
    folderPath: z.string().min(1),
    videoPaths: z.array(z.string().min(1)).min(1),
    movie: MovieMetadataSchema,
    companions: z.array(z.string().min(1)).default([]),
    existingPaths: z.array(z.string().min(1)).default([]),
  }),
]);

/**
 * Represents the input needed to plan a movie's location and filenames.
 */
export type MoviePlacementRequest = z.infer<typeof MoviePlacementRequestSchema>;
