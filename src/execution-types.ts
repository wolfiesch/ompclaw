export interface ExecutionPolicy {
  readonly write: boolean;
  readonly commands: boolean;
  readonly network: boolean;
  readonly maxDurationMs: number;
}

export interface ProjectDefinition {
  readonly id: string;
  readonly name: string;
  readonly workspace: string;
  readonly workerId: string;
  readonly principals: readonly string[];
  readonly policy: ExecutionPolicy;
  readonly model?: string;
}

export interface SshWorkerDefinition {
  readonly id: string;
  readonly host: string;
  readonly command: readonly string[];
  readonly configFile: string;
  readonly knownHostsFile: string;
}

/** Created by the coordinator after authenticating the principal and resolving its project. */
export interface TaskExecutionContext {
  readonly projectId: string;
  readonly projectName: string;
  readonly workspace: string;
  readonly workerId: string;
  readonly policy: ExecutionPolicy;
  readonly expiresAt: number;
  readonly model?: string;
}

export interface ExecutionCheck {
  readonly command: string;
  readonly exitCode: number;
  readonly output: string;
}

export interface ExecutionArtifact {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly mediaType?: string;
  readonly size: number;
  readonly sha256: string;
}

/** Execution receipts, never inferred from assistant prose. */
export interface TaskEvidence {
  readonly projectId: string;
  readonly host: string;
  readonly revision?: string;
  readonly changedFiles: readonly string[];
  readonly checks: readonly ExecutionCheck[];
  readonly artifacts: readonly ExecutionArtifact[];
}

export type ExecutionOperation =
  | { readonly kind: "list"; readonly path: string }
  | { readonly kind: "read"; readonly path: string }
  | { readonly kind: "write"; readonly path: string; readonly content: string }
  | { readonly kind: "run"; readonly command: string; readonly writable: boolean; readonly network: boolean }
  | { readonly kind: "diff" }
  | { readonly kind: "artifact"; readonly path: string };

export interface ExecutionResult {
  readonly text: string;
  readonly changedFiles?: readonly string[];
  readonly revision?: string;
  readonly check?: ExecutionCheck;
  readonly artifact?: ExecutionArtifact;
  readonly artifactBase64?: string;
}

export interface ExecutionRequest {
  readonly context: TaskExecutionContext;
  readonly operation: ExecutionOperation;
  readonly approved: boolean;
}

export interface ProjectExecutor {
  execute(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult>;
}
