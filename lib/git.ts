/**
 * Git and GitHub CLI operations for worktree management.
 * Uses Bun's native $ shell API for all subprocess calls.
 */

import { $ } from "bun"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Worktree {
  path: string
  head: string
  branch: string | null
  isBare: boolean
  isMain: boolean
  isLocked: boolean
  lockReason: string | null
  isPrunable: boolean
  prunableReason: string | null
  isDetached: boolean
}

export interface PrInfo {
  number: number
  state: "OPEN" | "CLOSED" | "MERGED"
  url: string
  title: string
}

export type PrStatus =
  | { type: "loading" }
  | { type: "found"; pr: PrInfo }
  | { type: "none" }
  | { type: "error"; message: string }
  | { type: "skipped" }

export interface FileStatus {
  /** Staged files (added/modified/deleted in index) */
  staged: number
  /** Unstaged modifications to tracked files */
  modified: number
  /** Untracked files */
  untracked: number
  /** Commits ahead of remote tracking branch */
  ahead: number
  /** Commits behind remote tracking branch */
  behind: number
}

export type FileStatusResult =
  | { type: "loading" }
  | { type: "clean" }
  | { type: "dirty"; status: FileStatus }
  | { type: "error" }

/** Diagnostic result from checking gh CLI availability. */
export type GhDiagnostic =
  | { type: "checking" }
  | { type: "available" }
  | { type: "not-installed" }
  | { type: "not-authenticated"; detail: string }

// ---------------------------------------------------------------------------
// Worktree operations
// ---------------------------------------------------------------------------

/**
 * Parse `git worktree list --porcelain` into structured data.
 * The first entry is always the main worktree.
 */
export async function listWorktrees(): Promise<Worktree[]> {
  const result = await $`git worktree list --porcelain`.nothrow().quiet()
  if (result.exitCode !== 0) return []

  const stdout = result.stdout.toString()
  const blocks = stdout.trim().split("\n\n")
  const worktrees: Worktree[] = []

  for (const block of blocks) {
    const lines = block.trim().split("\n")
    let path = ""
    let head = ""
    let branch: string | null = null
    let isBare = false
    let isDetached = false
    let isLocked = false
    let lockReason: string | null = null
    let isPrunable = false
    let prunableReason: string | null = null

    for (const line of lines) {
      if (line.startsWith("worktree ")) path = line.slice(9)
      else if (line.startsWith("HEAD ")) head = line.slice(5)
      else if (line.startsWith("branch "))
        branch = line.slice(7).replace("refs/heads/", "")
      else if (line === "bare") isBare = true
      else if (line === "detached") isDetached = true
      else if (line === "locked") isLocked = true
      else if (line.startsWith("locked ")) {
        isLocked = true
        lockReason = line.slice(7)
      } else if (line === "prunable") isPrunable = true
      else if (line.startsWith("prunable ")) {
        isPrunable = true
        prunableReason = line.slice(9)
      }
    }

    if (path) {
      worktrees.push({
        path,
        head,
        branch,
        isBare,
        isMain: worktrees.length === 0,
        isLocked,
        lockReason,
        isPrunable,
        prunableReason,
        isDetached,
      })
    }
  }

  return worktrees
}

/**
 * Remove a worktree directory and its git administrative tracking.
 * Use force when the worktree has uncommitted changes.
 */
export async function removeWorktree(
  path: string,
  force = false,
): Promise<{ ok: boolean; error?: string }> {
  const flags = force ? ["--force"] : []
  const result = await $`git worktree remove ${flags} ${path}`.nothrow().quiet()
  if (result.exitCode !== 0) {
    return { ok: false, error: result.stderr.toString().trim() }
  }
  return { ok: true }
}

/**
 * Dry-run prune to show what stale references would be cleaned.
 * Returns human-readable descriptions of each stale entry.
 */
