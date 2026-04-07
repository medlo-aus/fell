#!/usr/bin/env bun

/**
 * fell - Interactive git worktree manager.
 *
 * Navigate worktrees with arrow keys, view async PR statuses,
 * delete worktrees + branches, and prune stale references.
 *
 * Usage:
 *   fell              # interactive (default)
 *   fell --list       # print and exit
 *   fell --help       # show help
 */

import { parseArgs } from "util"
import {
  listWorktrees,
  removeWorktree,
  pruneWorktreesDryRun,
  pruneWorktrees,
  deleteBranch,
  fetchPrForBranch,
  fetchWorktreeFileStatus,
  fetchWorktreeFileList,
  fetchDirectorySize,
  formatBytes,
  openDirectory,
  checkGhStatus,
  type Worktree,
  type PrStatus,
  type FileStatusResult,
  type FileEntry,
  type DirSize,
  type GhDiagnostic,
} from "./lib/git"
import {
  c,
  term,
  SPINNER_FRAMES,
  parseKey,
  keyChar,
  pad,
  truncate,
  shortenPath,
  formatPrStatus,
  formatFileStatus,
  fellLogo,
  renderHelpLines,
  printCliHelp,
  type Key,
} from "./lib/tui"

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface WorktreeItem {
  worktree: Worktree
  prStatus: PrStatus
  fileStatus: FileStatusResult
  dirSize: DirSize
}

/** Per-item progress entry for the deleting status line. */
interface DeleteProgress {
  label: string
  status: "pending" | "removing" | "branch" | "done" | "error" | "needs-force"
  message?: string
}

type Mode =
  | { type: "browse" }
  | { type: "confirm-delete"; indices: number[] }
  | { type: "confirm-force"; indices: number[]; withBranch: boolean }
  | { type: "confirm-prune"; candidates: string[] }
  | { type: "deleting"; progress: DeleteProgress[]; withBranch: boolean }
  | { type: "result"; lines: string[] }
  | { type: "help" }

interface State {
  items: WorktreeItem[]
  mainWorktree: Worktree
  cursor: number
  selected: Set<number>
  mode: Mode
  spinnerFrame: number
  message: { text: string; kind: "info" | "success" | "error" } | null
  shouldQuit: boolean
  ghDiagnostic: GhDiagnostic
  /** Index of the expanded item, or null if none expanded. */
  expandedIndex: number | null
  /** Cached file list for the expanded item. Null while loading. */
  expandedFiles: FileEntry[] | null
}

// ---------------------------------------------------------------------------
// Terminal I/O helpers
// ---------------------------------------------------------------------------

function setupTerminal(): void {
  term.enterAltScreen()
  term.hideCursor()
  term.clearScreen()
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }
  process.stdin.resume()
}

function cleanupTerminal(): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false)
  }
  process.stdin.pause()
  term.showCursor()
  term.exitAltScreen()
}

