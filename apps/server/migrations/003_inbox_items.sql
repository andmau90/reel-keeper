CREATE TABLE inbox_items (
  id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL UNIQUE,
  video_path TEXT,
  file_signature TEXT NOT NULL,
  stable_intervals INTEGER NOT NULL DEFAULT 0 CHECK (stable_intervals >= 0),
  last_sampled_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'observing',
      'queued',
      'processing',
      'candidates_found',
      'needs_review',
      'error',
      'missing'
    )
  ),
  parsed_title TEXT,
  parsed_year INTEGER,
  candidates TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(candidates)),
  review_reason TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX inbox_items_status_updated_idx
  ON inbox_items(status, updated_at);
