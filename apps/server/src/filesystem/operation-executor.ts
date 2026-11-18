import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import { ApiHistoryBatchSchema } from '@reelkeeper/shared';
import type { ApiHistoryBatch } from '@reelkeeper/shared';
import type { MovieMovePlan, PlannedFileOperation } from '@reelkeeper/core';
import type { SqliteDatabase } from '../db/connection.js';

interface StoredOperation {
  id: string;
  type: 'mkdir' | 'move' | 'rename' | 'write_nfo' | 'write_image';
  source_path: string | null;
  destination_path: string;
  requires_intermediate_rename: number;
  status: 'pending' | 'completed' | 'failed' | 'undone';
  backup_path: string | null;
  backup_exists: number;
  backup_hash: string | null;
  output_hash: string | null;
}

interface ExecutableWrite {
  type: 'write_nfo' | 'write_image';
  from?: undefined;
  to: string;
  content: string | Uint8Array;
  requiresIntermediateRename?: false;
}

type ExecutableOperation = PlannedFileOperation | ExecutableWrite;

interface WriteEffects {
  backupPath: string | null;
  backupExists: boolean;
  backupHash: string | null;
  outputHash: string;
}

interface OperationSummary {
  type: ExecutableOperation['type'];
  from?: string;
  to: string;
}

/**
 * Describes the result of applying one approved plan.
 */
export interface OperationBatchResult {
  /** Unique identifier used to inspect or undo the batch. */
  batchId: string;
  /** Final state of the batch. */
  status: 'completed';
  /** Ordered operations recorded in the batch. */
  operations: OperationSummary[];
}

/**
 * Applies approved filesystem plans and records reversible operations.
 */
export class OperationExecutor {
  private readonly database: SqliteDatabase;
  private readonly libraryRoot: string;
  private readonly dataDirectory: string;

  /**
   * Creates an executor for one movie-library root.
   *
   * @param database Database containing the operation log.
   * @param libraryRoot Absolute path to the movie-library root.
   * @param dataDirectory Application data directory used for write backups.
   */
  constructor(
    database: SqliteDatabase,
    libraryRoot: string,
    dataDirectory: string,
  ) {
    this.database = database;
    this.libraryRoot = libraryRoot;
    this.dataDirectory = resolve(dataDirectory);
  }

  /**
   * Applies an approved plan and records all operations before changing files.
   *
   * @param plan Dry-run plan produced by the core package.
   * @param approved Explicit user approval for every operation in the plan.
   * @returns The completed batch identifier and operations.
   * @throws If approval is absent, paths conflict, or a filesystem operation fails.
   */
  async executePlan(
    plan: MovieMovePlan,
    approved: boolean,
  ): Promise<OperationBatchResult> {
    if (!approved) {
      throw new Error('Explicit approval is required before changing files.');
    }
    if (plan.status !== 'ready' || plan.operations.length === 0) {
      throw new Error('Only ready plans with operations can be applied.');
    }

    return this.executeOperations(plan.operations);
  }

  /**
   * Writes NFO/image files and records reversible backups.
   *
   * @param writes Files to write within the library root.
   * @param approved Explicit user approval for every write.
   * @returns The completed batch identifier and operation summaries.
   * @throws If approval is absent, paths conflict, or a write fails.
   */
  async writeFiles(
    writes: Array<{
      type: 'write_nfo' | 'write_image';
      path: string;
      content: string | Uint8Array;
    }>,
    approved: boolean,
  ): Promise<OperationBatchResult> {
    if (!approved) {
      throw new Error('Explicit approval is required before changing files.');
    }
    if (writes.length === 0) {
      throw new Error('At least one file write is required.');
    }
    const operations: ExecutableWrite[] = writes.map((write) => ({
      type: write.type,
      to: write.path,
      content: write.content,
    }));
    return this.executeOperations(operations);
  }

