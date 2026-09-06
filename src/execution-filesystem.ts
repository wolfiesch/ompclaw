import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, lstatSync, mkdtempSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cc, FFIType } from "bun:ffi";
import nativeSource from "./execution-filesystem.c" with { type: "text" };

const MAX_WORKSPACE_PATH_BYTES = 4_096;
const ENOENT = 2;
const ENOTDIR = 20;

const sensitiveNames: Record<string, true> = {
  ".git": true,
  ".env": true,
  ".envrc": true,
  ".npmrc": true,
  ".yarnrc": true,
  ".yarnrc.yml": true,
  ".pnpmfile.cjs": true,
  ".bunfig.toml": true,
  ".omp": true,
  ".claude": true,
  ".codex": true,
  ".cursor": true,
};

interface OpenFlags {
  readonly atFdcwd: number;
  readonly directory: number;
  readonly noFollow: number;
  readonly nonBlock: number;
  readonly create: number;
  readonly exclusive: number;
  readonly readOnly: number;
  readonly writeOnly: number;
}

function openFlags(): OpenFlags {
  switch (process.platform) {
    case "darwin":
      return {
        atFdcwd: -2,
        directory: 0x100000,
        noFollow: 0x100,
        nonBlock: 0x4,
        create: 0x200,
        exclusive: 0x800,
        readOnly: 0,
        writeOnly: 1,
      };
    case "linux":
      return {
        atFdcwd: -100,
        directory: 0x10000,
        noFollow: 0x20000,
        create: 0x40,
        nonBlock: 0x800,
        exclusive: 0x80,
        readOnly: 0,
        writeOnly: 1,
      };
    default:
      throw new Error("Descriptor-relative workspace operations require a Darwin or Linux execution worker");
  }
}

interface NativeFilesystem {
  readonly openAt: (parentFd: number, name: string, flags: number) => number;
  readonly openAtCreate: (parentFd: number, name: string, flags: number, mode: number) => number;
  readonly renameAt: (oldParentFd: number, oldName: string, newParentFd: number, newName: string) => number;
  readonly unlinkAt: (parentFd: number, name: string, flags: number) => number;
  readonly errno: () => number;
  readonly directorySize: (parentFd: number) => number;
  readonly directoryRecords: (parentFd: number, output: Buffer) => number;
}

function cString(value: string): Buffer {
  return Buffer.from(`${value}\0`);
}