function waitForKey(): Promise<Buffer> {
  return new Promise((resolve) => {
    process.stdin.once("data", (data: Buffer) => resolve(data))
  })
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const BRANCH_COL = 30
const SHA_COL = 7

/**
 * Build lines for a single worktree entry.
 * Returns the main row + an optional indented sub-line for dirty file status.
 */
function renderRow(
  item: WorktreeItem,
  index: number,
  state: State,
): string[] {
  const isFocused = index === state.cursor
  const isSelected = state.selected.has(index)
  const wt = item.worktree

  const cursor = isFocused ? c.cyan("\u276F") : " "
  const check = isSelected ? c.lime("\u25CF") : c.dim("\u25CB")

  const branchRaw = wt.branch ?? "(detached)"
  let branchStr = truncate(branchRaw, BRANCH_COL)
  branchStr = isFocused ? c.bold(branchStr) : branchStr

  const sha = c.dim(wt.head.slice(0, SHA_COL))

  // Indicators: locked, prunable
  const tags: string[] = []
  if (wt.isLocked) tags.push(c.yellow("locked"))
  if (wt.isPrunable) tags.push(c.red("prunable"))
  const tagStr = tags.length > 0 ? ` ${tags.join(" ")}` : ""

  const pr = formatPrStatus(item.prStatus, state.spinnerFrame)

  // Pad branch column for alignment
  const branchPadded = pad(branchStr, BRANCH_COL + 2)

  // Directory size column
  let sizeStr: string
  switch (item.dirSize.type) {
    case "loading": {
      const frame = SPINNER_FRAMES[state.spinnerFrame % SPINNER_FRAMES.length]
      sizeStr = c.dim(`${frame} estimating`)
      break
    }
    case "done":
      sizeStr = c.dim(formatBytes(item.dirSize.bytes))
      break
    case "error":
      sizeStr = ""
      break
  }

  const mainLine = `  ${cursor} ${check} ${branchPadded}${sha}   ${pad(pr, 18)}${sizeStr}${tagStr}`
  const lines = [mainLine]

  // Sub-line: dirty file status with warning icon, indented under the branch name
  const fileStatusLine = formatFileStatus(item.fileStatus)
  if (fileStatusLine) {
    //       cursor+check+space = "  X X " = 6 chars, then indent to align under branch
    lines.push(`        ${fileStatusLine}`)
  }

  // Expanded file list (progressive disclosure via "e" key)
  const MAX_EXPANDED_FILES = 12
  if (state.expandedIndex === index) {
    if (state.expandedFiles === null) {
      const frame = SPINNER_FRAMES[state.spinnerFrame % SPINNER_FRAMES.length]
      lines.push(`        ${c.dim(`${frame} loading files...`)}`)
    } else if (state.expandedFiles.length === 0) {
      lines.push(`        ${c.dim("no changed files")}`)
    } else {
      const shown = state.expandedFiles.slice(0, MAX_EXPANDED_FILES)
      for (const file of shown) {
        const statusColor =
          file.status === "staged" ? c.green
          : file.status === "modified" ? c.yellow
          : file.status === "unmerged" ? c.red
          : c.dim
        const tag = statusColor(file.status.slice(0, 1).toUpperCase())
        lines.push(`        ${tag} ${c.dim(file.path)}`)
      }
      const remaining = state.expandedFiles.length - MAX_EXPANDED_FILES
      if (remaining > 0) {
        lines.push(`        ${c.dim(`... ${remaining} more`)}`)
      }
    }
  }

  return lines
}

/** Full-screen render: build lines, write once. */
function render(state: State): void {
  const cols = process.stdout.columns ?? 100
  const lines: string[] = []

  // Title bar
  lines.push("")
  const suffix =
    state.selected.size > 0
      ? `  ${c.lime(`${state.selected.size} selected`)}`
      : ""
  lines.push(`  ${c.bold(fellLogo())}  ${c.dim("Interactive Worktree Cleanup")}${suffix}`)
  lines.push("")

  // Main worktree (always visible, non-interactive)
  const mainSha = state.mainWorktree.head.slice(0, SHA_COL)
  const mainPath = shortenPath(state.mainWorktree.path, cols - 25)
  lines.push(
    `  ${c.dim("  main")}  ${c.dim(mainSha)}  ${c.dim(mainPath)}`,
  )
  lines.push("")

  if (state.mode.type === "help") {
    lines.push(...renderHelpLines())
  } else {
    // Worktree list (each item may produce 1-2 lines)
    for (let i = 0; i < state.items.length; i++) {
      lines.push(...renderRow(state.items[i], i, state))
    }

    // Focused item detail: full path + PR title
    lines.push("")
    const focused = state.items[state.cursor]
    if (focused) {
      const fullPath = shortenPath(focused.worktree.path, cols - 4)
      lines.push(`  ${c.dim(fullPath)}`)

      if (focused.prStatus.type === "found") {
        const title = truncate(focused.prStatus.pr.title, cols - 6)
        lines.push(`  ${c.dim(c.italic(title))}`)
      }
    }

    // Status message (persists until next action)
    if (state.message) {
      lines.push("")
      const prefix =
        state.message.kind === "error"
          ? c.red("error")
          : state.message.kind === "success"
            ? c.green("done")
            : c.cyan("info")
      lines.push(`  ${prefix}  ${state.message.text}`)
    }

    // Inline gh CLI warning (progressive disclosure above key hints)
    if (
      state.mode.type === "browse" &&
      state.ghDiagnostic.type !== "available" &&
      state.ghDiagnostic.type !== "checking"
    ) {
      lines.push("")
      if (state.ghDiagnostic.type === "not-installed") {
        lines.push(
          `  ${c.yellow("\u26A0")} ${c.dim('install')} ${c.yellow("gh")} ${c.dim("to see PR statuses (created, merged, open) for each worktree")}`,
        )
        lines.push(
          `    ${c.dim("brew install gh")}  ${c.dim("or")}  ${c.dim("https://cli.github.com")}`,
        )
      } else if (state.ghDiagnostic.type === "not-authenticated") {
        lines.push(
          `  ${c.yellow("\u26A0")} ${c.dim('run')} ${c.yellow("gh auth login")} ${c.dim("to see PR statuses for each worktree")}`,
        )
        lines.push(
          `    ${c.dim(state.ghDiagnostic.detail)}`,
        )
      }
    }

    // Bottom bar: mode-specific key hints
    lines.push("")
    switch (state.mode.type) {
      case "browse": {
        lines.push(
          `  ${c.dim("\u2191\u2193")} navigate  ${c.dim("\u2423")} select  ${c.dim("a")} all  ${c.dim("e")} expand  ${c.dim("o")} open  ${c.dim("d")} delete  ${c.dim("p")} prune  ${c.dim("?")} help  ${c.dim("q")} quit`,
        )
        break
      }
      case "confirm-delete": {
        const n = state.mode.indices.length
        const s = n > 1 ? "s" : ""
        lines.push(
          `  Delete ${c.bold(String(n))} worktree${s}?  ${c.cyan("y")} confirm  ${c.cyan("b")} + delete branch${s}  ${c.cyan("n")} cancel`,
        )
        break
      }
      case "confirm-force": {
        const n = state.mode.indices.length
        const s = n > 1 ? "s" : ""
        lines.push(
          `  Worktree${s} ha${n > 1 ? "ve" : "s"} uncommitted changes. Force delete?  ${c.cyan("y")} force  ${c.cyan("n")} cancel`,
        )
        break
      }
      case "confirm-prune": {
        for (const candidate of state.mode.candidates) {
          lines.push(`    ${c.dim("\u2022")} ${candidate}`)
        }
        lines.push("")
        lines.push(
          `  Prune ${c.bold(String(state.mode.candidates.length))} stale reference(s)?  ${c.cyan("y")} confirm  ${c.cyan("n")} cancel`,
        )
        break
      }
      case "deleting": {
        const { progress } = state.mode
        const done = progress.filter((p) => p.status === "done").length
        const total = progress.length
        const frame = SPINNER_FRAMES[state.spinnerFrame % SPINNER_FRAMES.length]

        for (const entry of progress) {
          let icon: string
          let detail = ""
          switch (entry.status) {
            case "pending":
              icon = c.dim("\u25CB")
              break
            case "removing":
              icon = c.cyan(frame)
              detail = c.dim(" removing worktree")
              break
            case "branch":
              icon = c.cyan(frame)
              detail = c.dim(" deleting branch")
              break
            case "done":
              icon = c.green("\u2713")
              detail = entry.message ? `  ${c.dim(entry.message)}` : ""
              break
            case "error":
              icon = c.red("\u2717")
              detail = entry.message ? `  ${c.dim(entry.message)}` : ""
              break
            case "needs-force":
              icon = c.yellow("!")
              detail = c.dim(" has uncommitted changes")
              break
          }
          lines.push(`    ${icon} ${entry.label}${detail}`)
        }

        lines.push("")
        lines.push(
          `  ${c.cyan(frame)} Deleting ${done}/${total}...`,
        )
        break
      }
      case "result": {
        for (const line of state.mode.lines) {
          lines.push(`  ${line}`)
        }
        lines.push("")
        lines.push(`  ${c.dim("press any key to continue")}`)
        break
      }
    }
  }

  lines.push("")

  // Write entire frame at once to prevent flicker.
  // Each line gets an EL (Erase in Line) suffix so that when a line shrinks
  // between frames the leftover characters from the previous render are wiped.
  term.home()
  process.stdout.write(lines.map((l) => l + term.EL).join("\n"))
  term.clearBelow()
}

// ---------------------------------------------------------------------------
// Actions (async side-effects)
// ---------------------------------------------------------------------------

/**
 * Run delete operations in the background with per-item progress.
 * Enters "deleting" mode, processes items sequentially (updating state
 * and re-rendering after each step), then transitions to "result" mode.
 * The event loop stays responsive for spinner animation during this time.
 */
function startDelete(
  state: State,
  indices: number[],
  withBranch: boolean,
  force: boolean,
  rerender: () => void,
): void {
  // Build progress entries
  const progress: DeleteProgress[] = indices.map((idx) => {
    const item = state.items[idx]
    return {
      label: item?.worktree.branch ?? item?.worktree.path ?? `index ${idx}`,
      status: "pending" as const,
    }
  })

  state.mode = { type: "deleting", progress, withBranch }
  state.message = null
  rerender()

  // Run the actual deletes in a fire-and-forget async block.
  // Each step updates progress + re-renders, keeping the TUI alive.
  ;(async () => {
    const resultLines: string[] = []
    let needsForce = false

    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i]
      const item = state.items[idx]
      if (!item) continue
      const wt = item.worktree
      const entry = progress[i]

      // Step 1: remove worktree
      entry.status = "removing"
      rerender()

      const removeResult = await removeWorktree(wt.path, force)

      if (removeResult.ok) {
        // Step 2 (optional): delete branch
        if (withBranch && wt.branch) {
          entry.status = "branch"
          rerender()

          const branchResult = await deleteBranch(wt.branch, true)
          if (branchResult.ok) {
            entry.status = "done"
            entry.message = "worktree + branch removed"
            resultLines.push(`${c.green("\u2713")} Removed ${entry.label} + branch`)
          } else {
            entry.status = "done"
            entry.message = `branch: ${branchResult.error}`
            resultLines.push(`${c.green("\u2713")} Removed ${entry.label}`)
            resultLines.push(`${c.red("\u2717")} Branch ${wt.branch}: ${branchResult.error}`)
          }
        } else {
          entry.status = "done"
          entry.message = "removed"
          resultLines.push(`${c.green("\u2713")} Removed ${entry.label}`)
        }
      } else {
        const isUncommitted =
          removeResult.error?.includes("uncommitted") ||
          removeResult.error?.includes("modified") ||
          removeResult.error?.includes("untracked") ||
          removeResult.error?.includes("changes")

        if (isUncommitted && !force) {
          needsForce = true
          entry.status = "needs-force"
          resultLines.push(`${c.yellow("!")} ${entry.label}: has uncommitted changes`)
        } else {
          entry.status = "error"
          entry.message = removeResult.error
          resultLines.push(`${c.red("\u2717")} ${entry.label}: ${removeResult.error}`)
        }
      }

      rerender()
    }

    // All items processed. Refresh the worktree list.
    await refreshWorktrees(state)
    startPrFetching(state, rerender)
    startFileStatusFetching(state, rerender)
    startSizeFetching(state, rerender)

    if (needsForce) {
      state.mode = {
        type: "result",
        lines: [
          ...resultLines,
          "",
          `${c.yellow("Some worktrees have uncommitted changes.")}`,
          `${c.dim("Select them again and press")} ${c.cyan("d")} ${c.dim("to retry with force.")}`,
        ],
      }
    } else {
      state.mode = { type: "result", lines: resultLines }
    }

    state.message = null
    rerender()
  })()
}

