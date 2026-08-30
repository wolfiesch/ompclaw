import { copyFileSync, existsSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RpcRuntimeConfig } from "./rpc-config";

const LINKED_DIRECTORIES = ["skills", "rules", "commands", "agents", "docs", "bin"] as const;
const COPIED_FILES = ["AGENTS.md", "RULES.md", "SYSTEM.md", "WATCHDOG.md", "APPEND_SYSTEM.md", "config.yml", "mcp.json", "models.yml", "ssh.json"] as const;

/**
 * Seed a named transport profile with the default profile's harness surface.
 * Runtime databases, sessions, blobs, credentials, and .env are deliberately excluded.
 */
export function prepareInheritedHarness(config: RpcRuntimeConfig): string | undefined {
  if (!config.inheritHarness) return undefined;
  if (!/^[A-Za-z0-9._-]+$/.test(config.profile)) throw new Error("Profile name contains unsupported characters");
  const root = process.env.OMP_HOME ?? join(homedir(), ".omp");
  const source = join(root, "agent");
  const target = join(root, "profiles", config.profile, "agent");
  if (!existsSync(source)) throw new Error(`Default OMP agent directory not found: ${source}`);
  mkdirSync(target, { recursive: true, mode: 0o700 });

  for (const name of LINKED_DIRECTORIES) {
    const from = join(source, name);
    const to = join(target, name);
    if (!existsSync(from) || existsSync(to)) continue;
    symlinkSync(from, to, lstatSync(from).isDirectory() ? "dir" : "file");
  }
  for (const name of COPIED_FILES) {
    const from = join(source, name);
    const to = join(target, name);
    if (!existsSync(from) || existsSync(to)) continue;
    copyFileSync(from, to);
  }
  return target;
}
