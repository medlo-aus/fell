/**
 * Git and GitHub CLI operations for worktree management.
 * Uses Bun's native $ shell API for all subprocess calls.
 */

import { $ } from "bun"
import { readdir } from "node:fs/promises"

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
 *
 * Handles zombie worktrees (directory exists but .git file is missing):
 * falls back to `git worktree prune` to clean the reference, then
 * removes the leftover directory manually.
 */
export async function removeWorktree(
  path: string,
  force = false,
): Promise<{ ok: boolean; error?: string }> {
  const flags = force ? ["--force"] : []
  const result = await $`git worktree remove ${flags} ${path}`.nothrow().quiet()

  if (result.exitCode === 0) return { ok: true }

  const stderr = result.stderr.toString().trim()

  // Zombie worktree: directory exists but .git is missing.
  // git worktree remove refuses to act, so we prune the reference
  // and remove the leftover directory ourselves.
  const isZombie =
    stderr.includes("does not exist") &&
    (stderr.includes(".git") || stderr.includes("validation failed"))

  if (isZombie) {
    // Prune cleans the stale git reference
    await $`git worktree prune`.nothrow().quiet()

    // Remove the leftover directory if it still exists
    await $`rm -rf ${path}`.nothrow().quiet()

    return { ok: true }
  }

  return { ok: false, error: stderr }
}

/**
 * Dry-run prune to show what stale references would be cleaned.
 * Returns human-readable descriptions of each stale entry.
 * Note: git writes prune verbose output to stderr, not stdout.
 */