/** Refresh the worktree list and reset selection state. */
async function refreshWorktrees(state: State): Promise<void> {
  const allWorktrees = await listWorktrees()
  const main = allWorktrees.find((w) => w.isMain)
  if (main) state.mainWorktree = main

  state.items = allWorktrees
    .filter((w) => !w.isMain)
    .map((w) => ({
      worktree: w,
      prStatus: { type: "loading" as const },
      fileStatus: { type: "loading" as const },
      dirSize: { type: "loading" as const },
    }))

  state.selected.clear()
  state.expandedIndex = null
  state.expandedFiles = null
  state.cursor = Math.min(state.cursor, Math.max(0, state.items.length - 1))
}

// ---------------------------------------------------------------------------
// Async PR fetching (background, concurrent)
// ---------------------------------------------------------------------------

const PR_CONCURRENCY = 4

/**
 * Fetch PR statuses for all non-main worktrees in background.
 * Skips entirely if gh CLI is unavailable.
 * Updates state items in-place and triggers re-renders.
 */
function startPrFetching(state: State, rerender: () => void): void {
  // Skip if gh is known to be unavailable
  if (
    state.ghDiagnostic.type === "not-installed" ||
    state.ghDiagnostic.type === "not-authenticated"
  ) {
    for (const item of state.items) {
      item.prStatus = { type: "skipped" }
    }
    rerender()
    return
  }

  const branches = state.items
    .map((item, index) => ({
      branch: item.worktree.branch,
      index,
    }))
    .filter(
      (b): b is { branch: string; index: number } => b.branch !== null,
    )

  // Mark items without a branch as skipped
  for (let i = 0; i < state.items.length; i++) {
    if (!state.items[i].worktree.branch) {
      state.items[i].prStatus = { type: "skipped" }
    }
  }

  // Concurrent fetch with limited parallelism
  const executing: Promise<void>[] = []

  const fetchOne = async ({ branch, index }: { branch: string; index: number }) => {
    try {
      const pr = await fetchPrForBranch(branch)
      // Guard against stale index (list may have been refreshed)
      if (state.items[index]?.worktree.branch === branch) {
        state.items[index].prStatus = pr
          ? { type: "found", pr }
          : { type: "none" }
      }
    } catch {
      if (state.items[index]?.worktree.branch === branch) {
        state.items[index].prStatus = {
          type: "error",
          message: "fetch failed",
        }
      }
    }
    rerender()
  }

  ;(async () => {
    for (const item of branches) {
      const task = fetchOne(item)
      executing.push(task)
      // Remove from pool on completion
      task.then(() => {
        const idx = executing.indexOf(task)
        if (idx !== -1) executing.splice(idx, 1)
      })

      if (executing.length >= PR_CONCURRENCY) {
        await Promise.race(executing)
      }
    }
    await Promise.all(executing)
  })()
}