  /**
   * Lists the latest reversible operation batches with their recorded steps.
   *
   * @returns Up to 100 batches, newest first.
   */
  listHistory(): ApiHistoryBatch[] {
    const batches = this.database
      .prepare<
        [],
        {
          id: string;
          status: string;
          created_at: string;
          completed_at: string | null;
          undone_at: string | null;
          error_message: string | null;
        }
      >(
        `SELECT id, status, created_at, completed_at, undone_at, error_message
         FROM operation_batches
         ORDER BY created_at DESC, id DESC
         LIMIT 100`,
      )
      .all();
    const operationsQuery = this.database.prepare<
      [string],
      {
        type: string;
        source_path: string | null;
        destination_path: string;
        status: string;
      }
    >(
      `SELECT type, source_path, destination_path, status
       FROM operations
       WHERE batch_id = ?
       ORDER BY sequence`,
    );

    return batches.map((batch) =>
      ApiHistoryBatchSchema.parse({
        id: batch.id,
        status: batch.status,
        createdAt: batch.created_at,
        completedAt: batch.completed_at,
        undoneAt: batch.undone_at,
        errorMessage: batch.error_message,
        operations: operationsQuery.all(batch.id).map((operation) => ({
          type: operation.type,
          sourcePath: operation.source_path,
          destinationPath: operation.destination_path,
          status: operation.status,
        })),
      }),
    );
  }

  private async executeOperations(
    operations: ExecutableOperation[],
  ): Promise<OperationBatchResult> {
    const root = await realpath(this.libraryRoot);
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory()) {
      throw new Error('The configured movie-library root is not a directory.');
    }

    for (const operation of operations) {
      validateOperationShape(operation);
      resolveLibraryPath(root, operation.to);
      if (operation.from) {
        resolveLibraryPath(root, operation.from);
      }
    }

    const batchId = randomUUID();
    const createdAt = new Date().toISOString();
    const operationRows = operations.map((operation, sequence) => ({
      id: randomUUID(),
      operation,
      sequence,
    }));