function createNativeFilesystem(): NativeFilesystem {
  const directory = mkdtempSync(join(tmpdir(), "ompclaw-execution-ffi-"));
  const source = join(directory, "execution-filesystem.c");
  try {
    writeFileSync(source, nativeSource, { mode: 0o600 });
    const library = cc({
      source,
      symbols: {
        omp_openat: {
          args: [FFIType.i32, FFIType.cstring, FFIType.i32],
          returns: FFIType.i32,
        },
        omp_openat_create: {
          args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.i32],
          returns: FFIType.i32,
        },
        omp_renameat: {
          args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring],
          returns: FFIType.i32,
        },
        omp_unlinkat: {
          args: [FFIType.i32, FFIType.cstring, FFIType.i32],
          returns: FFIType.i32,
        },
        omp_errno: {
          args: [],
          returns: FFIType.i32,
        },
        omp_list_directory_records: {
          args: [FFIType.i32, FFIType.ptr, FFIType.i32],
          returns: FFIType.i32,
        },
      },
    });
    return {
      openAt: (parentFd, name, flags) => library.symbols.omp_openat(parentFd, cString(name), flags),
      openAtCreate: (parentFd, name, flags, mode) =>
        library.symbols.omp_openat_create(parentFd, cString(name), flags, mode),
      renameAt: (oldParentFd, oldName, newParentFd, newName) =>
        library.symbols.omp_renameat(oldParentFd, cString(oldName), newParentFd, cString(newName)),
      unlinkAt: (parentFd, name, flags) => library.symbols.omp_unlinkat(parentFd, cString(name), flags),
      errno: library.symbols.omp_errno,
      directorySize: (parentFd) => library.symbols.omp_list_directory_records(parentFd, null, 0),
      directoryRecords: (parentFd, output) =>
        library.symbols.omp_list_directory_records(parentFd, output, output.length),
    };
  } catch (error) {
    throw new Error(
      `Native filesystem initialization failed. Use Bun 1.3.14 or newer with FFI and its embedded C compiler enabled, a writable temporary directory, and system C headers (libc6-dev on Debian/Ubuntu; Command Line Tools on macOS). ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

let loadedNativeFilesystem: NativeFilesystem | undefined;

function nativeFilesystem(): NativeFilesystem {
  openFlags();
  loadedNativeFilesystem ??= createNativeFilesystem();
  return loadedNativeFilesystem;
}

function descriptorPath(fd: number, name?: string): string {
  const base = process.platform === "linux" ? `/proc/self/fd/${fd}` : `/dev/fd/${fd}`;
  return name === undefined ? base : `${base}/${name}`;
}

function isSymlinkAt(parentFd: number, name: string): boolean {
  try {
    return lstatSync(descriptorPath(parentFd, name)).isSymbolicLink();
  } catch {
    return false;
  }
}

function pathFailure(
  parentFd: number,
  name: string,
  expected: "file" | "directory",
  filesystem: NativeFilesystem,
): never {
  const failure = filesystem.errno();
  if (failure === (process.platform === "darwin" ? 62 : 40) || isSymlinkAt(parentFd, name))
    throw new Error("Symbolic links are not allowed in workspace paths");
  if (failure === ENOTDIR)
    throw new Error(expected === "directory" ? "Path must name a directory" : "Path must name a regular file");
  throw new Error(`Unable to access workspace path (errno ${failure})`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface WorkspacePath {
  readonly components: readonly string[];
  readonly relative: string;
}

export interface ProtectedWorkspacePath {
  readonly relative: string;
  readonly directory: boolean;
}

/** Applies the execution policy's component-based sensitive-path rule. */
export function sensitiveWorkspacePath(path: string): boolean {
  return path.split(/[\\/]+/).some((part) => part.startsWith(".env.") || sensitiveNames[part] === true);
}

function parseWorkspacePath(supplied: string): WorkspacePath {
  assert(
    Buffer.byteLength(supplied, "utf8") <= MAX_WORKSPACE_PATH_BYTES && !supplied.includes("\0"),
    "Invalid workspace path",
  );
  assert(!supplied.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(supplied), "Workspace paths must be relative");
  const components: string[] = [];
  for (const part of (supplied === "" ? "." : supplied).split(/[\\/]+/)) {
    if (part === "" || part === ".") continue;
    assert(part !== "..", "Path escapes the project workspace");
    components.push(part);
  }
  const relative = components.join("/") || ".";
  assert(!sensitiveWorkspacePath(relative), "Path is prohibited by project execution policy");
  return { components, relative };
}

function openAt(parentFd: number, name: string, flags: number, mode: number, expected: "file" | "directory"): number {
  const filesystem = nativeFilesystem();
  const fd =
    (flags & openFlags().create) === 0
      ? filesystem.openAt(parentFd, name, flags)
      : filesystem.openAtCreate(parentFd, name, flags, mode);
  if (fd >= 0) return fd;
  pathFailure(parentFd, name, expected, filesystem);
}

function withRoot<T>(root: string, action: (rootFd: number) => T): T {
  const flags = openFlags();
  const rootFd = openAt(flags.atFdcwd, root, flags.readOnly | flags.directory | flags.noFollow, 0, "directory");
  try {
    return action(rootFd);
  } finally {
    closeSync(rootFd);
  }
}

function withDirectory<T>(rootFd: number, components: readonly string[], action: (directoryFd: number) => T): T {
  const flags = openFlags();
  let directoryFd = rootFd;
  try {
    for (const component of components) {
      const nextFd = openAt(directoryFd, component, flags.readOnly | flags.directory | flags.noFollow, 0, "directory");
      if (directoryFd !== rootFd) closeSync(directoryFd);
      directoryFd = nextFd;
    }
    return action(directoryFd);
  } finally {
    if (directoryFd !== rootFd) closeSync(directoryFd);
  }
}

function withParent<T>(rootFd: number, path: WorkspacePath, action: (parentFd: number, name: string) => T): T {
  assert(path.components.length > 0, "Cannot replace the project workspace");
  const name = path.components[path.components.length - 1]!;
  return withDirectory(rootFd, path.components.slice(0, -1), (parentFd) => action(parentFd, name));
}

function assertRegularFile(fd: number, message: string): void {
  assert(fstatSync(fd).isFile(), message);
}

function openExistingFile(parentFd: number, name: string): number {
  const flags = openFlags();
  return openAt(parentFd, name, flags.readOnly | flags.nonBlock | flags.noFollow, 0, "file");
}

function readBoundedFile(fd: number, limit: number, limitMessage: string): Buffer {
  const bytes = Buffer.allocUnsafe(limit + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const read = readSync(fd, bytes, offset, bytes.length - offset, null);
    if (read === 0) break;
    offset += read;
  }
  assert(offset <= limit, limitMessage);
  return bytes.subarray(0, offset);
}

/** Lists a directory reached entirely through held, no-follow descriptors. */
export function listWorkspaceDirectory(
  root: string,
  supplied: string,
): { readonly relative: string; readonly text: string } {
  const path = parseWorkspacePath(supplied);
  return withRoot(root, (rootFd) =>
    withDirectory(rootFd, path.components, (directoryFd) => {
      const filesystem = nativeFilesystem();
      const length = filesystem.directorySize(directoryFd);
      assert(length >= 0, `Unable to list workspace directory (errno ${filesystem.errno()})`);
      const records = Buffer.allocUnsafe(length);
      assert(
        filesystem.directoryRecords(directoryFd, records) === length,
        `Unable to list workspace directory (errno ${filesystem.errno()})`,
      );
      const entries: string[] = [];
      for (let offset = 0; offset < records.length; ) {
        const type = records[offset]!;
        const end = records.indexOf(0, offset + 1);
        assert(end >= 0, "Invalid directory entry record");
        const name = records.toString("utf8", offset + 1, end);
        entries.push(`${name}${type === 4 ? "/" : type === 10 ? "@" : ""}`);
        offset = end + 1;
      }
      return { relative: path.relative, text: entries.join("\n") };
    }),
  );
}

/** Enumerates policy-protected components through held descriptors without recursing into symlinks. */
export function protectedWorkspacePaths(root: string): readonly ProtectedWorkspacePath[] {
  return withRoot(root, (rootFd) => {
    const paths: ProtectedWorkspacePath[] = [];
    const flags = openFlags();
    const visit = (directoryFd: number, relativePath: string): void => {
      const filesystem = nativeFilesystem();
      const length = filesystem.directorySize(directoryFd);
      assert(length >= 0, `Unable to list workspace directory (errno ${filesystem.errno()})`);
      const records = Buffer.allocUnsafe(length);
      assert(
        filesystem.directoryRecords(directoryFd, records) === length,
        `Unable to list workspace directory (errno ${filesystem.errno()})`,
      );
      for (let offset = 0; offset < records.length; ) {
        const type = records[offset]!;
        const end = records.indexOf(0, offset + 1);
        assert(end >= 0, "Invalid directory entry record");
        const name = records.toString("utf8", offset + 1, end);
        offset = end + 1;
        const childRelative = relativePath.length === 0 ? name : `${relativePath}/${name}`;
        if (sensitiveWorkspacePath(childRelative)) {
          paths.push({ relative: childRelative, directory: type === 4 });
        } else if (type === 4) {
          const childFd = openAt(directoryFd, name, flags.readOnly | flags.directory | flags.noFollow, 0, "directory");
          try {
            visit(childFd, childRelative);
          } finally {
            closeSync(childFd);
          }
        }
      }
    };

    visit(rootFd, "");
    return paths;
  });
}

/** Reads a regular file reached entirely through held, no-follow descriptors. */
export function readWorkspaceFile(
  root: string,
  supplied: string,
  limit: number,
  limitMessage: string,
): { readonly relative: string; readonly bytes: Buffer } {
  const path = parseWorkspacePath(supplied);
  return withRoot(root, (rootFd) =>
    withParent(rootFd, path, (parentFd, name) => {
      const fileFd = openExistingFile(parentFd, name);
      try {
        const stat = fstatSync(fileFd);
        assert(stat.isFile(), "Path must name a regular file");
        assert(stat.size <= limit, limitMessage);
        const bytes = readBoundedFile(fileFd, limit, limitMessage);
        return { relative: path.relative, bytes };
      } finally {
        closeSync(fileFd);
      }
    }),
  );
}

/** Writes via a private sibling and renames while the containing directory remains held. */
export function writeWorkspaceFile(root: string, supplied: string, content: string): string {
  const path = parseWorkspacePath(supplied);
  return withRoot(root, (rootFd) =>
    withParent(rootFd, path, (parentFd, name) => {
      const flags = openFlags();
      const filesystem = nativeFilesystem();
      const existingFd = filesystem.openAt(parentFd, name, flags.readOnly | flags.nonBlock | flags.noFollow);
      if (existingFd >= 0) {
        try {
          assertRegularFile(existingFd, "Writes may only replace regular files");
        } finally {
          closeSync(existingFd);
        }
      } else {
        const failure = filesystem.errno();
        if (failure !== ENOENT) pathFailure(parentFd, name, "file", filesystem);
      }

      const temporary = `.ompclaw-${randomUUID()}.tmp`;
      const temporaryFd = openAt(
        parentFd,
        temporary,
        flags.writeOnly | flags.create | flags.exclusive | flags.noFollow,
        0o600,
        "file",
      );
      let renamed = false;
      try {
        try {
          writeFileSync(temporaryFd, content, "utf8");
          fsyncSync(temporaryFd);
        } finally {
          closeSync(temporaryFd);
        }
        if (filesystem.renameAt(parentFd, temporary, parentFd, name) !== 0) {
          throw new Error(`Unable to replace workspace file (errno ${filesystem.errno()})`);
        }
        renamed = true;
      } finally {
        if (!renamed) filesystem.unlinkAt(parentFd, temporary, 0);
      }
      return path.relative;
    }),
  );
}