// ---------------------------------------------------------------------------
// Async file status fetching (background, concurrent)
// ---------------------------------------------------------------------------

const FILE_STATUS_CONCURRENCY = 6

/**
 * Fetch file statuses for all non-main worktrees in background.
 * Runs concurrently since each call is a local git command (fast).
 */
function startFileStatusFetching(state: State, rerender: () => void): void {
  const entries = state.items.map((item, index) => ({
    path: item.worktree.path,
    index,
  }))

  const executing: Promise<void>[] = []

  const fetchOne = async ({ path, index }: { path: string; index: number }) => {
    try {
      const result = await fetchWorktreeFileStatus(path)
      // Guard against stale index (list may have been refreshed)
      if (state.items[index]?.worktree.path === path) {
        state.items[index].fileStatus = result
      }
    } catch {
      if (state.items[index]?.worktree.path === path) {
        state.items[index].fileStatus = { type: "error" }
      }
    }
    rerender()
  }

  ;(async () => {
    for (const entry of entries) {
      const task = fetchOne(entry)
      executing.push(task)
      task.then(() => {
        const idx = executing.indexOf(task)
        if (idx !== -1) executing.splice(idx, 1)
      })

      if (executing.length >= FILE_STATUS_CONCURRENCY) {
        await Promise.race(executing)
      }
    }
    await Promise.all(executing)
  })()
}

