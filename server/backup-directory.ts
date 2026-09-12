import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  futimesSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { BackupFileError, backupDirectory, listBackups } from "./backup-files";
import { backupDirectorySchema, type BackupDirectoryResult } from "./schema";

function unchanged(path: string, before: Stats) {
  const after = lstatSync(path);
  return (
    after.isFile() &&
    !after.isSymbolicLink() &&
    after.dev === before.dev &&
    after.ino === before.ino &&
    after.size === before.size &&
    after.mtimeMs === before.mtimeMs
  );
}

// Bounded descriptor copies work across volumes and never follow file symlinks.
function copyBackup(source: string, target: string, created: string[]) {
  const input = openSync(
    source,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let output: number | undefined;
  try {
    const before = fstatSync(input);
    if (!before.isFile())
      throw new BackupFileError("Only regular backup files can be moved.", 400);
    output = openSync(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    created.push(target);
    const buffer = Buffer.alloc(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const count = readSync(
        input,
        buffer,
        0,
        Math.min(buffer.length, before.size - offset),
        offset,
      );
      if (!count)
        throw new BackupFileError(
          "A backup changed during the move. Try again.",
          409,
        );
      let written = 0;
      while (written < count) {
        const size = writeSync(output, buffer, written, count - written);
        if (!size) throw new Error("Could not write the complete backup.");
        written += size;
      }
      offset += count;
    }
    if (!unchanged(source, before))
      throw new BackupFileError(
        "A backup changed during the move. Try again.",
        409,
      );
    futimesSync(output, before.atime, before.mtime);
    fsyncSync(output);
    return before;
  } finally {
    closeSync(input);
    if (output !== undefined) closeSync(output);
  }
}

export function moveBackupDirectory(
  current: string,
  input: unknown,
  commit: (directory: string) => void,
): BackupDirectoryResult {
  const { directory: value } = backupDirectorySchema.parse(input);
  const expanded =
    value === "~"
      ? homedir()
      : value.startsWith("~/")
        ? join(homedir(), value.slice(2))
        : value;
  if (!isAbsolute(expanded))
    throw new BackupFileError(
      "Enter an absolute folder path or a path starting with ~/.",
      400,
    );
  const requested = resolve(expanded);
  const source = backupDirectory(current)
    ? realpathSync(current)
    : resolve(current);
  // Reject the final symlink before canonicalizing parent aliases such as /tmp.
  backupDirectory(requested, true);
  const destination = realpathSync(requested);
  if (source === destination)
    return { directory: current, moved: 0, leftBehind: [] };
  if (
    destination.startsWith(source + sep) ||
    source.startsWith(destination + sep)
  )
    throw new BackupFileError(
      "Choose a separate folder, outside the current backup folder and its parents.",
      400,
    );

  const backups = listBackups(current);
  // Check every name first; never overwrite destination files, directories or symlinks.
  for (const backup of backups) {
    try {
      lstatSync(join(destination, backup.name));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        continue;
      throw error;
    }
    throw new BackupFileError(
      `The destination already contains ${backup.name}. Choose another folder or resolve the conflict first.`,
      409,
    );
  }
  const created: string[] = [];
  const originals = new Map<string, Stats>();
  try {
    // Probe writability even when there are no backups to move.
    const probe = join(destination, `.braindump-${crypto.randomUUID()}`);
    const fd = openSync(
      probe,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    closeSync(fd);
    unlinkSync(probe);
    for (const backup of backups) {
      const path = join(source, backup.name);
      originals.set(
        path,
        copyBackup(path, join(destination, backup.name), created),
      );
    }
    for (const [path, before] of originals) {
      if (!unchanged(path, before))
        throw new BackupFileError(
          "A backup changed during the move. Try again.",
          409,
        );
    }
    const directoryFd = openSync(
      destination,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
    // Commit only after all copies are complete. No source is removed on failure.
    commit(destination);
  } catch (error) {
    const leftovers: string[] = [];
    for (const path of created) {
      try {
        unlinkSync(path);
      } catch {
        leftovers.push(path);
      }
    }
    if (leftovers.length)
      throw new BackupFileError(
        `The backup folder was not changed; all originals are safe. Could not remove ${leftovers.length} copied file(s) from ${destination}. Remove those copies before retrying.`,
        409,
      );
    throw error;
  }
  const leftBehind: string[] = [];
  for (const [path, before] of originals) {
    try {
      // An external edit after copying must not be deleted.
      if (!unchanged(path, before)) throw new Error("Backup changed");
      unlinkSync(path);
    } catch {
      leftBehind.push(path);
    }
  }
  return {
    directory: destination,
    moved: backups.length - leftBehind.length,
    leftBehind,
  };
}
