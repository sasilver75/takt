import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { EvidenceArtifact, EvidenceManifest } from "../domain.js";

export type LocalEvidenceFile = {
  sourcePath: string;
  repositoryPath: string;
};

const DURABLE_ARTIFACT_ROOT = "artifacts";
const MAX_DIRECTORY_FILES = 100;

export function normalizeEvidenceArtifactPath(value: string | undefined, workspacePath?: string): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (/^[A-Za-z]:[\\/]/.test(raw)) return null;
  let candidate = raw;
  if (path.isAbsolute(raw)) {
    if (workspacePath && isPathInside(workspacePath, raw)) {
      candidate = path.relative(workspacePath, raw);
    } else if (raw === "/workspace" || raw.startsWith("/workspace/")) {
      candidate = raw.slice("/workspace/".length);
    } else {
      return null;
    }
  }
  const normalized = path.posix.normalize(candidate.replace(/\\/g, "/"));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) return null;
  return normalized;
}

export function isDurableEvidenceArtifactPath(normalizedPath: string): boolean {
  return normalizedPath === DURABLE_ARTIFACT_ROOT || normalizedPath.startsWith(`${DURABLE_ARTIFACT_ROOT}/`);
}

export function localEvidenceArtifactRoots(manifest: EvidenceManifest | null | undefined, workspacePath: string): string[] {
  const roots = new Set<string>();
  for (const artifact of manifest?.artifacts ?? []) {
    if (artifact.url?.trim()) continue;
    const normalized = normalizeEvidenceArtifactPath(artifact.path, workspacePath);
    if (normalized && isDurableEvidenceArtifactPath(normalized)) roots.add(normalized);
  }
  return [...roots].sort();
}

export async function localEvidenceArtifactFiles(manifest: EvidenceManifest, workspacePath: string): Promise<LocalEvidenceFile[]> {
  const files = new Map<string, LocalEvidenceFile>();
  for (const root of localEvidenceArtifactRoots(manifest, workspacePath)) {
    const sourcePath = path.join(workspacePath, root);
    let info;
    try {
      info = await stat(sourcePath);
    } catch {
      continue;
    }
    if (info.isFile()) {
      files.set(root, { repositoryPath: root, sourcePath });
      continue;
    }
    if (!info.isDirectory()) continue;
    for (const file of await walkDirectory(sourcePath, root, MAX_DIRECTORY_FILES)) {
      files.set(file.repositoryPath, file);
    }
  }
  return [...files.values()].sort((a, b) => a.repositoryPath.localeCompare(b.repositoryPath));
}

export function evidenceArtifactWarningPath(artifact: EvidenceArtifact, workspacePath: string): string | null {
  return normalizeEvidenceArtifactPath(artifact.path, workspacePath);
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function walkDirectory(sourceRoot: string, repositoryRoot: string, maxFiles: number): Promise<LocalEvidenceFile[]> {
  const out: LocalEvidenceFile[] = [];
  async function visit(sourceDirectory: string, repositoryDirectory: string): Promise<void> {
    if (out.length >= maxFiles) return;
    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= maxFiles) return;
      const sourcePath = path.join(sourceDirectory, entry.name);
      const repositoryPath = path.posix.join(repositoryDirectory, entry.name);
      if (entry.isFile()) {
        out.push({ sourcePath, repositoryPath });
      } else if (entry.isDirectory()) {
        await visit(sourcePath, repositoryPath);
      }
    }
  }
  await visit(sourceRoot, repositoryRoot);
  return out;
}
