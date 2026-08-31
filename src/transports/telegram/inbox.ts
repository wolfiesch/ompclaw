import { lstat, mkdir, open, opendir, unlink } from "node:fs/promises";
import * as path from "node:path";

export const MAX_INBOUND_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_INBOX_BYTES = 250 * 1024 * 1024;
export const INBOX_FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface InboxEntry {
  readonly absolutePath: string;
  readonly byteLength: number;
  readonly modifiedAt: number;
}

export interface InboxRetentionPolicy {
  readonly now?: number;
  readonly maxBytes?: number;
  readonly ttlMs?: number;
  readonly protectedPaths?: ReadonlySet<string>;
}

async function inventory(directory: string): Promise<InboxEntry[]> {
  const entries: InboxEntry[] = [];
  const handle = await opendir(directory);
  for await (const entry of handle) {
    if (!entry.isFile()) continue;
    const absolutePath = path.join(directory, entry.name);
    try {
      const metadata = await lstat(absolutePath);
      if (metadata.isFile()) {
        entries.push({ absolutePath, byteLength: metadata.size, modifiedAt: metadata.mtimeMs });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return entries;
}

async function discard(entry: InboxEntry, removed: string[]): Promise<number> {
  try {
    await unlink(entry.absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  removed.push(entry.absolutePath);
  return entry.byteLength;
}

export async function enforceInboxRetention(
  directory: string,
  policy: InboxRetentionPolicy = {},
): Promise<{ readonly byteLength: number; readonly removedPaths: readonly string[] }> {
  const root = path.resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const protectedPaths = new Set(
    [...(policy.protectedPaths ?? [])].map((candidate) => path.resolve(candidate)),
  );
  const deadline = (policy.now ?? Date.now()) - (policy.ttlMs ?? INBOX_FILE_TTL_MS);
  const limit = policy.maxBytes ?? MAX_INBOX_BYTES;
  const entries = await inventory(root);
  let byteLength = entries.reduce((sum, entry) => sum + entry.byteLength, 0);
  const removedPaths: string[] = [];
  const survivors: InboxEntry[] = [];

  for (const entry of entries) {
    if (entry.modifiedAt < deadline && !protectedPaths.has(entry.absolutePath)) {
      byteLength -= await discard(entry, removedPaths);
    } else {
      survivors.push(entry);
    }
  }

  survivors.sort((left, right) => left.modifiedAt - right.modifiedAt || left.absolutePath.localeCompare(right.absolutePath));
  for (const entry of survivors) {
    if (byteLength <= limit) break;
    if (protectedPaths.has(entry.absolutePath)) continue;
    byteLength -= await discard(entry, removedPaths);
  }
  return { byteLength, removedPaths };
}
export interface InboxAttachmentWrite {
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly protect?: ReadonlySet<string>;
}


export async function saveInboxAttachment(
  directory: string,
  attachment: InboxAttachmentWrite,
): Promise<string> {
  if (attachment.bytes.byteLength > MAX_INBOUND_ATTACHMENT_BYTES) {
    throw new Error(
      `Telegram attachment is too large (${attachment.bytes.byteLength} bytes, max ${MAX_INBOUND_ATTACHMENT_BYTES})`,
    );
  }
  const root = path.resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const destination = path.join(root, path.basename(attachment.filename));
  const file = await open(destination, "wx", 0o600);
  try {
    await file.writeFile(attachment.bytes);
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(destination).catch(() => undefined);
    throw error;
  }
  await file.close();

  try {
    const result = await enforceInboxRetention(root, {
      protectedPaths: new Set([destination, ...(attachment.protect ?? [])]),
    });
    if (result.byteLength > MAX_INBOX_BYTES) {
      throw new Error(
        `Telegram inbox quota exceeded (${result.byteLength} bytes, max ${MAX_INBOX_BYTES})`,
      );
    }
    return destination;
  } catch (error) {
    await unlink(destination).catch(() => undefined);
    throw error;
  }
}
