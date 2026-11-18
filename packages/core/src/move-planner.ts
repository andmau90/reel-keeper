import type { MoviePlacementRequest } from '@reelkeeper/shared';

/**
 * Describes one filesystem operation in a dry-run placement plan.
 */
export interface PlannedFileOperation {
  /** Operation to perform. */
  type: 'mkdir' | 'move' | 'rename';
  /** Source path, omitted for directory creation. */
  from?: string;
  /** Destination path relative to the movie-library root. */
  to: string;
  /** Whether a temporary intermediate name is needed for a case-only rename. */
  requiresIntermediateRename?: boolean;
}

/**
 * Explains why a placement could not be planned safely.
 */
export type MovePlanReviewReason =
  | 'ambiguous_layout'
  | 'destination_exists'
  | 'invalid_path'
  | 'invalid_title'
  | 'missing_year'
  | 'multiple_videos'
  | 'unmatched_companion';

/**
 * Contains filesystem operations or a review reason for one movie.
 */
export interface MovieMovePlan {
  /** Whether the input is actionable, already correct, or needs review. */
  status: 'ready' | 'no_op' | 'review';
  /** Set when status is review. */
  reviewReason: MovePlanReviewReason | null;
  /** True when a person must approve the planned filesystem changes. */
  requiresApproval: boolean;
  /** Ordered operations; directory moves precede child-file renames. */
  operations: PlannedFileOperation[];
}

/**
 * Plans a safe, flat-library placement without touching the filesystem.
 *
 * Loose files are moved into a new movie folder. Existing folders are renamed
 * only when they contain exactly one video. Every actionable plan requires
 * approval, and ambiguous inputs or collisions produce no operations.
 *
 * @param input Validated movie placement data.
 * @returns An ordered dry-run plan or a reason for manual review.
 */
export function planMove(input: MoviePlacementRequest): MovieMovePlan {
  if (input.movie.year === null) {
    return reviewPlan('missing_year');
  }

  const folderName = formatMovieFolderName(input.movie.title, input.movie.year);
  if (!folderName) {
    return reviewPlan('invalid_title');
  }

  const existingPaths = normalizePathList(input.existingPaths ?? []);
  if (!existingPaths) {
    return reviewPlan('invalid_path');
  }

  if (input.kind === 'loose_file') {
    const sourcePath = normalizeRelativePath(input.sourcePath);
    if (!sourcePath) {
      return reviewPlan('invalid_path');
    }

    if (sourcePath.includes('/')) {
      return reviewPlan('ambiguous_layout');
    }

    const companions = normalizePathList(input.companions ?? []);
    if (!companions) {
      return reviewPlan('invalid_path');
    }

    return planLooseFile(sourcePath, companions, folderName, existingPaths);
  }

  const folderPath = normalizeRelativePath(input.folderPath);
  const videoPaths = normalizePathList(input.videoPaths);
  const companions = normalizePathList(input.companions ?? []);

  if (!folderPath || !videoPaths || !companions) {
    return reviewPlan('invalid_path');
  }

  if (folderPath.includes('/')) {
    return reviewPlan('ambiguous_layout');
  }

  if (videoPaths.length !== 1) {
    return reviewPlan('multiple_videos');
  }

  return planExistingFolder(
    folderPath,
    videoPaths[0] ?? '',
    companions,
    folderName,
    existingPaths,
  );
}

/**
 * Creates the standard folder name and replaces Windows/SMB-invalid characters.
 *
 * @param title Matched movie title.
 * @param year Matched movie release year.
 * @returns A sanitized folder name, or null when the title has no usable text.
 */
