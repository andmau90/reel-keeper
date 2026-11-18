CREATE TABLE movies (
  id TEXT PRIMARY KEY,
  folder_path TEXT NOT NULL UNIQUE,
  video_file TEXT NOT NULL,
  tmdb_id INTEGER,
  title TEXT NOT NULL,
  year INTEGER,
  status TEXT NOT NULL CHECK (
    status IN ('ok', 'needs_rename', 'needs_review', 'error')
  ),
  match_confidence INTEGER CHECK (
    match_confidence IS NULL OR match_confidence BETWEEN 0 AND 100
  ),
  folder_mtime INTEGER,
  nfo_mtime INTEGER,
  locked_fields TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(locked_fields)),
  updated_at TEXT NOT NULL
);

CREATE TABLE candidates (
  movie_id TEXT NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  tmdb_id INTEGER NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  PRIMARY KEY (movie_id, tmdb_id)
);

CREATE TABLE operation_batches (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (
    status IN (
      'pending',
      'completed',
      'failed',
      'partial_failure',
      'undoing',
      'partial_undo',
      'undone'
    )
  ),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  undone_at TEXT,
  error_message TEXT
);

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES operation_batches(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (
    type IN ('mkdir', 'move', 'rename', 'write_nfo', 'write_image')
  ),
  source_path TEXT,
  destination_path TEXT NOT NULL,
  requires_intermediate_rename INTEGER NOT NULL DEFAULT 0 CHECK (
    requires_intermediate_rename IN (0, 1)
  ),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'completed', 'failed', 'undone')
  ),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  undone_at TEXT,
  error_message TEXT,
  UNIQUE (batch_id, sequence)
);

CREATE TABLE tmdb_cache (
  cache_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value))
);

CREATE INDEX operations_batch_sequence_idx
  ON operations(batch_id, sequence);

CREATE INDEX movies_status_idx
  ON movies(status);
