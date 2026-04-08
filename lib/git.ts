/**
 * Git and GitHub CLI operations for worktree management.
 * Uses Bun's native $ shell API for all subprocess calls.
 */

import { $ } from "bun"
import { readdir, stat } from "node:fs/promises"

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
 * Parse the porcelain output of `git worktree list --porcelain` into structured data.
 * The first entry is always the main worktree.
 */
export function parseWorktreeListOutput(stdout: string): Worktree[] {
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
 * List worktrees by running `git worktree list --porcelain` and parsing the output.
 * The first entry is always the main worktree.
 */
export async function listWorktrees(repoDir: string): Promise<Worktree[]> {
  const result = await $`git -C ${repoDir} worktree list --porcelain`.nothrow().quiet()
  if (result.exitCode !== 0) return []
  return parseWorktreeListOutput(result.stdout.toString())
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
  repoDir: string,
  path: string,
  force = false,
): Promise<{ ok: boolean; error?: string }> {
  const flags = force ? ["--force"] : []
  const result = await $`git -C ${repoDir} worktree remove ${flags} ${path}`.nothrow().quiet()

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
    await $`git -C ${repoDir} worktree prune`.nothrow().quiet()

    // Remove the leftover directory if it still exists
    await $`rm -rf ${path}`.nothrow().quiet()

    return { ok: true }
  }

  return { ok: false, error: stderr }
}

/** Parse the verbose output of `git worktree prune --dry-run -v` (from stderr). */
export function parsePruneOutput(stderr: string): string[] {
  const output = stderr.trim()
  if (!output) return []
  return output.split("\n").filter(Boolean)
}

/**
 * Dry-run prune to show what stale references would be cleaned.
 * Returns human-readable descriptions of each stale entry.
 * Note: git writes prune verbose output to stderr, not stdout.
 */
export async function pruneWorktreesDryRun(repoDir: string): Promise<string[]> {
  const result = await $`git -C ${repoDir} worktree prune --dry-run -v`.nothrow().quiet()
  return parsePruneOutput(result.stderr.toString())
}