export async function pruneWorktreesDryRun(): Promise<string[]> {
  const result = await $`git worktree prune --dry-run -v`.nothrow().quiet()
  const output = result.stderr.toString().trim()
  if (!output) return []
  return output.split("\n").filter(Boolean)
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
// Worktree recycling operations
// ---------------------------------------------------------------------------

/**
 * Detach HEAD in a worktree, disconnecting it from its current branch.
 * Used to "release" a worktree for recycling.
 */
export async function detachHead(
  worktreePath: string,
): Promise<{ ok: boolean; error?: string }> {
  const result = await $`git -C ${worktreePath} checkout --detach HEAD`
    .nothrow()
    .quiet()
  if (result.exitCode !== 0) {
    return { ok: false, error: result.stderr.toString().trim() }
  }
  return { ok: true }
}

/**
 * Fetch from origin in a worktree.
 */
export async function fetchOrigin(
  worktreePath: string,
): Promise<{ ok: boolean; error?: string }> {
  const result = await $`git -C ${worktreePath} fetch origin`
    .nothrow()
    .quiet()
  if (result.exitCode !== 0) {
    return { ok: false, error: result.stderr.toString().trim() }
  }
  return { ok: true }
}

/**
 * Check out a new branch in an existing worktree.
 * Tries remote tracking branch first (origin/<branch>),
 * falls back to creating from origin/HEAD (default branch).
 */
export async function checkoutNewBranch(
  worktreePath: string,
  branch: string,
): Promise<{ ok: boolean; error?: string }> {
  // Try remote tracking branch first
  const remote = await $`git -C ${worktreePath} checkout -b ${branch} origin/${branch}`
    .nothrow()
    .quiet()
  if (remote.exitCode === 0) return { ok: true }

  // Fall back to creating from origin/HEAD (default branch)
  const fromDefault = await $`git -C ${worktreePath} checkout -b ${branch} origin/HEAD`
    .nothrow()
    .quiet()
  if (fromDefault.exitCode === 0) return { ok: true }

  return { ok: false, error: fromDefault.stderr.toString().trim() }
}

/**
 * SHA-256 hash of the first lockfile found in a directory.
 * Checks common lockfile names in order. Returns null if none found.
 */
export async function hashLockfile(
  dirPath: string,
): Promise<string | null> {
  const lockfiles = [
    "bun.lockb", "bun.lock", "yarn.lock",
    "package-lock.json", "pnpm-lock.yaml",
  ]
  for (const name of lockfiles) {
    const file = Bun.file(`${dirPath}/${name}`)
    if (await file.exists()) {
      const hasher = new Bun.CryptoHasher("sha256")
      hasher.update(await file.arrayBuffer())
      return hasher.digest("hex")
    }
  }
  return null
}

/**
 * Rename a worktree directory and repair git's internal pointer.
 * Uses `mv` (instant on same filesystem) then `git worktree repair`
 * to update <main-repo>/.git/worktrees/<name>/gitdir.
 *
 * On repair failure, attempts to roll back the mv.
 */
export async function renameWorktree(
  oldPath: string,
  newPath: string,
): Promise<{ ok: boolean; error?: string }> {
  if (oldPath === newPath) return { ok: true }

  const mvResult = await $`mv ${oldPath} ${newPath}`.nothrow().quiet()
  if (mvResult.exitCode !== 0) {
    return { ok: false, error: mvResult.stderr.toString().trim() }
  }

  const repairResult = await $`git worktree repair ${newPath}`.nothrow().quiet()
  if (repairResult.exitCode !== 0) {
    // Roll back: move it back to the original path
    await $`mv ${newPath} ${oldPath}`.nothrow().quiet()
    return { ok: false, error: repairResult.stderr.toString().trim() }
  }

  return { ok: true }
}

/**
 * Find the next available N for a `wt-detached-N` slot in the given directory.
 * Scans existing entries matching the pattern and returns max + 1.
 */
export async function findNextDetachedSlot(parentDir: string): Promise<number> {
  try {
    const entries = await readdir(parentDir)
    const pattern = /^wt-detached-(\d+)$/
    let maxN = 0
    for (const entry of entries) {
      const match = entry.match(pattern)
      if (match) {
        const n = parseInt(match[1], 10)
        if (!isNaN(n) && n > maxN) maxN = n
      }
    }
    return maxN + 1
  } catch {
    return 1
  }
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

// ---------------------------------------------------------------------------
// Size cache (/tmp/fell-size-cache.json)
// ---------------------------------------------------------------------------

const SIZE_CACHE_PATH = "/tmp/fell-size-cache.json"
const SIZE_CACHE_TTL = 10 * 60 * 1000 // 10 minutes

interface SizeCacheEntry { bytes: number; ts: number }
type SizeCache = Record<string, SizeCacheEntry>

let _sizeCache: SizeCache | null = null

async function loadSizeCache(): Promise<SizeCache> {
  if (_sizeCache) return _sizeCache
  try {
    const file = Bun.file(SIZE_CACHE_PATH)
    if (await file.exists()) {
      _sizeCache = JSON.parse(await file.text()) as SizeCache
      return _sizeCache
    }
  } catch { /* corrupt or missing — start fresh */ }
  _sizeCache = {}
  return _sizeCache
}

async function writeSizeCache(cache: SizeCache): Promise<void> {
  try {
    await Bun.write(SIZE_CACHE_PATH, JSON.stringify(cache))
  } catch { /* /tmp write failure — non-fatal */ }
}

/**
 * Get the total size of a directory using `du -sk`.
 * Returns size in bytes. Uses -sk (kilobytes, no follow symlinks)
 * to keep it fast -- avoids traversing linked node_modules twice.
 *
 * Results are cached in /tmp/fell-size-cache.json with a 10-minute TTL.
 */
export async function fetchDirectorySize(
  dirPath: string,
): Promise<DirSize> {
  const cache = await loadSizeCache()
  const entry = cache[dirPath]
  if (entry && (Date.now() - entry.ts) < SIZE_CACHE_TTL) {
    return { type: "done", bytes: entry.bytes }
  }

  const result = await $`du -sk ${dirPath}`.nothrow().quiet()
  if (result.exitCode !== 0) return { type: "error" }

  const kb = parseInt(result.stdout.toString().split("\t")[0], 10)
  if (isNaN(kb)) return { type: "error" }

  const bytes = kb * 1024
  cache[dirPath] = { bytes, ts: Date.now() }
  await writeSizeCache(cache)

  return { type: "done", bytes }
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

/**
 * Open a directory in Cursor IDE.
 */
export async function openInCursor(path: string): Promise<void> {
  await $`cursor ${path}`.nothrow().quiet()
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

// ---------------------------------------------------------------------------
// Claude Code session lookups
// ---------------------------------------------------------------------------

export interface SessionInfo {
  sessionCount: number
  latestSessionId: string
  /** First user message content from the most recent session, truncated. */
  latestPrompt: string
  /** ISO timestamp from the first user message. */
  latestTimestamp: string
}

export type SessionResult =
  | { type: "loading" }
  | { type: "found"; info: SessionInfo }
  | { type: "none" }

/**
 * Encode an absolute path into Claude Code's project directory name.
 * Claude replaces all non-alphanumeric characters with `-`,
 * so `/Users/x/.claude/worktrees/foo` becomes
 * `-Users-x--claude-worktrees-foo` (`.` and `/` both become `-`).
 */
function encodeClaudeProjectPath(absolutePath: string): string {
  return absolutePath.replace(/[^a-zA-Z0-9]/g, "-")
}

/**
 * Extract the first user prompt from a Claude Code session JSONL file.
 * Reads only the first ~15 lines for performance -- the user message
 * is almost always within the first few entries.
 */
async function extractFirstPrompt(
  jsonlPath: string,
): Promise<{ prompt: string; timestamp: string } | null> {
  try {
    const content = await Bun.file(jsonlPath).text()
    const lines = content.split("\n").slice(0, 15)

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        if (entry.type !== "user") continue

        const rawContent = entry.message?.content
        let text = ""
        if (typeof rawContent === "string") {
          text = rawContent
        } else if (Array.isArray(rawContent)) {
          // Array of content blocks: [{ type: "text", text: "..." }, ...]
          const textBlock = rawContent.find(
            (b: { type: string }) => b.type === "text",
          )
          text = textBlock?.text ?? ""
        }

        // Strip XML-like tags (e.g. <local-command-caveat>...) that aren't real prompts
        if (text.startsWith("<")) {
          // Try to find actual text after tags
          const stripped = text.replace(/<[^>]+>[^<]*<\/[^>]+>/g, "").trim()
          if (stripped) text = stripped
          else continue // skip entries that are purely XML tags
        }

        // Collapse whitespace/newlines into single spaces for display
        text = text.trim().replace(/\s+/g, " ")
        if (!text) continue

        return {
          prompt: text,
          timestamp: entry.timestamp ?? "",
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // File read failed
  }
  return null
}

/**
 * Extract the `cwd` from the first parseable line of a JSONL session file.
 * Used by the global scanner to recover the original absolute path
 * without decoding the project directory name (which is lossy).
 */
async function extractCwd(jsonlPath: string): Promise<string | null> {
  try {
    const content = await Bun.file(jsonlPath).text()
    for (const line of content.split("\n").slice(0, 10)) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        if (entry.cwd) return entry.cwd
      } catch {
        /* skip malformed */
      }
    }
  } catch {
    /* file read failed */
  }
  return null
}

// ---------------------------------------------------------------------------
// Global session scanner
// ---------------------------------------------------------------------------

/** A single project directory from ~/.claude/projects/ with session metadata. */
export interface GlobalProjectEntry {
  /** The original absolute working directory (extracted from JSONL cwd field). */
  cwd: string
  /** Whether this is a Claude Code worktree (path contains .claude/worktrees/). */
  isWorktree: boolean
  /** The repo root (path before /.claude/worktrees/, or the cwd itself for main repos). */
  repoRoot: string
  /** Worktree name (segment after .claude/worktrees/), null for main repo sessions. */
  worktreeName: string | null
  /** Number of session JSONL files. */
  sessionCount: number
  /** First user prompt from the most recent session. */
  latestPrompt: string
  /** ISO timestamp from the most recent session's first user message. */
  latestTimestamp: string
}

/** Sessions grouped by repo root. */
export interface GlobalRepoGroup {
  repoRoot: string
  /** Session entry for the main repo (non-worktree), if any. */
  main: GlobalProjectEntry | null
  /** Worktree session entries. */
  worktrees: GlobalProjectEntry[]
  /** Total sessions across main + all worktrees. */
  totalSessions: number
}

/**
 * Scan ~/.claude/projects/ for all Claude Code sessions across all repos.
 * Groups results by repo root. Excludes the specified repo (usually the
 * current repo, which is already shown in the main worktree list).
 *
 * Returns empty array if ~/.claude doesn't exist or has no sessions.
 * Never throws.
 */
export async function listGlobalClaudeSessions(
  excludeRepoRoot?: string,
): Promise<GlobalRepoGroup[]> {
  const home = process.env.HOME
  if (!home) return []

  const projectsDir = `${home}/.claude/projects`

  try {
    const { readdir, stat } = await import("node:fs/promises")
    const dirs = await readdir(projectsDir).catch(() => null)
    if (!dirs || dirs.length === 0) return []

    // Process each project directory concurrently
    const entries: GlobalProjectEntry[] = []
    const CONCURRENCY = 8
    const executing: Promise<void>[] = []

    const processDir = async (dirName: string) => {
      const dirPath = `${projectsDir}/${dirName}`

      // List JSONL files
      const files = await readdir(dirPath).catch(() => null)
      if (!files) return
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"))
      if (jsonlFiles.length === 0) return

      // Find most recent JSONL by mtime
      const withMtime = await Promise.all(
        jsonlFiles.map(async (f) => {
          const s = await stat(`${dirPath}/${f}`).catch(() => null)
          return { file: f, mtime: s?.mtimeMs ?? 0 }
        }),
      )
      withMtime.sort((a, b) => b.mtime - a.mtime)
      const latestFile = withMtime[0].file

      // Extract cwd from the most recent session to get the real path
      const cwd = await extractCwd(`${dirPath}/${latestFile}`)
      if (!cwd) return

      // Extract prompt from the most recent session
      const promptInfo = await extractFirstPrompt(`${dirPath}/${latestFile}`)

      // Determine if this is a worktree session
      const claudeWtMatch = cwd.match(/^(.+)\/.claude\/worktrees\/([^/]+)/)
      const cursorWtMatch = cwd.match(
        /^(.+)\/.cursor\/worktrees\/[^/]+\/([^/]+)/,
      )
      const wtMatch = claudeWtMatch ?? cursorWtMatch

      entries.push({
        cwd,
        isWorktree: !!wtMatch,
        repoRoot: wtMatch ? wtMatch[1] : cwd,
        worktreeName: wtMatch ? wtMatch[2] : null,
        sessionCount: jsonlFiles.length,
        latestPrompt: promptInfo?.prompt ?? "",
        latestTimestamp: promptInfo?.timestamp ?? "",
      })
    }

    // Process with concurrency limit
    for (const dirName of dirs) {
      const task = processDir(dirName)
      executing.push(task)
      task.then(() => {
        const idx = executing.indexOf(task)
        if (idx !== -1) executing.splice(idx, 1)
      })
      if (executing.length >= CONCURRENCY) {
        await Promise.race(executing)
      }
    }
    await Promise.all(executing)

    // Group by repo root
    const groups = new Map<string, GlobalRepoGroup>()

    for (const entry of entries) {
      // Skip the excluded repo
      if (excludeRepoRoot && entry.repoRoot === excludeRepoRoot) continue

      let group = groups.get(entry.repoRoot)
      if (!group) {
        group = { repoRoot: entry.repoRoot, main: null, worktrees: [], totalSessions: 0 }
        groups.set(entry.repoRoot, group)
      }

      group.totalSessions += entry.sessionCount

      if (entry.isWorktree) {
        group.worktrees.push(entry)
      } else {
        group.main = entry
      }
    }

    // Sort groups by total session count descending
    const result = Array.from(groups.values())
    result.sort((a, b) => b.totalSessions - a.totalSessions)

    // Sort worktrees within each group by session count descending
    for (const group of result) {
      group.worktrees.sort((a, b) => b.sessionCount - a.sessionCount)
    }

    return result
  } catch {
    return []
  }
}

/**
 * Look up Claude Code session info for a worktree by reading
 * `~/.claude/projects/{encoded-path}/` directly.
 *
 * Assumption: Claude Code encodes the worktree CWD by replacing `/` with `-`
 * to form the project directory name. Each `{uuid}.jsonl` file inside is a
 * session transcript. This is an undocumented internal format and may change.
 */
export async function fetchWorktreeSessionInfo(
  worktreePath: string,
): Promise<SessionResult> {
  const home = process.env.HOME
  if (!home) return { type: "none" }

  const encoded = encodeClaudeProjectPath(worktreePath)
  const projectDir = `${home}/.claude/projects/${encoded}`

  try {
    const { readdir, stat } = await import("node:fs/promises")
    const entries = await readdir(projectDir).catch(() => null)
    if (!entries) return { type: "none" }

    // Find all .jsonl files (each is a session)
    const jsonlFiles = entries.filter((e) => e.endsWith(".jsonl"))
    if (jsonlFiles.length === 0) return { type: "none" }

    // Sort by mtime descending to find the most recent session
    const withMtime = await Promise.all(
      jsonlFiles.map(async (f) => {
        const s = await stat(`${projectDir}/${f}`).catch(() => null)
        return { file: f, mtime: s?.mtimeMs ?? 0 }
      }),
    )
    withMtime.sort((a, b) => b.mtime - a.mtime)

    const latestFile = withMtime[0].file
    const latestSessionId = latestFile.replace(".jsonl", "")

    // Extract first user prompt from the most recent session
    const promptInfo = await extractFirstPrompt(
      `${projectDir}/${latestFile}`,
    )

    return {
      type: "found",
      info: {
        sessionCount: jsonlFiles.length,
        latestSessionId,
        latestPrompt: promptInfo?.prompt ?? "",
        latestTimestamp: promptInfo?.timestamp ?? "",
      },
    }
  } catch {
    return { type: "none" }
  }
}

// ---------------------------------------------------------------------------
// Parent session association (worktree <-> spawning session)
// ---------------------------------------------------------------------------

/*
 * FLOW DIAGRAM: How we match a worktree to the Claude Code session that created it
 *
 *   ~/.claude/sessions/
 *   ├── 15746.json  ─────────┐
 *   ├── 51087.json            │  Step 1: List active session PIDs
 *   └── 71924.json            │          Read each JSON for { sessionId, cwd }
 *                             │
 *                             ▼
 *   ┌─────────────────────────────────────────┐
 *   │  Active Session Registry                │
 *   │                                         │
 *   │  PID 15746                              │
 *   │    sessionId: 4491a274-...              │
 *   │    cwd: /Users/x/code/medlo             │
 *   │                                         │
 *   │  PID 51087                              │
 *   │    sessionId: e3408292-...              │
 *   │    cwd: /Users/x/code/medlo/            │
 *   │         .claude/worktrees/evo           │
 *   └──────────────┬──────────────────────────┘
 *                  │
 *                  │  Step 2: For each session, locate its JSONL transcript
 *                  │          at ~/.claude/projects/{encode(cwd)}/{sessionId}.jsonl
 *                  ▼
 *   ~/.claude/projects/-Users-x-code-medlo/
 *   └── 4491a274-....jsonl  ◄── Full conversation transcript (JSONL)
 *                  │
 *                  │  Step 3: grep the JSONL for each worktree path
 *                  │          e.g. ".worktrees/session-column"
 *                  │          (matches Bash tool calls like
 *                  │           `git worktree add .worktrees/session-column`)
 *                  ▼
 *   ┌─────────────────────────────────────────┐
 *   │  MATCH FOUND                            │
 *   │                                         │
 *   │  Session 4491a274 (cwd: ~/code/medlo)   │
 *   │  contains ".worktrees/session-column"   │
 *   │  in its transcript                      │
 *   │                                         │
 *   │  → This session CREATED the worktree    │
 *   └─────────────────────────────────────────┘
 *
 * WHY only active sessions:
 *   - ~/.claude/sessions/ only contains PIDs of RUNNING Claude Code processes
 *   - Completed sessions are removed from this registry
 *   - Scanning all historical sessions (121+ files, 185MB+) would be too slow
 *   - Active sessions are the most useful: "who is working in this worktree right now?"
 *
 * WHY grep instead of JSON parsing:
 *   - JSONL files can be 5MB+ per session (this conversation alone is ~5.5MB)
 *   - grep -l short-circuits on first match (doesn't read the whole file)
 *   - We only need to know IF the path appears, not WHERE or HOW
 *   - Bun's $ shell handles the subprocess efficiently
 *
 * PERFORMANCE:
 *   - Typically 5-15 active sessions
 *   - Each grep -l takes ~50-400ms depending on file size
 *   - Total: <2s for all active sessions, runs in background
 *   - Falls back gracefully if ~/.claude doesn't exist
 */

/** A Claude Code session that spawned or references a worktree. */
export interface ParentSession {
  /** The session UUID. */
  sessionId: string
  /** The working directory of the session (typically the main repo, not the worktree). */
  cwd: string
  /** First user prompt from the session, for identification. */
  prompt: string
}

export type ParentSessionResult =
  | { type: "loading" }
  | { type: "found"; session: ParentSession }
  | { type: "none" }

/**
 * Find the active Claude Code session that created or references a worktree.
 *
 * Scans `~/.claude/sessions/*.json` for running sessions, then greps each
 * session's JSONL transcript for the worktree path. Returns the first match.
 *
 * @param worktreePath - Absolute path to the worktree directory
 * @returns The parent session if found, or `{ type: "none" }` if no active
 *          session references this worktree. Never throws.
 */
export async function findParentSession(
  worktreePath: string,
): Promise<ParentSessionResult> {
  const home = process.env.HOME
  if (!home) return { type: "none" }

  const sessionsDir = `${home}/.claude/sessions`
  const projectsDir = `${home}/.claude/projects`

  // Extract just the worktree-specific suffix for grep matching.
  // e.g. "/Users/x/code/fell/.worktrees/session-column" -> ".worktrees/session-column"
  // This is more robust than grepping the full absolute path, which may appear
  // in different forms (with/without trailing slash, relative, etc.)
  const wtSuffix = worktreePath.match(/\.worktrees\/[^/]+$/)?.[0]
    ?? worktreePath.match(/\.claude\/worktrees\/[^/]+$/)?.[0]
  if (!wtSuffix) return { type: "none" }

  try {
    const { readdir } = await import("node:fs/promises")
    const sessionFiles = await readdir(sessionsDir).catch(() => null)
    if (!sessionFiles) return { type: "none" }

    // Step 1: Read all active session metadata
    const activeSessions: Array<{
      sessionId: string
      cwd: string
      jsonlPath: string
    }> = []

    for (const file of sessionFiles) {
      if (!file.endsWith(".json")) continue
      try {
        const raw = await Bun.file(`${sessionsDir}/${file}`).json()
        const sid = raw?.sessionId as string | undefined
        const cwd = raw?.cwd as string | undefined
        if (!sid || !cwd) continue

        const encoded = encodeClaudeProjectPath(cwd)
        const jsonlPath = `${projectsDir}/${encoded}/${sid}.jsonl`

        // Only include if the JSONL file exists
        if (await Bun.file(jsonlPath).exists()) {
          activeSessions.push({ sessionId: sid, cwd, jsonlPath })
        }
      } catch {
        /* skip unreadable session files */
      }
    }

    if (activeSessions.length === 0) return { type: "none" }

    // Step 2: grep each session's JSONL for the worktree path.
    // Run concurrently -- each grep -l short-circuits on first match.
    const grepResults = await Promise.all(
      activeSessions.map(async (session) => {
        const result = await $`grep -l ${wtSuffix} ${session.jsonlPath}`
          .nothrow()
          .quiet()
        return { session, matched: result.exitCode === 0 }
      }),
    )

    const match = grepResults.find((r) => r.matched)
    if (!match) return { type: "none" }

    // Step 3: Extract the first user prompt from the matched session for display
    const promptInfo = await extractFirstPrompt(match.session.jsonlPath)

    return {
      type: "found",
      session: {
        sessionId: match.session.sessionId,
        cwd: match.session.cwd,
        prompt: promptInfo?.prompt ?? "",
      },
    }
  } catch {
    return { type: "none" }
  }
}
