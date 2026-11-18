CREATE TABLE movie_metadata_state (
  video_path TEXT PRIMARY KEY,
  tmdb_id INTEGER NOT NULL CHECK (tmdb_id > 0),
  locked_fields TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(locked_fields)),
  updated_at TEXT NOT NULL
);