    const insertBatch = this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO operation_batches (id, status, created_at)
           VALUES (?, 'pending', ?)`,
        )
        .run(batchId, createdAt);

      const insertOperation = this.database.prepare(
        `INSERT INTO operations (
           id, batch_id, sequence, type, source_path, destination_path,
           requires_intermediate_rename, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      );
      for (const row of operationRows) {
        insertOperation.run(
          row.id,
          batchId,
          row.sequence,
          row.operation.type,
          row.operation.from ?? null,
          row.operation.to,
          row.operation.requiresIntermediateRename ? 1 : 0,
          createdAt,
        );
      }
    });
    insertBatch();

    const applied: StoredOperation[] = [];
    let currentOperationId: string | undefined;

    try {
      for (const row of operationRows) {
        currentOperationId = row.id;
        const effects = isWriteOperation(row.operation)
          ? await this.prepareWrite(root, row.operation, batchId, row.id)
          : null;
        if (effects) {
          this.database
            .prepare(
              `UPDATE operations
               SET backup_path = ?, backup_exists = ?, backup_hash = ?,
                   output_hash = ?
               WHERE id = ?`,
            )
            .run(
              effects.backupPath,
              effects.backupExists ? 1 : 0,
              effects.backupHash,
              effects.outputHash,
              row.id,
            );
        }
        await this.applyOperation(root, row.operation, effects);
        const storedOperation = toStoredOperation(row, effects);
        applied.push(storedOperation);
        this.database
          .prepare(
            `UPDATE operations
             SET status = 'completed', completed_at = ?
             WHERE id = ?`,
          )
          .run(new Date().toISOString(), row.id);
        currentOperationId = undefined;
      }

      this.database
        .prepare(
          `UPDATE operation_batches
           SET status = 'completed', completed_at = ?
           WHERE id = ?`,
        )
        .run(new Date().toISOString(), batchId);

      return {
        batchId,
        status: 'completed',
        operations: operations.map(({ type, from, to }) => ({
          type,
          ...(from ? { from } : {}),
          to,
        })),
      };
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      const message = errorMessage(error);

      if (currentOperationId) {
        try {
          this.database
            .prepare(
              `UPDATE operations
               SET status = 'failed', error_message = ?
               WHERE id = ?`,
            )
            .run(message, currentOperationId);
        } catch (databaseError) {
          rollbackErrors.push(databaseError);
        }
      }

      for (const operation of applied.reverse()) {
        try {
          await this.undoOperation(root, operation);
          this.database
            .prepare(
              `UPDATE operations
               SET status = 'undone', undone_at = ?
               WHERE id = ?`,
            )
            .run(new Date().toISOString(), operation.id);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }

      try {
        this.database
          .prepare(
            `UPDATE operation_batches
             SET status = ?, error_message = ?
             WHERE id = ?`,
          )
          .run(
            rollbackErrors.length === 0 ? 'failed' : 'partial_failure',
            [message, ...rollbackErrors.map(errorMessage)].join(
              '\nRollback error: ',
            ),
            batchId,
          );
      } catch (databaseError) {
        rollbackErrors.push(databaseError);
      }

      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          `Operation batch ${batchId} failed and could not be fully rolled back.`,
          { cause: error },
        );
      }
      throw new Error(
        `Operation batch ${batchId} failed and completed steps were rolled back: ${message}`,
        { cause: error },
      );
    }
  }

  /**
   * Reverses a completed batch in reverse operation order.
   *
   * @param batchId Identifier returned by executePlan.
   * @returns The batch identifier after it has been undone.
   * @throws If the batch is unavailable or a reverse operation conflicts.
   */
  async undoBatch(
    batchId: string,
  ): Promise<{ batchId: string; status: 'undone' }> {
    const batch = this.database
      .prepare<[string], { status: string }>(
        'SELECT status FROM operation_batches WHERE id = ?',
      )
      .get(batchId);
    if (!batch) {
      throw new Error(`Operation batch ${batchId} was not found.`);
    }
    if (batch.status !== 'completed' && batch.status !== 'partial_undo') {
      throw new Error(
        `Operation batch ${batchId} cannot be undone from ${batch.status}.`,
      );
    }

    const root = await realpath(this.libraryRoot);
    const operations = this.database
      .prepare<[string], StoredOperation>(
        `SELECT id, type, source_path, destination_path,
                requires_intermediate_rename, status, backup_path,
                backup_exists, backup_hash, output_hash
         FROM operations
         WHERE batch_id = ? AND status = 'completed'
         ORDER BY sequence DESC`,
      )
      .all(batchId);

    this.database
      .prepare(
        `UPDATE operation_batches
         SET status = 'undoing', error_message = NULL
         WHERE id = ?`,
      )
      .run(batchId);

    try {
      for (const operation of operations) {
        await this.undoOperation(root, operation);
        this.database
          .prepare(
            `UPDATE operations
             SET status = 'undone', undone_at = ?
             WHERE id = ?`,
          )
          .run(new Date().toISOString(), operation.id);
      }
    } catch (error) {
      this.database
        .prepare(
          `UPDATE operation_batches
           SET status = 'partial_undo', error_message = ?
           WHERE id = ?`,
        )
        .run(errorMessage(error), batchId);
      throw new Error(
        `Could not undo batch ${batchId}: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    this.database
      .prepare(
        `UPDATE operation_batches
         SET status = 'undone', undone_at = ?, error_message = NULL
         WHERE id = ?`,
      )
      .run(new Date().toISOString(), batchId);

    return { batchId, status: 'undone' };
  }

  private async prepareWrite(
    root: string,
    operation: ExecutableWrite,
    batchId: string,
    operationId: string,
  ): Promise<WriteEffects> {
    const destination = resolveLibraryPath(root, operation.to);
    await assertSafeParent(root, operation.to);
    const output = toBuffer(operation.content);
    const outputHash = hashBytes(output);

    if (!(await pathExists(destination))) {
      return {
        backupPath: null,
        backupExists: false,
        backupHash: null,
        outputHash,
      };
    }

    const info = await lstat(destination);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(
        `Write destination is not a regular file: ${operation.to}`,
      );
    }

    const original = await readFile(destination);
    const backupPath = `backups/${batchId}/${operationId}.bak`;
    const dataRoot = await realpath(this.dataDirectory);
    const backupAbsolute = resolveBackupPath(dataRoot, backupPath);
    await assertSafeBackupParent(dataRoot, backupPath);
    await mkdir(dirname(backupAbsolute), { recursive: true });
    await assertSafeBackupParent(dataRoot, backupPath);
    await writeFile(backupAbsolute, original, { flag: 'wx' });

    return {
      backupPath,
      backupExists: true,
      backupHash: hashBytes(original),
      outputHash,
    };
  }

  private async applyOperation(
    root: string,
    operation: ExecutableOperation,
    effects: WriteEffects | null,
  ): Promise<void> {
    const destination = resolveLibraryPath(root, operation.to);
    await assertSafeParent(root, operation.to);
    if (isWriteOperation(operation)) {
      if (!effects) {
        throw new Error(
          `Write operation ${operation.to} has no backup record.`,
        );
      }
      await this.writeAtomically(root, operation, effects);
      return;
    }

    if (operation.type === 'mkdir') {
      if (await pathExists(destination)) {
        throw new Error(`Destination already exists: ${operation.to}`);
      }
      await mkdir(destination);
      return;
    }

    const sourcePath = operation.from;
    if (!sourcePath) {
      throw new Error(`${operation.type} operation is missing a source path.`);
    }

    const source = resolveLibraryPath(root, sourcePath);
    await assertSafeParent(root, sourcePath);
    const sourceInfo = await lstat(source);
    if (sourceInfo.isSymbolicLink()) {
      throw new Error(`Symbolic links cannot be moved: ${sourcePath}`);
    }

    const caseOnly = isCaseOnlyRename(sourcePath, operation.to);
    if ((await pathExists(destination)) && !caseOnly) {
      throw new Error(`Destination already exists: ${operation.to}`);
    }

    await renameSafely(source, destination, caseOnly);
  }

  private async writeAtomically(
    root: string,
    operation: ExecutableWrite,
    effects: WriteEffects,
  ): Promise<void> {
    const destination = resolveLibraryPath(root, operation.to);
    if (effects.backupExists) {
      const currentInfo = await lstat(destination);
      if (currentInfo.isSymbolicLink() || !currentInfo.isFile()) {
        throw new Error(`Write destination changed type: ${operation.to}`);
      }
      const currentHash = hashBytes(await readFile(destination));
      if (currentHash !== effects.backupHash) {
        throw new Error(
          `Write destination changed after backup: ${operation.to}`,
        );
      }
    } else if (await pathExists(destination)) {
      throw new Error(
        `Write destination appeared after approval: ${operation.to}`,
      );
    }

    await writeBytesAtomically(destination, toBuffer(operation.content));
  }

  private async undoOperation(
    root: string,
    operation: StoredOperation,
  ): Promise<void> {
    const destination = resolveLibraryPath(root, operation.destination_path);

    if (isStoredWriteOperation(operation)) {
      await this.undoWrite(root, destination, operation);
      return;
    }

    if (operation.type === 'mkdir') {
      await assertSafeParent(root, operation.destination_path);
      await rmdir(destination);
      return;
    }

    if (!operation.source_path) {
      throw new Error(
        `Operation ${operation.id} has no source path to restore.`,
      );
    }

    const source = resolveLibraryPath(root, operation.source_path);
    await assertSafeParent(root, operation.destination_path);
    await assertSafeParent(root, operation.source_path);
    const currentInfo = await lstat(destination);
    if (currentInfo.isSymbolicLink()) {
      throw new Error(
        `Cannot undo through a symbolic link: ${operation.destination_path}`,
      );
    }

    const caseOnly = isCaseOnlyRename(
      operation.destination_path,
      operation.source_path,
    );
    if ((await pathExists(source)) && !caseOnly) {
      throw new Error(
        `Cannot restore ${operation.source_path}; the original path is occupied.`,
      );
    }

    await renameSafely(destination, source, caseOnly);
  }

  private async undoWrite(
    root: string,
    destination: string,
    operation: StoredOperation,
  ): Promise<void> {
    await assertSafeParent(root, operation.destination_path);
    const currentInfo = await lstat(destination);
    if (currentInfo.isSymbolicLink() || !currentInfo.isFile()) {
      throw new Error(
        `Cannot undo a write through a symbolic link or non-file: ${operation.destination_path}`,
      );
    }
    if (!operation.output_hash) {
      throw new Error(`Operation ${operation.id} has no output hash.`);
    }
    const currentHash = hashBytes(await readFile(destination));
    if (currentHash !== operation.output_hash) {
      throw new Error(
        `Cannot undo ${operation.destination_path}; the file changed after it was written.`,
      );
    }

    if (!operation.backup_exists) {
      await unlink(destination);
      return;
    }
    if (!operation.backup_path || !operation.backup_hash) {
      throw new Error(`Operation ${operation.id} has incomplete backup data.`);
    }

    const dataRoot = await realpath(this.dataDirectory);
    const backupPath = resolveBackupPath(dataRoot, operation.backup_path);
    await assertSafeBackupParent(dataRoot, operation.backup_path);
    const backupInfo = await lstat(backupPath);
    if (backupInfo.isSymbolicLink() || !backupInfo.isFile()) {
      throw new Error(
        `Operation backup is not a regular file: ${operation.id}`,
      );
    }
    const backup = await readFile(backupPath);
    if (hashBytes(backup) !== operation.backup_hash) {
      throw new Error(`Operation backup is corrupt: ${operation.id}`);
    }
    await writeBytesAtomically(destination, backup);
  }
}

async function renameSafely(
  source: string,
  destination: string,
  caseOnly: boolean,
): Promise<void> {
  if (!caseOnly) {
    await rename(source, destination);
    return;
  }

  const intermediate = resolve(
    dirname(source),
    `.${basename(source)}.reelkeeper-${randomUUID()}.tmp`,
  );
  await rename(source, intermediate);
  try {
    await rename(intermediate, destination);
  } catch (error) {
    try {
      await rename(intermediate, source);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        'Case-only rename failed and the original path could not be restored.',
        { cause: restoreError },
      );
    }
    throw new Error(
      'Case-only rename failed; the original path was restored.',
      { cause: error },
    );
  }
}

async function assertSafeParent(
  root: string,
  relativePath: string,
): Promise<void> {
  const segments = validateRelativePath(relativePath);
  if (segments.length < 2) {
    return;
  }

  const parent = resolve(root, segments[0] ?? '');
  const parentInfo = await lstat(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new Error(`Unsafe movie-folder path: ${segments[0]}`);
  }
}

async function assertSafeBackupParent(
  root: string,
  relativePath: string,
): Promise<void> {
  const segments = relativePath.split('/');
  if (
    segments.length !== 3 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.includes('\\') ||
        /^[a-z]:/i.test(segment),
    )
  ) {
    throw new Error(`Invalid application backup path: ${relativePath}`);
  }

  for (let index = 1; index < segments.length; index += 1) {
    const parent = resolve(root, ...segments.slice(0, index));
    try {
      const info = await lstat(parent);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`Unsafe application backup directory: ${parent}`);
      }
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT')) {
        throw error;
      }
      return;
    }
  }
}

function resolveBackupPath(root: string, relativePath: string): string {
  const segments = relativePath.split('/');
  if (
    segments.length !== 3 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.includes('\\') ||
        /^[a-z]:/i.test(segment),
    )
  ) {
    throw new Error(`Invalid application backup path: ${relativePath}`);
  }
  const absolutePath = resolve(root, ...segments);
  const fromRoot = relative(root, absolutePath);
  if (
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error('Backup path escapes the application data directory.');
  }
  return absolutePath;
}

function resolveLibraryPath(root: string, relativePath: string): string {
  const segments = validateRelativePath(relativePath);
  const absolutePath = resolve(root, ...segments);
  const fromRoot = relative(root, absolutePath);
  if (
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`Path escapes the movie-library root: ${relativePath}`);
  }
  return absolutePath;
}

function validateRelativePath(relativePath: string): string[] {
  const segments = relativePath.split('/');
  if (
    !relativePath ||
    relativePath.includes('\\') ||
    segments.length > 2 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        /^[a-z]:/i.test(segment),
    )
  ) {
    throw new Error(`Invalid relative movie-library path: ${relativePath}`);
  }
  return segments;
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await lstat(absolutePath);
    return true;
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
}

function isCaseOnlyRename(from: string, to: string): boolean {
  return (
    from !== to &&
    from.toLocaleLowerCase('en-US') === to.toLocaleLowerCase('en-US')
  );
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateOperationShape(operation: ExecutableOperation): void {
  if (isWriteOperation(operation)) {
    if (operation.from !== undefined) {
      throw new Error('File writes cannot have a source path.');
    }
    if (
      (operation.type === 'write_nfo' &&
        (typeof operation.content !== 'string' || !operation.content.trim())) ||
      (operation.type === 'write_image' &&
        typeof operation.content === 'string')
    ) {
      throw new Error(`Invalid content for ${operation.type} operation.`);
    }
    validateRelativePath(operation.to);
    return;
  }

  if (operation.type === 'mkdir') {
    if (operation.from) {
      throw new Error('Directory creation cannot have a source path.');
    }
    if (operation.to.includes('/')) {
      throw new Error('Movie folders must be directly under the library root.');
    }
    validateRelativePath(operation.to);
    return;
  }

  validateRelativePath(operation.to);
  if (operation.from) {
    validateRelativePath(operation.from);
  }
  if (!operation.from) {
    throw new Error(`${operation.type} operation is missing a source path.`);
  }
}

function toStoredOperation(
  row: {
    id: string;
    operation: ExecutableOperation;
  },
  effects: WriteEffects | null,
): StoredOperation {
  return {
    id: row.id,
    type: row.operation.type,
    source_path: row.operation.from ?? null,
    destination_path: row.operation.to,
    requires_intermediate_rename: row.operation.requiresIntermediateRename
      ? 1
      : 0,
    status: 'pending',
    backup_path: effects?.backupPath ?? null,
    backup_exists: effects?.backupExists ? 1 : 0,
    backup_hash: effects?.backupHash ?? null,
    output_hash: effects?.outputHash ?? null,
  };
}

function isWriteOperation(
  operation: ExecutableOperation,
): operation is ExecutableWrite {
  return operation.type === 'write_nfo' || operation.type === 'write_image';
}

function isStoredWriteOperation(
  operation: StoredOperation,
): operation is StoredOperation & {
  type: 'write_nfo' | 'write_image';
} {
  return operation.type === 'write_nfo' || operation.type === 'write_image';
}

function toBuffer(content: string | Uint8Array): Buffer {
  return typeof content === 'string'
    ? Buffer.from(content, 'utf8')
    : Buffer.from(content);
}

function hashBytes(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

async function writeBytesAtomically(
  destination: string,
  content: Uint8Array,
): Promise<void> {
  const temporary = resolve(
    dirname(destination),
    `.${basename(destination)}.reelkeeper-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, content, { flag: 'wx' });
    await rename(temporary, destination);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      if (!isErrorCode(cleanupError, 'ENOENT')) {
        throw new AggregateError(
          [error, cleanupError],
          `Atomic write failed and temporary file cleanup failed: ${destination}`,
          { cause: cleanupError },
        );
      }
    }
    throw error;
  }
}