// ---------------------------------------------------------------------------
// Async directory size fetching (background, sequential)
// ---------------------------------------------------------------------------

/**
 * Fetch directory sizes for all non-main worktrees in background.
 * Runs sequentially (du is I/O heavy, parallel would thrash disk).
 */
function startSizeFetching(state: State, rerender: () => void): void {
  ;(async () => {
    for (let i = 0; i < state.items.length; i++) {
      const item = state.items[i]
      const path = item.worktree.path
      try {
        const result = await fetchDirectorySize(path)
        // Guard against stale index
        if (state.items[i]?.worktree.path === path) {
          state.items[i].dirSize = result
        }
      } catch {
        if (state.items[i]?.worktree.path === path) {
          state.items[i].dirSize = { type: "error" }
        }
      }
      rerender()
    }
  })()
}

// ---------------------------------------------------------------------------
// Key handling
// ---------------------------------------------------------------------------

/** Process a keypress in browse mode. Returns true if the event was handled. */
async function handleBrowseKey(state: State, key: Key): Promise<void> {
  const ch = keyChar(key)

  // Navigation (collapse expand on cursor move)
  if (key === "up" || ch === "k") {
    state.cursor = Math.max(0, state.cursor - 1)
    state.expandedIndex = null
    state.expandedFiles = null
    state.message = null
    return
  }
  if (key === "down" || ch === "j") {
    state.cursor = Math.min(state.items.length - 1, state.cursor + 1)
    state.expandedIndex = null
    state.expandedFiles = null
    state.message = null
    return
  }

  // Selection
  if (key === "space") {
    if (state.selected.has(state.cursor)) {
      state.selected.delete(state.cursor)
    } else {
      state.selected.add(state.cursor)
    }
    // Auto-advance cursor after toggle
    if (state.cursor < state.items.length - 1) {
      state.cursor++
    }
    return
  }

  // Select / deselect all
  if (ch === "a") {
    if (state.selected.size === state.items.length) {
      state.selected.clear()
    } else {
      for (let i = 0; i < state.items.length; i++) {
        state.selected.add(i)
      }
    }
    return
  }

  // Delete
  if (ch === "d") {
    const indices =
      state.selected.size > 0
        ? Array.from(state.selected).sort((a, b) => a - b)
        : [state.cursor]

    // Guard against deleting locked worktrees without warning
    const lockedItems = indices.filter((i) => state.items[i]?.worktree.isLocked)
    if (lockedItems.length > 0) {
      const names = lockedItems
        .map((i) => state.items[i].worktree.branch ?? state.items[i].worktree.path)
        .join(", ")
      state.message = {
        text: `Cannot delete locked worktree(s): ${names}. Unlock first.`,
        kind: "error",
      }
      return
    }

    state.mode = { type: "confirm-delete", indices }
    state.message = null
    return
  }

  // Prune
  if (ch === "p") {
    state.message = { text: "Checking for stale references...", kind: "info" }
    render(state)

    const candidates = await pruneWorktreesDryRun()
    if (candidates.length === 0) {
      state.message = {
        text: "No stale worktree references found.",
        kind: "info",
      }
    } else {
      state.mode = { type: "confirm-prune", candidates }
      state.message = null
    }
    return
  }

  // Refresh
  if (ch === "r") {
    state.message = { text: "Refreshing...", kind: "info" }
    render(state)
    await refreshWorktrees(state)
    startPrFetching(state, () => render(state))
    startFileStatusFetching(state, () => render(state))
    startSizeFetching(state, () => render(state))
    state.message = { text: "Refreshed.", kind: "success" }
    return
  }

  // Expand: toggle file list for the focused worktree
  if (ch === "e") {
    if (state.expandedIndex === state.cursor) {
      // Collapse
      state.expandedIndex = null
      state.expandedFiles = null
    } else {
      // Expand: set loading, fetch in background
      state.expandedIndex = state.cursor
      state.expandedFiles = null
      const worktreePath = state.items[state.cursor].worktree.path
      const cursorAtExpand = state.cursor
      fetchWorktreeFileList(worktreePath).then((files) => {
        // Only apply if the expanded item hasn't changed
        if (state.expandedIndex === cursorAtExpand) {
          state.expandedFiles = files
          render(state)
        }
      })
    }
    return
  }

  // Open: open focused worktree directory in system file manager
  if (ch === "o") {
    const focused = state.items[state.cursor]
    if (focused) {
      openDirectory(focused.worktree.path)
      state.message = { text: `Opened ${shortenPath(focused.worktree.path, 50)}`, kind: "info" }
    }
    return
  }

  // Help
  if (ch === "?") {
    state.mode = { type: "help" }
    return
  }

  // Quit
  if (key === "ctrl-c" || ch === "q") {
    state.shouldQuit = true
    return
  }
}

