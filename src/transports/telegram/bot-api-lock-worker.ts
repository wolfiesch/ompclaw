import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireLock, releaseLock } from "./bot-api";

const lockPath = process.argv[2];
const resultDirectory = process.argv[3];
const contender = process.argv[4];
if (!lockPath || !resultDirectory || !contender) throw new Error("missing lock race argument");

const claim = acquireLock(lockPath);
await writeFile(join(resultDirectory, contender), claim.ok ? "claimed" : "busy");
if (claim.ok) {
  await Bun.stdin.text();
  releaseLock(lockPath);
}