/** Actually prune stale worktree references. */
export async function pruneWorktrees(repoDir: string): Promise<{
  ok: boolean
  error?: string
}> {
  const result = await $`git -C ${repoDir} worktree prune`.nothrow().quiet()
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
  repoDir: string,
  name: string,
  force = false,
): Promise<{ ok: boolean; error?: string }> {
  const flag = force ? "-D" : "-d"
  const result = await $`git -C ${repoDir} branch ${flag} ${name}`.nothrow().quiet()
  if (result.exitCode !== 0) {
    return { ok: false, error: result.stderr.toString().trim() }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// File status (per-worktree)
// ---------------------------------------------------------------------------

/** Parse `git status --porcelain=v2 --branch` output into a FileStatusResult. */
export function parseFileStatusOutput(stdout: string): FileStatusResult {
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
  return parseFileStatusOutput(result.stdout.toString())
}

// ---------------------------------------------------------------------------
// Directory size
// ---------------------------------------------------------------------------

export type DirSize =
  | { type: "loading" }
  | { type: "done"; bytes: number }
  | { type: "error" }

/** Parse `du -sk` output into a DirSize result. */
export function parseDuOutput(stdout: string): DirSize {
  const kb = parseInt(stdout.split("\t")[0], 10)
  if (isNaN(kb)) return { type: "error" }
  return { type: "done", bytes: kb * 1024 }
}

/** Get the total disk usage of a directory via `du -sk`. */
export async function fetchDirectorySize(
  dirPath: string,
): Promise<DirSize> {
  const result = await $`du -sk ${dirPath}`.quiet().nothrow()
  return parseDuOutput(result.stdout.toString().trim())
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

/** Parse `git status --porcelain=v2 --branch` output into individual file entries. */
export function parseFileListOutput(stdout: string): FileEntry[] {
  const entries: FileEntry[] = []

  for (const line of stdout.split("\n")) {
    if (line.startsWith("1 ")) {
      // Ordinary entry: "1 XY sub mH mI mW hH hI path"
      const xy = line.slice(2, 4)
      // Parse path from the fixed-width porcelain v2 format
      const parts = line.split(" ")
      const filePath = parts.slice(8).join(" ")
      if (xy[0] !== ".") entries.push({ path: filePath, status: "staged" })
      else if (xy[1] !== ".") entries.push({ path: filePath, status: "modified" })
    } else if (line.startsWith("2 ")) {
      // Rename entry: "2 XY sub mH mI mW hH hI Xscore\tpath\torigPath"
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
  return parseFileListOutput(result.stdout.toString())
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
export async function checkGhStatus(repoDir: string): Promise<GhDiagnostic> {
  // Fast path: check if the binary is on PATH at all
  if (!Bun.which("gh")) {
    return { type: "not-installed" as const }
  }

  // Check auth config file (~2ms) instead of spawning gh subprocess (~600ms).
  // If the hosts file exists, gh is almost certainly authenticated.
  // Edge case: expired/revoked tokens will cause PR fetches to fail gracefully
  // (returning null), which is acceptable — the user sees "no PR" not a crash.
  const home = process.env.HOME
  if (home) {
    const hostsFile = Bun.file(`${home}/.config/gh/hosts.yml`)
    if (await hostsFile.exists()) {
      return { type: "available" as const }
    }
  }

  return {
    type: "not-authenticated" as const,
    detail: "gh auth login required",
  }
}

// ---------------------------------------------------------------------------
// GitHub PR lookups
// ---------------------------------------------------------------------------

/** Parse `gh pr list --json ...` output into the most recent PrInfo, or null. */
export function parsePrListOutput(stdout: string): PrInfo | null {
  try {
    const prs = JSON.parse(stdout) as Array<{
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

/**
 * Fetch the most recent PR for a branch via `gh` CLI.
 * Returns null when no PR exists or gh is unavailable.
 */
export async function fetchPrForBranch(
  repoDir: string,
  branch: string,
): Promise<PrInfo | null> {
  const result =
    await $`gh pr list --head ${branch} --state all --json number,state,url,title --limit 5`
      .cwd(repoDir)
      .nothrow()
      .quiet()

  if (result.exitCode !== 0) return null
  return parsePrListOutput(result.stdout.toString())
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
export function encodeClaudeProjectPath(absolutePath: string): string {
  return absolutePath.replace(/[^a-zA-Z0-9]/g, "-")
}

/**
 * Read the first N lines from a file by loading only a small byte prefix.
 * JSONL lines are typically 200-2000 bytes each, so 16KB covers ~15+ lines.
 */
const JSONL_PREFIX_BYTES = 16384

async function readFirstLines(
  filePath: string,
  maxLines: number,
): Promise<string[]> {
  const text = await Bun.file(filePath).slice(0, JSONL_PREFIX_BYTES).text()
  return text.split("\n").slice(0, maxLines)
}

/**
 * Extract the first user prompt from a Claude Code session JSONL file.
 * Reads only the first 16KB (covers ~15 lines) rather than the full file.
 */
export async function extractFirstPrompt(
  jsonlPath: string,
): Promise<{ prompt: string; timestamp: string } | null> {
  try {
    const lines = await readFirstLines(jsonlPath, 15)

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
 * Reads only the first 16KB rather than the full file.
 */
export async function extractCwd(jsonlPath: string): Promise<string | null> {
  try {
    const lines = await readFirstLines(jsonlPath, 10)
    for (const line of lines) {
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
  if (!home) return { type: "none" as const }

  const encoded = encodeClaudeProjectPath(worktreePath)
  const projectDir = `${home}/.claude/projects/${encoded}`

  try {
    const entries = await readdir(projectDir).catch(() => null)
    if (!entries) return { type: "none" as const }

    // Find all .jsonl files (each is a session)
    const jsonlFiles = entries.filter((e) => e.endsWith(".jsonl"))
    if (jsonlFiles.length === 0) return { type: "none" as const }

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
      type: "found" as const,
      info: {
        sessionCount: jsonlFiles.length,
        latestSessionId,
        latestPrompt: promptInfo?.prompt ?? "",
        latestTimestamp: promptInfo?.timestamp ?? "",
      },
    }
  } catch {
    return { type: "none" as const }
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
  if (!home) return { type: "none" as const }

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

    if (activeSessions.length === 0) return { type: "none" as const }

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
    if (!match) return { type: "none" as const }

    // Step 3: Extract the first user prompt from the matched session for display
    const promptInfo = await extractFirstPrompt(match.session.jsonlPath)

    return {
      type: "found" as const,
      session: {
        sessionId: match.session.sessionId,
        cwd: match.session.cwd,
        prompt: promptInfo?.prompt ?? "",
      },
    }
  } catch {
    return { type: "none" as const }
  }
}