/** Process a keypress in confirm-delete mode. */
async function handleConfirmDeleteKey(
  state: State,
  key: Key,
  indices: number[],
): Promise<void> {
  const ch = keyChar(key)

  // Yes: delete worktrees only
  // b: delete worktrees + branches
  if (ch === "y" || ch === "b") {
    const withBranch = ch === "b"
    // Fire-and-forget: enters "deleting" mode, processes in background
    startDelete(state, indices, withBranch, false, () => render(state))
    return
  }

  // Cancel
  if (ch === "n" || key === "escape") {
    state.mode = { type: "browse" }
    state.message = null
    return
  }
}

/** Process a keypress in confirm-force mode. */
async function handleConfirmForceKey(
  state: State,
  key: Key,
  indices: number[],
  withBranch: boolean,
): Promise<void> {
  const ch = keyChar(key)

  if (ch === "y") {
    startDelete(state, indices, withBranch, true, () => render(state))
    return
  }

  if (ch === "n" || key === "escape") {
    state.mode = { type: "browse" }
    state.message = null
    return
  }
}

/** Process a keypress in confirm-prune mode. */
async function handleConfirmPruneKey(state: State, key: Key): Promise<void> {
  const ch = keyChar(key)

  if (ch === "y") {
    const result = await pruneWorktrees()
    if (result.ok) {
      await refreshWorktrees(state)
      startPrFetching(state, () => render(state))
      startFileStatusFetching(state, () => render(state))
      startSizeFetching(state, () => render(state))
      state.mode = {
        type: "result",
        lines: [`${c.green("\u2713")} Stale references pruned.`],
      }
    } else {
      state.mode = {
        type: "result",
        lines: [`${c.red("\u2717")} Prune failed: ${result.error}`],
      }
    }
    return
  }

  if (ch === "n" || key === "escape") {
    state.mode = { type: "browse" }
    state.message = null
    return
  }
}

