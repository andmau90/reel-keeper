import { lstat, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

const VIDEO_EXTENSIONS = new Set([
  '.mkv',
  '.mp4',
  '.avi',
  '.mov',
  '.wmv',
  '.m4v',
  '.mpg',
  '.mpeg',
  '.ts',
  '.m2ts',
  '.webm',
  '.flv',
  '.ogv',
  '.3gp',
]);

/**
 * Describes a loose video file and its filename-linked companions.
 */
export interface ScannedLooseFile {
  /** Entry kind used by the pure placement planner. */
  kind: 'loose_file';
  /** Video path relative to the library root. */
  sourcePath: string;
  /** NFO/subtitle sidecars linked by the video filename. */
  companions: string[];
}

/**
 * Describes an existing flat movie folder.
 */
export interface ScannedMovieFolder {
  /** Entry kind used by the pure placement planner. */
  kind: 'existing_folder';
  /** Folder path relative to the library root. */
  folderPath: string;
  /** Video paths directly inside the folder. */
  videoPaths: string[];
  /** Linked sidecars and folder-level poster/fanart images. */
  companions: string[];
}

/**
 * Contains one non-recursive scan's entries and occupied paths.
 */
export interface LibraryScanResult {
  /** Loose videos and folders containing at least one video. */
  entries: Array<ScannedLooseFile | ScannedMovieFolder>;
  /** Existing root entries and their direct children, relative to the root. */
  existingPaths: string[];
}

/**
 * Scans only the library root and one level inside movie folders.
 *
 * Symbolic links are recorded as occupied paths but are not followed or
 * returned as files, preventing the scanner from traversing outside the root.
 *
 * @param libraryRoot Absolute path to the configured movie-library root.
 * @returns Sorted movie entries and paths used for collision checks.
 * @throws If the root or any directory being scanned cannot be read.
 */
export async function scanLibrary(
  libraryRoot: string,
): Promise<LibraryScanResult> {
  const root = await realpath(libraryRoot);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) {
    throw new Error('The configured movie-library root is not a directory.');
  }

  const rootEntries = await readdir(root, { withFileTypes: true });
  rootEntries.sort((left, right) => left.name.localeCompare(right.name));

  const entries: Array<ScannedLooseFile | ScannedMovieFolder> = [];
  const existingPaths: string[] = [];

  for (const rootEntry of rootEntries) {
    existingPaths.push(rootEntry.name);

    if (rootEntry.isFile()) {
      if (isVideoFile(rootEntry.name)) {
        entries.push({
          kind: 'loose_file',
          sourcePath: rootEntry.name,
          companions: findLinkedCompanions(
            rootEntries
              .filter((entry) => entry.isFile())
              .map((entry) => entry.name),
            rootEntry.name,
          ),
        });
      }
      continue;
    }

    if (!rootEntry.isDirectory()) {
      continue;
    }

    const folderPath = rootEntry.name;
    const folderEntries = await readdir(join(root, folderPath), {
      withFileTypes: true,
    });
    folderEntries.sort((left, right) => left.name.localeCompare(right.name));
    const childPaths = folderEntries.map(
      (entry) => `${folderPath}/${entry.name}`,
    );
    existingPaths.push(...childPaths);

    const videoNames = folderEntries
      .filter((entry) => entry.isFile() && isVideoFile(entry.name))
      .map((entry) => entry.name);
    if (videoNames.length === 0) {
      continue;
    }

    const fileNames = folderEntries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    const companions = fileNames.filter(
      (name) =>
        isFolderArtwork(name) ||
        videoNames.some((videoName) => isLinkedCompanion(name, videoName)),
    );

    entries.push({
      kind: 'existing_folder',
      folderPath,
      videoPaths: videoNames.map((name) => `${folderPath}/${name}`),
      companions: companions.map((name) => `${folderPath}/${name}`),
    });
  }

  entries.sort((left, right) =>
    entryPath(left).localeCompare(entryPath(right)),
  );
  existingPaths.sort((left, right) => left.localeCompare(right));

  return {
    entries,
    existingPaths: [...new Set(existingPaths)],
  };
}

function isVideoFile(filename: string): boolean {
  const extension = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  return VIDEO_EXTENSIONS.has(extension);
}

function findLinkedCompanions(
  filenames: string[],
  videoFilename: string,
): string[] {
  return filenames.filter(
    (filename) =>
      filename !== videoFilename && isLinkedCompanion(filename, videoFilename),
  );
}

function isLinkedCompanion(filename: string, videoFilename: string): boolean {
  const videoStem = removeExtension(videoFilename).toLocaleLowerCase('en-US');
  return (
    filename.toLocaleLowerCase('en-US').startsWith(`${videoStem}.`) &&
    filename.toLocaleLowerCase('en-US') !==
      videoFilename.toLocaleLowerCase('en-US')
  );
}

function isFolderArtwork(filename: string): boolean {
  return /^(?:poster|fanart)\.(?:jpe?g|png|webp)$/i.test(filename);
}

function removeExtension(filename: string): string {
  const extensionIndex = filename.lastIndexOf('.');
  return extensionIndex > 0 ? filename.slice(0, extensionIndex) : filename;
}

function entryPath(entry: ScannedLooseFile | ScannedMovieFolder): string {
  return entry.kind === 'loose_file' ? entry.sourcePath : entry.folderPath;
}
