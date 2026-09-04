import {
  RUNTIME_COMMANDS,
  type RuntimeCommandDefinition,
  type RuntimeCommandGroup,
} from "./rpc-commands";

export type CommandCatalogSource = "gateway" | "omp" | "skill";
export type CommandCatalogVisibility = "authorization-required" | "public";

export interface OmpAvailableCommand {
  readonly name: string;
  readonly description?: string;
  readonly source?: string;
}

export interface CommandCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly source: CommandCatalogSource;
  readonly visibility: CommandCatalogVisibility;
  readonly group: RuntimeCommandGroup | "OMP" | "Skills";
}

export interface CommandCatalogGroup {
  readonly name: CommandCatalogEntry["group"];
  readonly entries: readonly CommandCatalogEntry[];
}

export interface CommandCatalogOptions {
  readonly ompCommands?: readonly OmpAvailableCommand[];
  readonly allowRpcBash?: boolean;
}

interface SearchResult {
  readonly entry: CommandCatalogEntry;
  readonly rank: number;
  readonly recentIndex: number;
}

const GROUP_ORDER: readonly CommandCatalogEntry["group"][] = [
  "Everyday",
  "Session",
  "Work",
  "Advanced",
  "OMP",
  "Skills",
];

function normalizedName(value: string): string | undefined {
  const name = value.trim().replace(/^\/+/, "").toLowerCase();
  return /^[a-z][a-z0-9_-]*$/.test(name) ? name : undefined;
}

function normalizedDescription(value: string | undefined): string {
  return value?.trim() ?? "";
}

function ompEntry(command: OmpAvailableCommand): CommandCatalogEntry | undefined {
  const name = normalizedName(command.name);
  if (name === undefined) return undefined;
  const source: CommandCatalogSource = command.source === "skill" ? "skill" : "omp";
  return {
    name,
    description: normalizedDescription(command.description),
    source,
    visibility: "authorization-required",
    group: source === "skill" ? "Skills" : "OMP",
  };
}

function gatewayEntry(command: RuntimeCommandDefinition): CommandCatalogEntry {
  return {
    name: command.command,
    description: command.description,
    source: "gateway",
    visibility: "authorization-required",
    group: command.group ?? "Advanced",
  };
}

function rpcBashEntries(): readonly CommandCatalogEntry[] {
  return [
    {
      name: "shell",
      description: "Execute an OMP RPC bash command",
      source: "gateway",
      visibility: "authorization-required",
      group: "Advanced",
    },
    {
      name: "abortbash",
      description: "Abort the active RPC bash command",
      source: "gateway",
      visibility: "authorization-required",
      group: "Advanced",
    },
  ];
}

function searchRank(entry: CommandCatalogEntry, query: string): number {
  if (query.length === 0) return 0;
  if (entry.name.startsWith(query)) return 3;
  if (entry.name.includes(query)) return 2;
  return entry.description.toLowerCase().includes(query) ? 1 : -1;
}

/**
 * A normalized, deterministic view of commands that gateway transports may
 * discover without talking to OMP themselves.
 */
export class CommandCatalog {
  readonly #entries: readonly CommandCatalogEntry[];

  constructor(options: CommandCatalogOptions = {}) {
    const byName = new Map<string, CommandCatalogEntry>();
    for (const command of RUNTIME_COMMANDS) {
      const entry = gatewayEntry(command);
      byName.set(entry.name, entry);
    }
    if (options.allowRpcBash) {
      for (const entry of rpcBashEntries()) byName.set(entry.name, entry);
    }
    for (const command of options.ompCommands ?? []) {
      const entry = ompEntry(command);
      if (entry !== undefined && !byName.has(entry.name)) byName.set(entry.name, entry);
    }
    this.#entries = [...byName.values()];
  }

  entries(): readonly CommandCatalogEntry[] {
    return this.#entries;
  }

  find(name: string): CommandCatalogEntry | undefined {
    const normalized = normalizedName(name);
    return normalized === undefined ? undefined : this.#entries.find((entry) => entry.name === normalized);
  }

  groups(): readonly CommandCatalogGroup[] {
    const grouped = new Map<CommandCatalogEntry["group"], CommandCatalogEntry[]>();
    for (const group of GROUP_ORDER) grouped.set(group, []);
    for (const entry of this.#entries) grouped.get(entry.group)?.push(entry);
    return GROUP_ORDER.flatMap((name) => {
      const entries = grouped.get(name);
      return entries === undefined || entries.length === 0 ? [] : [{ name, entries }];
    });
  }

  search(query: string, recentNames: readonly string[] = []): readonly CommandCatalogEntry[] {
    const normalized = query.trim().toLowerCase();
    const recent = new Map<string, number>();
    recentNames.forEach((name, index) => {
      const normalizedNameValue = normalizedName(name);
      if (normalizedNameValue !== undefined && !recent.has(normalizedNameValue)) recent.set(normalizedNameValue, index);
    });
    const results: SearchResult[] = [];
    for (const entry of this.#entries) {
      const rank = searchRank(entry, normalized);
      if (rank >= 0) results.push({ entry, rank, recentIndex: recent.get(entry.name) ?? Number.MAX_SAFE_INTEGER });
    }
    results.sort(
      (left, right) =>
        right.rank - left.rank ||
        left.recentIndex - right.recentIndex ||
        left.entry.name.localeCompare(right.entry.name),
    );
    return results.map(({ entry }) => entry);
  }
}