export async function pruneWorktreesDryRun(): Promise<string[]> {
  const result = await $`git worktree prune --dry-run -v`.nothrow().quiet()
  return result.stdout.toString().trim().split("\n").filter(Boolean)
}

/** Actually prune stale worktree references. */
export async function pruneWorktrees(): Promise<{
  ok: boolean
  error?: string
}> {
  const result = await $`git worktree prune`.nothrow().quiet()
  if (result.exitCode !== 0) {
    return { ok: false, error: result.stderr.toString().trim() }
  }
  return { ok: true }
}

/**
 * Delete a local git branch.
 * Force (-D) deletes even when not fully merged.
 */
export async function deleteBranch(
  name: string,
  force = false,
): Promise<{ ok: boolean; error?: string }> {
  const flag = force ? "-D" : "-d"
  const result = await $`git branch ${flag} ${name}`.nothrow().quiet()
  if (result.exitCode !== 0) {
    return { ok: false, error: result.stderr.toString().trim() }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// File status (per-worktree)
// ---------------------------------------------------------------------------

/**
 * Get the working tree status for a specific worktree path.
 * Uses `git -C <path> status --porcelain=v2 --branch` to parse
 * staged, modified, untracked counts and ahead/behind info.
 */
export async function fetchWorktreeFileStatus(
  worktreePath: string,
): Promise<FileStatusResult> {
  const result =
    await $`git -C ${worktreePath} status --porcelain=v2 --branch`
      .nothrow()
      .quiet()

  if (result.exitCode !== 0) return { type: "error" }

  const stdout = result.stdout.toString()
  let staged = 0
  let modified = 0
  let untracked = 0
  let ahead = 0
  let behind = 0

  for (const line of stdout.split("\n")) {
    if (line.startsWith("# branch.ab ")) {
      // Format: "# branch.ab +N -M"
      const match = line.match(/\+(\d+) -(\d+)/)
      if (match) {
        ahead = parseInt(match[1], 10)
        behind = parseInt(match[2], 10)
      }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      // Ordinary/rename entries: XY field is chars 2-3
      const xy = line.slice(2, 4)
      const indexStatus = xy[0]
      const worktreeStatus = xy[1]
      if (indexStatus !== ".") staged++
      if (worktreeStatus !== ".") modified++
    } else if (line.startsWith("u ")) {
      // Unmerged entry - count as modified
      modified++
    } else if (line.startsWith("? ")) {
      untracked++
    }
  }

  const isDirty = staged + modified + untracked + ahead + behind > 0
  if (!isDirty) return { type: "clean" }

  return {
    type: "dirty",
    status: { staged, modified, untracked, ahead, behind },
  }
}

// ---------------------------------------------------------------------------
// Directory size
// ---------------------------------------------------------------------------

export type DirSize =
  | { type: "loading" }
  | { type: "done"; bytes: number }
  | { type: "error" }

/**
 * Get the total size of a directory using `du -sk`.
 * Returns size in bytes. Uses -sk (kilobytes, no follow symlinks)
 * to keep it fast -- avoids traversing linked node_modules twice.
 */
export async function fetchDirectorySize(
  dirPath: string,
): Promise<DirSize> {
  const result = await $`du -sk ${dirPath}`.nothrow().quiet()
  if (result.exitCode !== 0) return { type: "error" }

  const kb = parseInt(result.stdout.toString().split("\t")[0], 10)
  if (isNaN(kb)) return { type: "error" }

  return { type: "done", bytes: kb * 1024 }
}

/** Format bytes into a human-readable string (e.g. "9.4 GB", "29 MB"). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

// ---------------------------------------------------------------------------
// File list (per-worktree)
// ---------------------------------------------------------------------------

/** A single file entry from git status with its change type. */
export interface FileEntry {
  path: string
  status: "staged" | "modified" | "untracked" | "unmerged"
}

/**
 * Get the list of changed files in a worktree.
 * Returns individual file paths with their status category.
 */
export async function fetchWorktreeFileList(
  worktreePath: string,
): Promise<FileEntry[]> {
  const result =
    await $`git -C ${worktreePath} status --porcelain=v2 --branch`
      .nothrow()
      .quiet()

  if (result.exitCode !== 0) return []

  const entries: FileEntry[] = []

  for (const line of result.stdout.toString().split("\n")) {
    if (line.startsWith("1 ")) {
      // Ordinary entry: "1 XY sub mH mI mW hH hI path"
      const xy = line.slice(2, 4)
      const path = line.split("\t")[0]?.split(" ").pop() ?? line.slice(113)
      // Parse path from the fixed-width porcelain v2 format
      const parts = line.split(" ")
      const filePath = parts.slice(8).join(" ")
      if (xy[0] !== ".") entries.push({ path: filePath, status: "staged" })
      else if (xy[1] !== ".") entries.push({ path: filePath, status: "modified" })
    } else if (line.startsWith("2 ")) {
      // Rename entry: "2 XY sub mH mI mW hH hI X\tscore\tpath\torigPath"
      const tabParts = line.split("\t")
      const filePath = tabParts[1] ?? ""
      entries.push({ path: filePath, status: "staged" })
    } else if (line.startsWith("u ")) {
      // Unmerged: "u XY sub m1 m2 m3 mW h1 h2 h3 path"
      const parts = line.split(" ")
      entries.push({ path: parts.slice(10).join(" "), status: "unmerged" })
    } else if (line.startsWith("? ")) {
      entries.push({ path: line.slice(2), status: "untracked" })
    }
  }

  return entries
}

/**
 * Open a directory in the system file manager.
 * macOS: Finder, Linux: xdg-open, Windows: explorer.
 */
export async function openDirectory(path: string): Promise<void> {
  const platform = process.platform
  if (platform === "darwin") {
    await $`open ${path}`.nothrow().quiet()
  } else if (platform === "win32") {
    await $`explorer ${path}`.nothrow().quiet()
  } else {
    await $`xdg-open ${path}`.nothrow().quiet()
  }
}

// ---------------------------------------------------------------------------
// GitHub CLI diagnostics
// ---------------------------------------------------------------------------

/**
 * Determine the availability of the `gh` CLI.
 * Uses `Bun.which` to check the binary exists on PATH, then
 * attempts a lightweight repo query to verify auth/repo access.
 */
export async function checkGhStatus(): Promise<GhDiagnostic> {
  // Fast path: check if the binary is on PATH at all
  if (!Bun.which("gh")) {
    return { type: "not-installed" }
  }

  // Binary exists - verify it can actually query this repo (auth + repo context)
  const result = await $`gh repo view --json name`.nothrow().quiet()
  if (result.exitCode === 0) {
    return { type: "available" }
  }

  const stderr = result.stderr.toString()
  return {
    type: "not-authenticated",
    detail: stderr.trim().split("\n")[0] ?? "unknown error",
  }
}

// ---------------------------------------------------------------------------
// GitHub PR lookups
// ---------------------------------------------------------------------------

/**
 * Fetch the most recent PR for a branch via `gh` CLI.
 * Returns null when no PR exists or gh is unavailable.
 */
export async function fetchPrForBranch(
  branch: string,
): Promise<PrInfo | null> {
  const result =
    await $`gh pr list --head ${branch} --state all --json number,state,url,title --limit 5`
      .nothrow()
      .quiet()

  if (result.exitCode !== 0) return null

  try {
    const prs = JSON.parse(result.stdout.toString()) as Array<{
      number: number
      state: string
      url: string
      title: string
    }>
    if (prs.length === 0) return null

    // Most recent PR first
    prs.sort((a, b) => b.number - a.number)
    const pr = prs[0]
    return {
      number: pr.number,
      state: pr.state as PrInfo["state"],
      url: pr.url,
      title: pr.title,
    }
  } catch {
    return null
  }
}