export function formatMovieFolderName(
  title: string,
  year: number,
): string | null {
  const safeTitle = title
    .replace(/:/g, ' -')
    .replace(/[<>"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();

  return safeTitle ? `${safeTitle} (${year})` : null;
}

function planLooseFile(
  sourcePath: string,
  companions: string[],
  folderName: string,
  existingPaths: string[],
): MovieMovePlan {
  const sourceName = basename(sourcePath);
  const sourceStem = removeExtension(sourceName);
  const extension = getExtension(sourceName);
  const videoName = `${folderName}${extension}`;
  const targetFolder = folderName;
  const targetVideoPath = `${targetFolder}/${videoName}`;
  const operations: PlannedFileOperation[] = [
    { type: 'mkdir', to: targetFolder },
    { type: 'move', from: sourcePath, to: targetVideoPath },
  ];

  const companionTargets = planCompanionTargets(
    companions,
    sourcePath,
    sourceStem,
    targetFolder,
    folderName,
  );
  if (!companionTargets) {
    return reviewPlan('unmatched_companion');
  }

  operations.push(
    ...companionTargets.map(({ from, to }) => ({
      type: 'move' as const,
      from,
      to,
    })),
  );

  const sourcePaths = [sourcePath, ...companions];
  if (hasDestinationCollision(operations, existingPaths, sourcePaths)) {
    return reviewPlan('destination_exists');
  }

  return readyPlan(operations);
}

function planExistingFolder(
  folderPath: string,
  videoPath: string,
  companions: string[],
  targetFolder: string,
  existingPaths: string[],
): MovieMovePlan {
  const folderSegments = videoPath.split('/');
  if (folderSegments.length !== 2 || folderSegments[0] !== folderPath) {
    return reviewPlan('ambiguous_layout');
  }

  const videoName = folderSegments[1] ?? '';
  const sourceStem = removeExtension(videoName);
  const extension = getExtension(videoName);
  const targetVideoName = `${targetFolder}${extension}`;
  const folderMoves = folderPath !== targetFolder;
  const operations: PlannedFileOperation[] = [];

  if (folderMoves) {
    operations.push({
      type: 'rename',
      from: folderPath,
      to: targetFolder,
      ...(isCaseOnlyRename(folderPath, targetFolder)
        ? { requiresIntermediateRename: true }
        : {}),
    });
  }

  const postFolderVideoPath = `${targetFolder}/${videoName}`;
  const targetVideoPath = `${targetFolder}/${targetVideoName}`;
  if (postFolderVideoPath !== targetVideoPath) {
    operations.push({
      type: 'rename',
      from: postFolderVideoPath,
      to: targetVideoPath,
      ...(isCaseOnlyRename(postFolderVideoPath, targetVideoPath)
        ? { requiresIntermediateRename: true }
        : {}),
    });
  }

  const linkedCompanions = companions.filter(
    (companion) => !isFolderArtwork(basename(companion)),
  );
  const companionTargets = planCompanionTargets(
    linkedCompanions,
    videoPath,
    sourceStem,
    targetFolder,
    targetFolder,
  );
  if (!companionTargets) {
    return reviewPlan('unmatched_companion');
  }

  operations.push(
    ...companionTargets.flatMap(({ from, to }) => {
      const postFolderFrom = `${targetFolder}/${basename(from)}`;
      const postFolderTo = `${targetFolder}/${basename(to)}`;
      if (postFolderFrom === postFolderTo) {
        return [];
      }

      return [
        {
          type: 'rename' as const,
          from: postFolderFrom,
          to: postFolderTo,
          ...(isCaseOnlyRename(postFolderFrom, postFolderTo)
            ? { requiresIntermediateRename: true }
            : {}),
        },
      ];
    }),
  );

  const sourcePaths = [folderPath, videoPath, ...companions];
  if (hasDestinationCollision(operations, existingPaths, sourcePaths)) {
    return reviewPlan('destination_exists');
  }

  return operations.length > 0 ? readyPlan(operations) : noOpPlan();
}

function isFolderArtwork(filename: string): boolean {
  return /^(?:poster|fanart)\.(?:jpe?g|png|webp)$/i.test(filename);
}

function planCompanionTargets(
  companions: string[],
  videoPath: string,
  videoStem: string,
  targetFolder: string,
  targetVideoBase: string,
): Array<{ from: string; to: string }> | null {
  const videoDirectory = parentPath(videoPath);
  const videoStemLower = videoStem.toLocaleLowerCase('en-US');
  const targetBase = removeExtension(targetVideoBase);
  const result: Array<{ from: string; to: string }> = [];

  for (const companion of companions) {
    if (parentPath(companion) !== videoDirectory) {
      return null;
    }

    const companionName = basename(companion);
    const companionLower = companionName.toLocaleLowerCase('en-US');
    const suffix = companionName.slice(videoStem.length);
    if (
      !companionLower.startsWith(videoStemLower) ||
      suffix[0] !== '.' ||
      suffix.length < 2
    ) {
      return null;
    }

    result.push({
      from: companion,
      to: `${targetFolder}/${targetBase}${suffix}`,
    });
  }

  return result;
}

function hasDestinationCollision(
  operations: PlannedFileOperation[],
  existingPaths: string[],
  sourcePaths: string[],
): boolean {
  const existing = new Set(existingPaths.map(normalizeCase));
  const sources = new Set(sourcePaths.map(normalizeCase));
  const plannedDestinations = new Set<string>();

  for (const operation of operations) {
    const destination = normalizeCase(operation.to);
    if (
      (existing.has(destination) && !sources.has(destination)) ||
      plannedDestinations.has(destination)
    ) {
      return true;
    }

    plannedDestinations.add(destination);
  }

  return false;
}

function normalizePathList(paths: string[]): string[] | null {
  const result: string[] = [];
  for (const path of paths) {
    const normalized = normalizeRelativePath(path);
    if (!normalized) {
      return null;
    }
    result.push(normalized);
  }
  return result;
}

function normalizeRelativePath(path: string): string | null {
  const normalized = path.replaceAll('\\', '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[a-z]:/i.test(normalized)
  ) {
    return null;
  }

  const segments = normalized.split('/');
  if (
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return null;
  }

  return segments.join('/');
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf('/');
  return separator === -1 ? '' : path.slice(0, separator);
}

function getExtension(filename: string): string {
  const index = filename.lastIndexOf('.');
  return index > 0 ? filename.slice(index) : '';
}

function removeExtension(filename: string): string {
  return filename.slice(0, filename.length - getExtension(filename).length);
}

function normalizeCase(path: string): string {
  return path.toLocaleLowerCase('en-US');
}

function isCaseOnlyRename(from: string, to: string): boolean {
  return from !== to && normalizeCase(from) === normalizeCase(to);
}

function readyPlan(operations: PlannedFileOperation[]): MovieMovePlan {
  return {
    status: 'ready',
    reviewReason: null,
    requiresApproval: true,
    operations,
  };
}

function noOpPlan(): MovieMovePlan {
  return {
    status: 'no_op',
    reviewReason: null,
    requiresApproval: false,
    operations: [],
  };
}

function reviewPlan(reason: MovePlanReviewReason): MovieMovePlan {
  return {
    status: 'review',
    reviewReason: reason,
    requiresApproval: false,
    operations: [],
  };
}