// ---------------------------------------------------------------------------
// Non-interactive --list mode
// ---------------------------------------------------------------------------

async function printListAndExit(): Promise<void> {
  const worktrees = await listWorktrees()
  const ghDiagnostic = await checkGhStatus()

  console.log()
  console.log(`  ${c.bold(fellLogo())}  ${c.dim("--list")}`)
  console.log()

  // Fetch file statuses for all worktrees concurrently
  const fileStatuses = await Promise.all(
    worktrees.map(async (wt) => {
      if (wt.isBare) return { type: "clean" as const }
      return fetchWorktreeFileStatus(wt.path)
    }),
  )

  for (let i = 0; i < worktrees.length; i++) {
    const wt = worktrees[i]
    const branch = wt.branch ?? "(detached)"
    const sha = wt.head.slice(0, 7)
    const tags: string[] = []
    if (wt.isMain) tags.push(c.cyan("main"))
    if (wt.isLocked) tags.push(c.yellow("locked"))
    if (wt.isPrunable) tags.push(c.red("prunable"))
    const tagStr = tags.length > 0 ? `  ${tags.join(" ")}` : ""

    const home = process.env.HOME ?? ""
    let path = wt.path
    if (home && path.startsWith(home)) path = "~" + path.slice(home.length)

    console.log(
      `  ${branch.padEnd(35)} ${c.dim(sha)}  ${c.dim(path)}${tagStr}`,
    )

    // Sub-line for dirty file status
    const fsLine = formatFileStatus(fileStatuses[i])
    if (fsLine) {
      console.log(`     ${fsLine}`)
    }
  }

  // Fetch PR statuses if gh is available
  if (ghDiagnostic.type === "available") {
    console.log()
    console.log(c.dim("  Fetching PR statuses..."))

    const nonMain = worktrees.filter((w) => !w.isMain && w.branch)
    const results = await Promise.all(
      nonMain.map(async (wt) => {
        const pr = await fetchPrForBranch(wt.branch!)
        return { branch: wt.branch!, pr }
      }),
    )

    // Overwrite the "Fetching" line
    process.stdout.write("\x1b[1A\x1b[2K")

    for (const { branch, pr } of results) {
      if (pr) {
        const stateColor =
          pr.state === "MERGED"
            ? c.green
            : pr.state === "OPEN"
              ? c.yellow
              : c.red
        console.log(
          `  ${branch.padEnd(35)} ${stateColor(`#${pr.number} ${pr.state.toLowerCase()}`)}  ${c.dim(pr.url)}`,
        )
      }
    }
  } else if (ghDiagnostic.type === "not-installed") {
    console.log()
    console.log(
      `  ${c.yellow("\u26A0")} ${c.dim('install')} ${c.yellow("gh")} ${c.dim("to see PR statuses (created, merged, open) for each worktree")}`,
    )
    console.log(
      `    ${c.dim("brew install gh")}  ${c.dim("or")}  ${c.dim("https://cli.github.com")}`,
    )
  } else if (ghDiagnostic.type === "not-authenticated") {
    console.log()
    console.log(
      `  ${c.yellow("\u26A0")} ${c.dim('run')} ${c.yellow("gh auth login")} ${c.dim("to see PR statuses for each worktree")}`,
    )
    console.log(`    ${c.dim(ghDiagnostic.detail)}`)
  }

  console.log()
}

// ---------------------------------------------------------------------------
// Spinner timer (animates loading indicators)
// ---------------------------------------------------------------------------

