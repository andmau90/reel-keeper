ALTER TABLE operations ADD COLUMN backup_path TEXT;
ALTER TABLE operations ADD COLUMN backup_exists INTEGER NOT NULL DEFAULT 0
  CHECK (backup_exists IN (0, 1));
ALTER TABLE operations ADD COLUMN backup_hash TEXT;
ALTER TABLE operations ADD COLUMN output_hash TEXT;
