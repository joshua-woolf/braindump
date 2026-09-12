import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";
import { basename, join } from "node:path";
import { MAX_BACKUP_BYTES, type SavedBackup } from "./schema";

export class BackupFileError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 | 409 | 413,
  ) {
    super(message);
  }
}

function isMissing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function validName(name: string) {
  return (
    name.length <= 255 &&
    name === basename(name) &&
    !name.startsWith(".") &&
    !name.includes("\\") &&
    name
      .split("")
      .every(
        (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ) &&
    name.toLowerCase().endsWith(".json")
  );
}

export function backupDirectory(dir: string, create = false) {
  if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new BackupFileError(
        "The backup folder must be a regular directory.",
        400,
      );
    return dir;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export function listBackups(backupDir: string): SavedBackup[] {
  const dir = backupDirectory(backupDir);
  if (!dir) return [];
  const backups: SavedBackup[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !validName(entry.name)) continue;
    try {
      const stat = lstatSync(join(dir, entry.name));
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      backups.push({
        name: entry.name,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    } catch (error) {
      // Automatic retention can remove an entry while the directory is being listed.
      if (!isMissing(error)) throw error;
    }
  }
  return backups.sort(
    (a, b) =>
      b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name),
  );
}

export function readBackup(backupDir: string, name: string) {
  if (!validName(name))
    throw new BackupFileError("Invalid backup filename.", 400);
  const dir = backupDirectory(backupDir);
  if (!dir)
    throw new BackupFileError("Backup not found. Refresh the list.", 404);
  const path = join(dir, name);
  let fd: number | undefined;
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new BackupFileError(
        "Only regular backup files are available.",
        400,
      );
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    if (!stat.isFile())
      throw new BackupFileError("Not a regular backup file.", 400);
    if (stat.size > MAX_BACKUP_BYTES)
      throw new BackupFileError("Backup exceeds the 256 MB limit.", 413);
    // Read only the verified length through the opened descriptor, never a swapped path.
    const content = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < content.length) {
      const read = readSync(
        fd,
        content,
        offset,
        content.length - offset,
        offset,
      );
      if (!read)
        throw new BackupFileError(
          "Backup changed while reading. Try again.",
          409,
        );
      offset += read;
    }
    const after = fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      throw new BackupFileError(
        "Backup changed while reading. Try again.",
        409,
      );
    return content;
  } catch (error) {
    if (isMissing(error))
      throw new BackupFileError("Backup not found. Refresh the list.", 404);
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
