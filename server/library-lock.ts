import { dlopen, FFIType } from "bun:ffi";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";

// flock is held by the kernel, survives stale marker files, and is released on
// process death. Never unlink the file: that would allow two locked inodes.
export function acquireLibraryLock(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(realpathSync(directory), ".worker.lock");
  const library =
    process.platform === "darwin"
      ? "/usr/lib/libSystem.B.dylib"
      : process.platform === "linux"
        ? "libc.so.6"
        : null;
  if (!library) throw new Error("Library locking supports macOS and Linux.");
  const native = dlopen(library, {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  let fd: number | undefined;
  try {
    fd = openSync(
      file,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1)
      throw new Error("Invalid library lock file.");
    if (native.symbols.flock(fd, 2 | 4) !== 0)
      throw new Error(
        "This library is already open in another Braindump process. Quit that process before opening it here.",
      );
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    native.close();
    throw error;
  }
  const lockedFd = fd;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    closeSync(lockedFd);
    native.close();
  };
}