function startSpinnerTimer(
  state: State,
  rerender: () => void,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    // Animate when there are loading statuses or an active delete in progress
    const hasLoading = state.items.some(
      (i) => i.prStatus.type === "loading" || i.dirSize.type === "loading",
    )
    const isDeleting = state.mode.type === "deleting"
    if (hasLoading || isDeleting) {
      state.spinnerFrame =
        (state.spinnerFrame + 1) % SPINNER_FRAMES.length
      rerender()
    }
  }, 80)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean", short: "h", default: false },
      list: { type: "boolean", short: "l", default: false },
    },
    allowPositionals: true,
  })

  if (values.help) {
    printCliHelp()
    process.exit(0)
  }

  if (values.list) {
    await printListAndExit()
    process.exit(0)
  }

  // Check prerequisites
  if (!process.stdin.isTTY) {
    console.error("fell requires an interactive terminal.")
    process.exit(1)
  }

  const allWorktrees = await listWorktrees()
  const mainWorktree = allWorktrees.find((w) => w.isMain)
  if (!mainWorktree) {
    console.error("Could not determine main worktree. Are you in a git repo?")
    process.exit(1)
  }

  const nonMain = allWorktrees.filter((w) => !w.isMain)
  if (nonMain.length === 0) {
    console.log(c.dim("  No worktrees to manage (only main). Nothing to do."))
    process.exit(0)
  }

  // Initialise state
  const state: State = {
    items: nonMain.map((w) => ({
      worktree: w,
      prStatus: { type: "loading" },
      fileStatus: { type: "loading" },
      dirSize: { type: "loading" },
    })),
    mainWorktree,
    cursor: 0,
    selected: new Set(),
    mode: { type: "browse" },
    spinnerFrame: 0,
    message: null,
    shouldQuit: false,
    ghDiagnostic: { type: "checking" },
    expandedIndex: null,
    expandedFiles: null,
  }

  // Check gh availability (non-blocking, runs before PR fetching starts)
  checkGhStatus().then((diagnostic) => {
    state.ghDiagnostic = diagnostic
    if (diagnostic.type !== "available") {
      // gh unavailable - mark all PR statuses so spinners stop
      for (const item of state.items) {
        if (item.prStatus.type === "loading") {
          item.prStatus = { type: "skipped" }
        }
      }
      render(state)
    }
  })

  // Setup terminal
  setupTerminal()

  // Ensure cleanup on unexpected exit
  const cleanup = () => {
    cleanupTerminal()
  }
  process.on("SIGINT", () => {
    cleanup()
    process.exit(0)
  })
  process.on("SIGTERM", () => {
    cleanup()
    process.exit(0)
  })
  // Re-render on terminal resize
  process.on("SIGWINCH", () => render(state))

  try {
    // Initial render
    render(state)

    // Start background PR fetching, file status checks, and size estimation
    startPrFetching(state, () => render(state))
    startFileStatusFetching(state, () => render(state))
    startSizeFetching(state, () => render(state))

    // Start spinner animation timer
    const spinnerTimer = startSpinnerTimer(state, () => render(state))

    // Event loop
    while (!state.shouldQuit) {
      const data = await waitForKey()
      const key = parseKey(data)

      switch (state.mode.type) {
        case "browse":
          await handleBrowseKey(state, key)
          break

        case "confirm-delete":
          await handleConfirmDeleteKey(state, key, state.mode.indices)
          break

        case "confirm-force":
          await handleConfirmForceKey(
            state,
            key,
            state.mode.indices,
            state.mode.withBranch,
          )
          break

        case "confirm-prune":
          await handleConfirmPruneKey(state, key)
          break

        case "deleting":
          // Background delete in progress - ignore keys (spinner keeps animating via timer)
          if (key === "ctrl-c") {
            state.shouldQuit = true
          }
          break

        case "result":
          // Any key returns to browse
          state.mode = { type: "browse" }
          state.message = null
          break

        case "help":
          if (key === "escape" || keyChar(key) === "?" || keyChar(key) === "q") {
            state.mode = { type: "browse" }
          }
          // Quit from help screen
          if (key === "ctrl-c") {
            state.shouldQuit = true
          }
          break
      }

      if (!state.shouldQuit) {
        render(state)
      }
    }

    clearInterval(spinnerTimer)
  } finally {
    cleanup()
  }
}

main().catch((err) => {
  // Ensure terminal is restored even on crash
  try {
    cleanupTerminal()
  } catch {
    /* ignore */
  }
  console.error(c.red("Fatal:"), err instanceof Error ? err.message : err)
  process.exit(1)
})
