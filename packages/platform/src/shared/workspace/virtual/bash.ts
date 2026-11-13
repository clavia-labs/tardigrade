import type { BashOptions, InMemoryFs } from "just-bash/browser"
import { WorkspaceError, type WorkspacePolicy } from "@clavia/tardigrade-libraries/workspace/index"
import type { VirtualWorkspaceEntry, VirtualWorkspaceSnapshot } from "./sqlite"

export interface VirtualWorkspacePolicy extends WorkspacePolicy {
  readonly maxFileBytes: number
  readonly maxWorkspaceBytes?: number
  readonly maxWorkspaceEntries?: number
}
export type VirtualBashLimits = Omit<NonNullable<BashOptions["executionLimits"]>, "maxExecutionTimeMs" | "maxFileSystemBytes">
export type VirtualBashProfile = NonNullable<BashOptions["executionLimitProfile"]>
export const DEFAULT_VIRTUAL_BASH_PROFILE: VirtualBashProfile = "hardened"

export interface VirtualBashInput {
  readonly snapshot: VirtualWorkspaceSnapshot
  readonly command: string
  readonly directory: string
  readonly policy: VirtualWorkspacePolicy
  readonly executionLimits: VirtualBashLimits
  readonly executionLimitProfile: VirtualBashProfile
  readonly signal: AbortSignal
}
export interface VirtualBashResult {
  readonly snapshot: VirtualWorkspaceSnapshot
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}
export type VirtualWorkspaceExecutor = (input: VirtualBashInput) => Promise<VirtualBashResult>

// restoreVirtualFilesystem reconstructs binary files, directories, symlinks, and hard links from a snapshot.
export async function restoreVirtualFilesystem(snapshot: VirtualWorkspaceSnapshot, policy: VirtualWorkspacePolicy): Promise<InMemoryFs> {
  validateVirtualSnapshot(snapshot, policy)
  const { InMemoryFs } = await import("just-bash/browser")
  const fs = new InMemoryFs({}, { maxTotalBytes: policy.maxWorkspaceBytes ?? Number.MAX_SAFE_INTEGER })
  const directories = snapshot.entries.filter(entry => entry.kind === "directory").sort((a, b) => a.path.length - b.path.length)
  for (const entry of directories) await fs.mkdir(entry.path, { recursive: true })
  for (const entry of snapshot.entries) if (entry.kind === "file") fs.writeFileSync(entry.path, entry.content ?? new Uint8Array(), { encoding: "utf8" }, { mode: entry.mode, mtime: new Date(entry.mtime) })
  for (const entry of snapshot.entries) if (entry.kind === "hardlink") await fs.link(entry.target!, entry.path)
  for (const entry of snapshot.entries) if (entry.kind === "symlink") await fs.symlink(entry.target!, entry.path)
  for (const entry of directories) {
    await fs.chmod(entry.path, entry.mode)
    await fs.utimes(entry.path, new Date(entry.mtime), new Date(entry.mtime))
  }
  return fs
}

// validateVirtualSnapshot reports configured storage limits before a snapshot is loaded or committed.
export function validateVirtualSnapshot(snapshot: VirtualWorkspaceSnapshot, policy: VirtualWorkspacePolicy): void {
  if (policy.maxWorkspaceEntries !== undefined && snapshot.entries.length > policy.maxWorkspaceEntries) throw new WorkspaceError(`Workspace entry limit exceeded: ${snapshot.entries.length}, limit ${policy.maxWorkspaceEntries}`)
  for (const entry of snapshot.entries) if (entry.content && entry.content.byteLength > policy.maxFileBytes) throw new WorkspaceError(`File byte limit exceeded for ${entry.path}: ${entry.content.byteLength}, limit ${policy.maxFileBytes}`)
  const bytes = snapshot.entries.reduce((sum, entry) => sum + (entry.content?.byteLength ?? 0) + new TextEncoder().encode(entry.path + (entry.target ?? "")).byteLength, 0)
  if (policy.maxWorkspaceBytes !== undefined && bytes > policy.maxWorkspaceBytes) throw new WorkspaceError(`Workspace byte limit exceeded: ${bytes}, limit ${policy.maxWorkspaceBytes}`)
}

// snapshotVirtualFilesystem preserves file identities across committed shell invocations.
export async function snapshotVirtualFilesystem(fs: InMemoryFs, revision: number, policy: VirtualWorkspacePolicy): Promise<VirtualWorkspaceSnapshot> {
  const entries: VirtualWorkspaceEntry[] = []
  const files = new Map<string, string>()
  for (const path of fs.getAllPaths().sort()) {
    const stat = await fs.lstat(path)
    const linked = stat.isFile && stat.identity ? files.get(stat.identity) : undefined
    const kind = stat.isSymbolicLink ? "symlink" : stat.isDirectory ? "directory" : linked ? "hardlink" : "file"
    entries.push({ path, kind, mode: stat.mode, mtime: stat.mtime.getTime(), content: kind === "file" ? await fs.readFileBuffer(path) : null, target: kind === "symlink" ? await fs.readlink(path) : linked ?? null })
    if (stat.isFile && stat.identity && !linked) files.set(stat.identity, path)
  }
  const snapshot = { revision, entries }
  validateVirtualSnapshot(snapshot, policy)
  return snapshot
}

// virtualWorkspacePath confines direct file tools to the workspace directory within the virtual filesystem.
export async function virtualWorkspacePath(fs: InMemoryFs, directory: string, path: string): Promise<string> {
  if (!path || path.includes("\0")) throw new WorkspaceError("Path must be nonempty and contain no NUL")
  const resolved = fs.resolvePath(directory, path)
  const contained = (value: string) => {
    if (directory !== "/" && value !== directory && !value.startsWith(`${directory}/`)) throw new WorkspaceError("Path is outside the workspace directory")
  }
  contained(resolved)
  let ancestor = resolved
  while (!(await fs.exists(ancestor))) {
    if ((await fs.readdir(ancestor.slice(0, ancestor.lastIndexOf("/")) || "/").catch(() => [] as string[])).includes(ancestor.slice(ancestor.lastIndexOf("/") + 1))) {
      throw new WorkspaceError("Path contains a dangling symlink")
    }
    ancestor = ancestor.slice(0, ancestor.lastIndexOf("/")) || "/"
  }
  contained(await fs.realpath(ancestor))
  return resolved
}

// virtualBash executes interpreted shell commands without host filesystem, network, Python, or JavaScript access.
export const virtualBash: VirtualWorkspaceExecutor = async input => {
  const fs = await restoreVirtualFilesystem(input.snapshot, input.policy)
  await fs.mkdir(input.directory, { recursive: true })
  const { Bash } = await import("just-bash/browser")
  const bash = new Bash({
    fs, cwd: input.directory,
    executionLimitProfile: input.executionLimitProfile,
    executionLimits: { ...input.executionLimits, maxExecutionTimeMs: input.policy.commandTimeoutMs, maxFileSystemBytes: input.policy.maxWorkspaceBytes ?? Infinity },
  })
  const result = await bash.exec(input.command, { signal: input.signal })
  if (input.signal.aborted) throw new WorkspaceError(`Command timed out or cancelled: commandTimeoutMs ${input.policy.commandTimeoutMs}`)
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, snapshot: await snapshotVirtualFilesystem(fs, input.snapshot.revision, input.policy) }
}
