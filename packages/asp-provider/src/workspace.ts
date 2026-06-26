import type { ValidationWorkspace, ValidationWorkspaceFileSet, ValidationWorkspaceReadFileResult } from "@the-open-engine/opcore-validation";
import { calculateValidationFileChecksum } from "@the-open-engine/opcore-validation";
import type { JsonRpcPeer } from "./json-rpc.js";
import type { Baseline, ChangeSet, EncodedBlob, InitializedParams, InitializeParams, InlineBlob, JsonObject } from "./protocol.js";

export type AspHostValidationWorkspace = {
  workspace: ValidationWorkspace;
  readBlobText(blobId: string): Promise<string>;
  readInlineOrBlobText(blob: string | InlineBlob | undefined, label: string): Promise<string>;
  checksumForBlob(blobId: string): Promise<string>;
  readBlobIds(): readonly string[];
};

type TreeEntry = {
  path: string;
  blobId: string;
  kind?: string;
};

export function createAspHostValidationWorkspace(
  peer: JsonRpcPeer,
  initialize: InitializeParams,
  initialized: InitializedParams,
  changeset: ChangeSet
): AspHostValidationWorkspace {
  const baseline = initialized.baseline ?? initialize.workspace?.baseline ?? changeset.baseline;
  const entryByPath = new Map<string, TreeEntry>();
  const blobTextById = new Map<string, string>();
  const readSet = new Set<string>();

  async function listTree(paths?: readonly string[]): Promise<readonly TreeEntry[]> {
    const params: JsonObject = {
      baseline: baseline as unknown as JsonObject,
      globs: [...readGlobs(initialized)]
    };
    if (paths !== undefined) params.paths = [...paths];
    const result = (await peer.request("workspace/listTree", params, { timeoutMs: 30000 })) as {
      entries?: readonly unknown[];
      truncated?: boolean;
    };
    const entries = (result.entries ?? []).map(normalizeTreeEntry).filter((entry): entry is TreeEntry => entry !== undefined);
    for (const entry of entries) entryByPath.set(entry.path, entry);
    return entries;
  }

  async function readBlobText(blobId: string): Promise<string> {
    const cached = blobTextById.get(blobId);
    if (cached !== undefined) return cached;
    const result = (await peer.request("workspace/readBlob", { blobs: [blobId] }, { timeoutMs: 30000 })) as {
      blobs?: readonly EncodedBlob[];
    };
    const blob = (result.blobs ?? []).find((entry) => entry.id === blobId);
    if (blob === undefined) throw new Error(`Host did not return requested blob: ${blobId}`);
    const text = decodeBlob(blob);
    blobTextById.set(blobId, text);
    readSet.add(blob.id);
    return text;
  }

  async function readFile(path: string): Promise<ValidationWorkspaceReadFileResult> {
    let entry = entryByPath.get(path);
    if (entry === undefined) {
      const entries = await listTree([path]);
      entry = entries.find((candidate) => candidate.path === path);
    }
    if (entry === undefined) return { status: "missing" };
    return { status: "found", content: await readBlobText(entry.blobId) };
  }

  async function listRepoFiles(): Promise<ValidationWorkspaceFileSet> {
    const entries = await listTree();
    return {
      files: entries.map((entry) => ({ path: entry.path, status: "unchanged" as const }))
    };
  }

  const workspace: ValidationWorkspace = {
    readFile,
    listRepoFiles,
    listPackageFiles: async (_packageName, packageRoot) => {
      const files = await listRepoFiles();
      return {
        files: files.files.filter((file) => {
          const path = typeof file === "string" ? file : file.path;
          return path === packageRoot || path.startsWith(`${packageRoot}/`);
        })
      };
    }
  };

  return {
    workspace,
    readBlobText,
    readInlineOrBlobText: async (blob, label) => {
      if (typeof blob === "string") return readBlobText(blob);
      if (blob !== undefined && typeof blob === "object") return decodeInlineBlob(blob);
      throw new Error(`${label} must include an after blob`);
    },
    checksumForBlob: async (blobId) => calculateValidationFileChecksum(await readBlobText(blobId)),
    readBlobIds: () => [...readSet].sort()
  };
}

function readGlobs(initialized: InitializedParams): readonly string[] {
  const read = initialized.grantedPermissions?.read;
  return Array.isArray(read) ? [...read] : ["**/*"];
}

function normalizeTreeEntry(value: unknown): TreeEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as { path?: unknown; blobId?: unknown; kind?: unknown };
  if (typeof entry.path !== "string" || typeof entry.blobId !== "string") return undefined;
  if (entry.kind !== undefined && entry.kind !== "file") return undefined;
  return {
    path: entry.path,
    blobId: entry.blobId,
    kind: typeof entry.kind === "string" ? entry.kind : undefined
  };
}

function decodeBlob(blob: EncodedBlob): string {
  if (typeof blob.content === "string") return blob.content;
  if (typeof blob.bytes !== "string") throw new Error(`Host blob ${blob.id} is missing bytes`);
  return decodeBytes(blob.bytes, blob.encoding ?? "utf-8", `Host blob ${blob.id}`);
}

function decodeInlineBlob(blob: InlineBlob): string {
  if (typeof blob.bytes !== "string") throw new Error("Inline blob bytes must be a string");
  return decodeBytes(blob.bytes, blob.encoding ?? "utf-8", "Inline blob");
}

function decodeBytes(bytes: string, encoding: string, label: string): string {
  if (encoding === "utf-8" || encoding === "utf8") return bytes;
  if (encoding === "base64") return Buffer.from(bytes, "base64").toString("utf8");
  throw new Error(`${label} uses unsupported encoding: ${encoding}`);
}
