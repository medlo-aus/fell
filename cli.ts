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
import { dirname } from "node:path"
import {
  listWorktrees,
  removeWorktree,
  pruneWorktreesDryRun,
  pruneWorktrees,
  deleteBranch,
  detachHead,
  fetchOrigin,
  checkoutNewBranch,
  hashLockfile,
  renameWorktree,
  findNextDetachedSlot,
  fetchPrForBranch,
  fetchWorktreeFileStatus,
  fetchWorktreeFileList,
  fetchDirectorySize,
  formatBytes,
  openDirectory,
  openInCursor,
  checkGhStatus,
  fetchWorktreeSessionInfo,
  findParentSession,
  type Worktree,
  type PrStatus,
  type FileStatusResult,
  type FileEntry,
  type DirSize,
  type GhDiagnostic,
  type SessionResult,
  type ParentSessionResult,
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
  formatSessionInfo,
  formatParentSessionInline,
  formatParentSessionExpanded,
  fellLogo,
  getTheme,
  setTheme,
  helpContentLines,
  compositeOverlay,
  renderHelpLines,
  printCliHelp,
  type Key,
} from "./lib/tui"

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** In-flight deletion status for an item. Null when not being deleted. */
type ItemDeleteStatus =
  | { phase: "removing" }
  | { phase: "branch" }
  | { phase: "done"; message: string }
  | { phase: "error"; message: string }
  | { phase: "needs-force" }

/** In-flight release status for an item. Null when not being released. */
type ItemReleaseStatus =
  | { phase: "detaching" }
  | { phase: "branch" }
  | { phase: "done"; message: string }
  | { phase: "error"; message: string }
  | { phase: "dirty" }

interface WorktreeItem {
  worktree: Worktree
  prStatus: PrStatus
  fileStatus: FileStatusResult
  dirSize: DirSize
  sessionInfo: SessionResult
  parentSession: ParentSessionResult
  /** Set during deletion. Null when the item is not being deleted. */
  deleteStatus: ItemDeleteStatus | null
  /** Set during release. Null when the item is not being released. */
  releaseStatus: ItemReleaseStatus | null
}

type Mode =
  | { type: "browse" }
  | { type: "open-target" }
  | { type: "confirm-delete"; indices: number[] }
  | { type: "confirm-force"; indices: number[]; withBranch: boolean }
  | { type: "confirm-release"; indices: number[] }
  | { type: "confirm-prune"; candidates: string[] }
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
// Recyclable status
// ---------------------------------------------------------------------------

/**
 * Determine whether a worktree is a good candidate for recycling.
 * Returns a reason string for display, or null if not recyclable.
 */
function getRecyclableStatus(
  item: WorktreeItem,
): "released" | "merged" | null {
  // Must be clean (no dirty files, no unpushed commits)
  if (item.fileStatus.type === "dirty") {
    const s = item.fileStatus.status
    if (s.staged > 0 || s.modified > 0 || s.untracked > 0 || s.ahead > 0) {
      return null
    }
  }
  if (item.fileStatus.type !== "clean" && item.fileStatus.type !== "dirty") {
    return null // loading or error = unknown
  }

  // Tier 1: explicitly released (detached + clean)
  if (item.worktree.isDetached) return "released"

  // Tier 2: PR merged + clean
  if (
    item.prStatus.type === "found" &&
    item.prStatus.pr.state === "MERGED"
  ) {
    return "merged"
  }

  return null
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const BRANCH_COL = 30
const PR_COL = 18
const SIZE_COL = 10
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
  const wt = item.worktree

  // Items being deleted render as a dimmed single line with progress icon
  if (item.deleteStatus) {
    const branchRaw = wt.branch ?? "(detached)"
    const branchStr = c.dim(truncate(branchRaw, BRANCH_COL))
    const frame = SPINNER_FRAMES[state.spinnerFrame % SPINNER_FRAMES.length]

    let icon: string
    let detail = ""
    switch (item.deleteStatus.phase) {
      case "removing":
        icon = c.cyan(frame)
        detail = c.dim(" removing")
        break
      case "branch":
        icon = c.cyan(frame)
        detail = c.dim(" deleting branch")
        break
      case "done":
        icon = c.green("\u2713")
        detail = `  ${c.dim(item.deleteStatus.message)}`
        break
      case "error":
        icon = c.red("\u2717")
        detail = `  ${c.dim(item.deleteStatus.message)}`
        break
      case "needs-force":
        icon = c.yellow("!")
        detail = c.dim(" has uncommitted changes")
        break
    }
    return [`    ${icon} ${branchStr}${detail}`]
  }

  // Items being released render as a dimmed single line with progress icon
  if (item.releaseStatus) {
    const branchRaw = wt.branch ?? "(detached)"
    const branchStr = c.dim(truncate(branchRaw, BRANCH_COL))
    const frame = SPINNER_FRAMES[state.spinnerFrame % SPINNER_FRAMES.length]

    let icon: string
    let detail = ""
    switch (item.releaseStatus.phase) {
      case "detaching":
        icon = c.cyan(frame)
        detail = c.dim(" detaching")
        break
      case "branch":
        icon = c.cyan(frame)
        detail = c.dim(" deleting branch")
        break
      case "done":
        icon = c.green("\u2713")
        detail = `  ${c.dim(item.releaseStatus.message)}`
        break
      case "error":
        icon = c.red("\u2717")
        detail = `  ${c.dim(item.releaseStatus.message)}`
        break
      case "dirty":
        icon = c.yellow("!")
        detail = c.dim(" has uncommitted changes")
        break
    }
    return [`    ${icon} ${branchStr}${detail}`]
  }

  const isFocused = index === state.cursor
  const isSelected = state.selected.has(index)

  const cursor = isFocused ? c.cyan("\u276F") : " "
  const recyclable = getRecyclableStatus(item)
  let check: string
  if (isSelected) {
    check = c.lime("\u25CF")
  } else if (recyclable === "released") {
    check = c.green("\u267B")
  } else if (recyclable === "merged") {
    check = c.green("\u267B")
  } else {
    check = c.dim("\u25CB")
  }

  const branchRaw = wt.branch ?? "(detached)"
  let branchStr = truncate(branchRaw, BRANCH_COL)
  branchStr = isFocused ? c.bold(branchStr) : branchStr

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

  // Inline parent session indicator (orange dot on the main row)
  const parentInline = formatParentSessionInline(item.parentSession)
  const parentSuffix = parentInline ? `  ${parentInline}` : ""

  const mainLine = `  ${cursor} ${check} ${branchPadded}${pad(pr, PR_COL)}${pad(sizeStr, SIZE_COL)}${tagStr}${parentSuffix}`
  const lines = [mainLine]

  // Sub-line: dirty file status, aligned to start at the PR column
  // Prefix width: "  " + cursor(1) + " " + check(1) + " " + branchPadded(BRANCH_COL+2) = BRANCH_COL + 8
  const subIndent = " ".repeat(BRANCH_COL + 8)
  const fileStatusLine = formatFileStatus(item.fileStatus)
  if (fileStatusLine) {
    lines.push(`${subIndent}${fileStatusLine}`)
  }

  // Expanded detail (progressive disclosure via "e" key)
  const MAX_EXPANDED_FILES = 12
  const cols = process.stdout.columns ?? 100
  if (state.expandedIndex === index) {
    // SHA (only in expanded view)
    const sha = c.dim(wt.head.slice(0, SHA_COL))
    lines.push(`        ${c.dim("sha")} ${sha}`)

    // Session info (only in expanded view)
    const sessionLine = formatSessionInfo(item.sessionInfo, cols - 30)
    if (sessionLine) {
      lines.push(`        ${sessionLine}`)
    }

    // Parent session detail (only in expanded view)
    const parentLines = formatParentSessionExpanded(item.parentSession, cols - 20)
    for (const pl of parentLines) {
      lines.push(`        ${pl}`)
    }

    // File list
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
  const mainPath = shortenPath(state.mainWorktree.path, cols - 25)
  lines.push(
    `  ${c.dim("  main")}  ${c.dim(mainPath)}`,
  )
  lines.push("")

  {
    // Worktree list (always rendered -- help overlays on top)
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
    // Style: key char highlighted (cyan, or red for destructive), rest of label dim
    lines.push("")
    switch (state.mode.type) {
      case "help":
      case "browse": {
        // Hotkey label helpers: embed key in the word
        const del = `${c.red("d")}${c.dim("elete")}`
        const rel = `${c.cyan("c")} ${c.dim("release")}`
        const qut = `${c.cyan("q")}${c.dim("uit")}`
        const hlp = `${c.cyan("?")}${c.dim("more")}`

        if (state.expandedIndex !== null) {
          const opn = `${c.cyan("o")}${c.dim("pen")}`
          const col = `${c.cyan("e")} ${c.dim("collapse")}`
          lines.push(
            `  ${opn}  ${col}  ${del}  ${rel}  ${hlp}  ${qut}`,
          )
        } else {
          const nav = `${c.dim("\u2191\u2193 navigate")}`
          const sel = `${c.dim("\u2423")}${c.dim("select")}`
          const exp = `${c.cyan("e")}${c.dim("xpand")}`
          // Rename hint only when focused worktree is detached
          const focusedItem = state.items[state.cursor]
          const ren = focusedItem?.worktree.isDetached
            ? `  ${c.cyan("n")} ${c.dim("rename")}`
            : ""
          lines.push(
            `  ${nav}  ${sel}  ${exp}  ${del}  ${rel}${ren}  ${hlp}  ${qut}`,
          )
        }
        break
      }
      case "open-target": {
        const fnd = `${c.cyan("f")}${c.dim("inder")}`
        const cur = `${c.cyan("c")}${c.dim("ursor")}`
        lines.push(
          `  ${c.dim("open:")}  ${fnd}  ${cur}  ${c.dim("esc")}`,
        )
        break
      }
      case "confirm-delete": {
        const n = state.mode.indices.length
        const s = n > 1 ? "s" : ""
        lines.push(
          `  Delete ${c.bold(String(n))} worktree${s}?  ${c.cyan("y")}${c.dim("es")}  ${c.cyan("b")}${c.dim("ranch too")}  ${c.cyan("n")}${c.dim("o")}`,
        )
        break
      }
      case "confirm-force": {
        const n = state.mode.indices.length
        const s = n > 1 ? "s" : ""
        lines.push(
          `  ${c.dim(`Uncommitted changes.`)} Force delete${s}?  ${c.cyan("y")}${c.dim("es")}  ${c.cyan("n")}${c.dim("o")}`,
        )
        break
      }
      case "confirm-release": {
        const n = state.mode.indices.length
        const s = n > 1 ? "s" : ""
        lines.push(
          `  Release ${c.bold(String(n))} worktree${s}?  ${c.cyan("y")}${c.dim("es")}  ${c.cyan("b")}${c.dim("ranch too")}  ${c.cyan("n")}${c.dim("o")}`,
        )
        break
      }
      case "confirm-prune": {
        for (const candidate of state.mode.candidates) {
          lines.push(`    ${c.dim("\u2022")} ${candidate}`)
        }
        lines.push("")
        lines.push(
          `  Prune ${c.bold(String(state.mode.candidates.length))} stale reference(s)?  ${c.cyan("y")}${c.dim("es")}  ${c.cyan("n")}${c.dim("o")}`,
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

  // Composite help overlay on top of the rendered content
  const rows = process.stdout.rows ?? 24
  let finalLines = lines
  if (state.mode.type === "help") {
    finalLines = compositeOverlay(lines, helpContentLines(), rows, cols)
  }

  // Write entire frame at once to prevent flicker.
  // Each line gets an EL (Erase in Line) suffix so that when a line shrinks
  // between frames the leftover characters from the previous render are wiped.
  term.home()
  process.stdout.write(finalLines.map((l) => l + term.EL).join("\n"))
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
/**
 * Run delete operations inline within the worktree list.
 * Stays in browse mode -- each item shows its deletion progress directly
 * in its row. Completed items are removed from the list after a brief
 * delay so the user sees the success indicator before it disappears.
 */
function startDelete(
  state: State,
  indices: number[],
  withBranch: boolean,
  force: boolean,
  rerender: () => void,
): void {
  // Mark items as deleting. Stay in browse mode so the list stays visible.
  for (const idx of indices) {
    if (state.items[idx]) {
      state.items[idx].deleteStatus = { phase: "removing" }
    }
  }
  state.selected.clear()
  state.message = null
  rerender()

  ;(async () => {
    let needsForce = false

    for (const idx of indices) {
      const item = state.items[idx]
      if (!item) continue
      const wt = item.worktree

      // Step 1: remove worktree
      item.deleteStatus = { phase: "removing" }
      rerender()

      const removeResult = await removeWorktree(wt.path, force)

      if (removeResult.ok) {
        // Step 2 (optional): delete branch
        if (withBranch && wt.branch) {
          item.deleteStatus = { phase: "branch" }
          rerender()

          const branchResult = await deleteBranch(wt.branch, true)
          if (branchResult.ok) {
            item.deleteStatus = { phase: "done", message: "worktree + branch removed" }
          } else {
            item.deleteStatus = { phase: "done", message: `branch: ${branchResult.error}` }
          }
        } else {
          item.deleteStatus = { phase: "done", message: "removed" }
        }
      } else {
        const isUncommitted =
          removeResult.error?.includes("uncommitted") ||
          removeResult.error?.includes("modified") ||
          removeResult.error?.includes("untracked") ||
          removeResult.error?.includes("changes")

        if (isUncommitted && !force) {
          needsForce = true
          item.deleteStatus = { phase: "needs-force" }
        } else {
          item.deleteStatus = { phase: "error", message: removeResult.error ?? "unknown error" }
        }
      }

      rerender()
    }

    // Brief pause so the user can see the final status of each item
    await Bun.sleep(600)

    // Remove successfully deleted items from the list
    const removedIndices = new Set(
      indices.filter((idx) => state.items[idx]?.deleteStatus?.phase === "done"),
    )
    // Clear delete status on items that weren't removed (errors, needs-force)
    for (const idx of indices) {
      if (state.items[idx] && !removedIndices.has(idx)) {
        state.items[idx].deleteStatus = null
      }
    }

    if (removedIndices.size > 0) {
      // Rebuild item list without deleted items
      state.items = state.items.filter((_, i) => !removedIndices.has(i))
      state.cursor = Math.min(state.cursor, Math.max(0, state.items.length - 1))
    }

    if (needsForce) {
      state.message = {
        text: "Some worktrees have uncommitted changes. Select and press d to force.",
        kind: "error",
      }
    } else if (removedIndices.size > 0) {
      const n = removedIndices.size
      state.message = {
        text: `${n} worktree${n > 1 ? "s" : ""} removed.`,
        kind: "success",
      }
    }

    rerender()
  })()
}

/**
 * Run release operations inline within the worktree list.
 * Mirrors startDelete but items stay in the list (updated to detached state)
 * instead of being removed.
 */
function startRelease(
  state: State,
  indices: number[],
  withBranch: boolean,
  rerender: () => void,
): void {
  for (const idx of indices) {
    if (state.items[idx]) {
      state.items[idx].releaseStatus = { phase: "detaching" }
    }
  }
  state.selected.clear()
  state.message = null
  rerender()

  ;(async () => {
    let hasDirty = false

    for (const idx of indices) {
      const item = state.items[idx]
      if (!item) continue
      const wt = item.worktree

      // Check for dirty state (refuse to release)
      const fs = item.fileStatus
      if (fs.type === "dirty") {
        const s = fs.status
        if (s.staged > 0 || s.modified > 0 || s.untracked > 0 || s.ahead > 0) {
          hasDirty = true
          item.releaseStatus = { phase: "dirty" }
          rerender()
          continue
        }
      }

      // Step 1: detach HEAD
      item.releaseStatus = { phase: "detaching" }
      rerender()

      const detachResult = await detachHead(wt.path)

      if (detachResult.ok) {
        // Step 2 (optional): delete branch
        if (withBranch && wt.branch) {
          item.releaseStatus = { phase: "branch" }
          rerender()

          const branchResult = await deleteBranch(wt.branch, true)
          if (branchResult.ok) {
            item.releaseStatus = { phase: "done", message: "released + branch deleted" }
          } else {
            item.releaseStatus = { phase: "done", message: `released (branch: ${branchResult.error})` }
          }
        } else {
          item.releaseStatus = { phase: "done", message: "released" }
        }
      } else {
        item.releaseStatus = { phase: "error", message: detachResult.error ?? "unknown error" }
      }

      rerender()
    }

    // Brief pause so the user can see the final status
    await Bun.sleep(600)

    // Clear release status and refresh the full list so items update to detached state
    for (const idx of indices) {
      if (state.items[idx]) {
        state.items[idx].releaseStatus = null
      }
    }

    await refreshWorktrees(state)
    startPrFetching(state, rerender)
    startFileStatusFetching(state, rerender)
    startSessionFetching(state, rerender)
    startParentSessionFetching(state, rerender)
    startSizeFetching(state, rerender)

    if (hasDirty) {
      state.message = {
        text: "Some worktrees have uncommitted changes. Commit or stash before releasing.",
        kind: "error",
      }
    } else {
      const n = indices.length
      state.message = {
        text: `${n} worktree${n > 1 ? "s" : ""} released for recycling.`,
        kind: "success",
      }
    }

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
      sessionInfo: { type: "loading" as const },
      parentSession: { type: "loading" as const },
      deleteStatus: null,
      releaseStatus: null,
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
// Async session info fetching (background, concurrent)
// ---------------------------------------------------------------------------

const SESSION_CONCURRENCY = 6

/**
 * Fetch Claude Code session info for all worktrees in background.
 * Reads local files only (no network), so fast.
 */
function startSessionFetching(state: State, rerender: () => void): void {
  const entries = state.items.map((item, index) => ({
    path: item.worktree.path,
    index,
  }))

  const executing: Promise<void>[] = []

  const fetchOne = async ({ path, index }: { path: string; index: number }) => {
    try {
      const result = await fetchWorktreeSessionInfo(path)
      if (state.items[index]?.worktree.path === path) {
        state.items[index].sessionInfo = result
      }
    } catch {
      if (state.items[index]?.worktree.path === path) {
        state.items[index].sessionInfo = { type: "none" }
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

      if (executing.length >= SESSION_CONCURRENCY) {
        await Promise.race(executing)
      }
    }
    await Promise.all(executing)
  })()
}

// ---------------------------------------------------------------------------
// Async parent session detection (background)
// ---------------------------------------------------------------------------

/**
 * For each worktree, find the active Claude Code session that created it.
 * Runs findParentSession() for each worktree concurrently.
 * Since this involves grepping JSONL files it's the slowest fetch --
 * runs after the faster fetches have already populated the UI.
 */
function startParentSessionFetching(state: State, rerender: () => void): void {
  const entries = state.items.map((item, index) => ({
    path: item.worktree.path,
    index,
  }))

  // Run all concurrently -- findParentSession already limits grep parallelism internally
  ;(async () => {
    await Promise.all(
      entries.map(async ({ path, index }) => {
        try {
          const result = await findParentSession(path)
          if (state.items[index]?.worktree.path === path) {
            state.items[index].parentSession = result
          }
        } catch {
          if (state.items[index]?.worktree.path === path) {
            state.items[index].parentSession = { type: "none" }
          }
        }
        rerender()
      }),
    )
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

  // Navigation (collapse expand on cursor move, skip items being deleted/released)
  if (key === "up" || ch === "k") {
    let next = state.cursor - 1
    while (next >= 0 && (state.items[next]?.deleteStatus || state.items[next]?.releaseStatus)) next--
    if (next >= 0) state.cursor = next
    state.expandedIndex = null
    state.expandedFiles = null
    state.message = null
    return
  }
  if (key === "down" || ch === "j") {
    let next = state.cursor + 1
    while (next < state.items.length && (state.items[next]?.deleteStatus || state.items[next]?.releaseStatus)) next++
    if (next < state.items.length) state.cursor = next
    state.expandedIndex = null
    state.expandedFiles = null
    state.message = null
    return
  }

  // Selection (skip items being deleted/released)
  if (key === "space") {
    if (state.items[state.cursor]?.deleteStatus || state.items[state.cursor]?.releaseStatus) return
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

  // Release (for recycling)
  if (ch === "c") {
    const indices =
      state.selected.size > 0
        ? Array.from(state.selected).sort((a, b) => a - b)
        : [state.cursor]

    // Guard: skip locked worktrees
    const lockedItems = indices.filter((i) => state.items[i]?.worktree.isLocked)
    if (lockedItems.length > 0) {
      state.message = {
        text: "Cannot release locked worktree(s). Unlock first.",
        kind: "error",
      }
      return
    }

    // Filter to only items that have branches (detached ones are already released)
    const releasable = indices.filter((i) => !state.items[i]?.worktree.isDetached)
    if (releasable.length === 0) {
      state.message = { text: "Already detached.", kind: "info" }
      return
    }

    state.mode = { type: "confirm-release", indices: releasable }
    state.message = null
    return
  }

  // Rename (detached worktrees only — assigns wt-detached-N slot name)
  if (ch === "n") {
    const focused = state.items[state.cursor]
    if (!focused || !focused.worktree.isDetached) {
      return
    }

    const oldPath = focused.worktree.path
    const parent = dirname(oldPath)

    ;(async () => {
      const n = await findNextDetachedSlot(parent)
      const newPath = `${parent}/wt-detached-${n}`

      if (newPath === oldPath) {
        state.message = { text: "Already named.", kind: "info" }
        render(state)
        return
      }

      state.message = { text: `Renaming to wt-detached-${n}...`, kind: "info" }
      render(state)

      const result = await renameWorktree(oldPath, newPath)
      if (result.ok) {
        await refreshWorktrees(state)
        startPrFetching(state, () => render(state))
        startFileStatusFetching(state, () => render(state))
        startSessionFetching(state, () => render(state))
        startParentSessionFetching(state, () => render(state))
        startSizeFetching(state, () => render(state))
        state.message = { text: `Renamed to wt-detached-${n}`, kind: "success" }
      } else {
        state.message = { text: `Rename failed: ${result.error ?? "unknown"}`, kind: "error" }
      }
      render(state)
    })()
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
    startSessionFetching(state, () => render(state))
    startParentSessionFetching(state, () => render(state))
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

  // Open: enter open target picker
  if (ch === "o") {
    state.mode = { type: "open-target" }
    state.message = null
    return
  }

  // Help
  if (ch === "?") {
    state.mode = { type: "help" }
    return
  }

  // Quit
  if (key === "ctrl-c" || key === "escape" || ch === "q") {
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

/** Process a keypress in confirm-release mode. */
async function handleConfirmReleaseKey(
  state: State,
  key: Key,
  indices: number[],
): Promise<void> {
  const ch = keyChar(key)

  if (ch === "y" || ch === "b") {
    const withBranch = ch === "b"
    state.mode = { type: "browse" }
    startRelease(state, indices, withBranch, () => render(state))
    return
  }

  if (ch === "n" || key === "escape") {
    state.mode = { type: "browse" }
    state.message = null
    return
  }
}

/** Process a keypress in open-target mode. */
async function handleOpenTargetKey(state: State, key: Key): Promise<void> {
  const ch = keyChar(key)

  const focused = state.items[state.cursor]
  if (!focused) {
    state.mode = { type: "browse" }
    return
  }

  if (ch === "f") {
    openDirectory(focused.worktree.path)
    state.message = { text: `Opened ${shortenPath(focused.worktree.path, 50)}`, kind: "info" }
    state.mode = { type: "browse" }
    return
  }

  if (ch === "c") {
    openInCursor(focused.worktree.path)
    state.message = { text: `Opening in Cursor: ${shortenPath(focused.worktree.path, 50)}`, kind: "info" }
    state.mode = { type: "browse" }
    return
  }

  // Any other key cancels
  state.mode = { type: "browse" }
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
      startSessionFetching(state, () => render(state))
      startParentSessionFetching(state, () => render(state))
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

  // Fetch file statuses, session info, and parent sessions concurrently
  const [fileStatuses, sessionInfos, parentSessions] = await Promise.all([
    Promise.all(
      worktrees.map(async (wt) => {
        if (wt.isBare) return { type: "clean" as const }
        return fetchWorktreeFileStatus(wt.path)
      }),
    ),
    Promise.all(
      worktrees.map(async (wt) => fetchWorktreeSessionInfo(wt.path)),
    ),
    Promise.all(
      worktrees.map(async (wt) => findParentSession(wt.path)),
    ),
  ])

  for (let i = 0; i < worktrees.length; i++) {
    const wt = worktrees[i]
    const isRecyclable = !wt.isMain && wt.isDetached && fileStatuses[i].type === "clean"
    const prefix = isRecyclable ? c.green("\u267B") : " "
    const branch = wt.branch ?? "(detached)"
    const tags: string[] = []
    if (wt.isMain) tags.push(c.cyan("main"))
    if (wt.isLocked) tags.push(c.yellow("locked"))
    if (wt.isPrunable) tags.push(c.red("prunable"))
    const tagStr = tags.length > 0 ? `  ${tags.join(" ")}` : ""

    const home = process.env.HOME ?? ""
    let path = wt.path
    if (home && path.startsWith(home)) path = "~" + path.slice(home.length)

    // Inline parent session indicator (orange dot)
    const parentInline = formatParentSessionInline(parentSessions[i])
    const parentSuffix = parentInline ? `  ${parentInline}` : ""

    console.log(
      `  ${prefix} ${branch.padEnd(35)} ${c.dim(path)}${tagStr}${parentSuffix}`,
    )

    // Sub-line for dirty file status
    const fsLine = formatFileStatus(fileStatuses[i])
    if (fsLine) {
      console.log(`     ${fsLine}`)
    }

    // Sub-lines for session info + parent session detail (--list shows expanded by default)
    const cols = process.stdout.columns ?? 100
    const sessLine = formatSessionInfo(sessionInfos[i], cols - 20)
    if (sessLine) {
      console.log(`     ${sessLine}`)
    }
    const parentLines = formatParentSessionExpanded(parentSessions[i], cols - 20)
    for (const pl of parentLines) {
      console.log(`     ${pl}`)
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
// Non-interactive --recycle mode
// ---------------------------------------------------------------------------

async function recycleAndExit(
  targetBranch: string,
  slotPath?: string,
): Promise<void> {
  const worktrees = await listWorktrees()
  const nonMain = worktrees.filter((w) => !w.isMain)

  if (nonMain.length === 0) {
    console.error("No worktrees to recycle. Create one with `git worktree add`.")
    process.exit(1)
  }

  // Fetch file statuses for all worktrees
  const fileStatuses = await Promise.all(
    nonMain.map((wt) => fetchWorktreeFileStatus(wt.path)),
  )

  // Optionally fetch PR statuses for better scoring
  const ghDiag = await checkGhStatus()
  let prInfos: (import("./lib/git").PrInfo | null)[] = nonMain.map(() => null)
  if (ghDiag.type === "available") {
    prInfos = await Promise.all(
      nonMain.map((wt) => (wt.branch ? fetchPrForBranch(wt.branch) : null)),
    )
  }

  // Score candidates
  function scoreCandidate(
    wt: import("./lib/git").Worktree,
    fs: FileStatusResult,
    pr: import("./lib/git").PrInfo | null,
  ): number {
    if (wt.isLocked) return -1
    if (fs.type === "dirty") {
      const s = fs.status
      if (s.staged > 0 || s.modified > 0 || s.untracked > 0 || s.ahead > 0) return -1
    }
    if (fs.type !== "clean" && fs.type !== "dirty") return -1 // loading/error

    if (wt.isDetached) return 100
    if (pr?.state === "MERGED") return 50
    if (!pr) return 20
    return 10
  }

  let candidate: { wt: typeof nonMain[0]; index: number } | null = null

  if (slotPath) {
    // Find the specified slot
    const idx = nonMain.findIndex((wt) => wt.path === slotPath)
    if (idx === -1) {
      console.error(`No worktree found at ${slotPath}.`)
      process.exit(1)
    }
    const score = scoreCandidate(nonMain[idx], fileStatuses[idx], prInfos[idx])
    if (score < 0) {
      console.error(`Worktree at ${slotPath} is not recyclable (dirty or locked).`)
      process.exit(1)
    }
    candidate = { wt: nonMain[idx], index: idx }
  } else {
    // Pick the best candidate
    let bestScore = -1
    for (let i = 0; i < nonMain.length; i++) {
      const score = scoreCandidate(nonMain[i], fileStatuses[i], prInfos[i])
      if (score > bestScore) {
        bestScore = score
        candidate = { wt: nonMain[i], index: i }
      }
    }
  }

  if (!candidate || scoreCandidate(candidate.wt, fileStatuses[candidate.index], prInfos[candidate.index]) < 0) {
    console.error("No recyclable worktrees found.")
    console.error("Release an existing one with `fell` (c key), or create a new worktree.")
    process.exit(1)
  }

  const wt = candidate.wt
  const oldBranch = wt.branch

  // Detach HEAD if not already detached
  if (!wt.isDetached) {
    const detachResult = await detachHead(wt.path)
    if (!detachResult.ok) {
      console.error(`Failed to detach HEAD: ${detachResult.error}`)
      process.exit(1)
    }
  }

  // Delete old branch
  if (oldBranch) {
    const branchResult = await deleteBranch(oldBranch, true)
    if (!branchResult.ok) {
      console.error(c.dim(`Warning: could not delete branch ${oldBranch}: ${branchResult.error}`))
    }
  }

  // Fetch latest from remote
  const fetchResult = await fetchOrigin(wt.path)
  if (!fetchResult.ok) {
    console.error(c.dim(`Warning: fetch failed: ${fetchResult.error}`))
  }

  // Hash lockfile before checkout
  const lockBefore = await hashLockfile(wt.path)

  // Checkout new branch
  const checkoutResult = await checkoutNewBranch(wt.path, targetBranch)
  if (!checkoutResult.ok) {
    console.error(`Failed to checkout branch ${targetBranch}: ${checkoutResult.error}`)
    process.exit(1)
  }

  // Hash lockfile after checkout and compare
  const lockAfter = await hashLockfile(wt.path)
  const lockfileChanged = lockBefore !== null && lockAfter !== null && lockBefore !== lockAfter

  // Output: path on stdout (for piping), status on stderr
  const label = oldBranch ? `${oldBranch} \u2192 ${targetBranch}` : targetBranch
  console.error(c.green(`\u2713`) + ` Recycled: ${label}`)
  if (lockfileChanged) {
    console.error(c.yellow("\u26A0") + ` Lockfile changed. Run your package manager's install command.`)
  }
  // stdout: just the path (for `cd $(fell --recycle branch)`)
  console.log(wt.path)
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
    const hasDeleting = state.items.some((i) => i.deleteStatus !== null || i.releaseStatus !== null)
    if (hasLoading || hasDeleting) {
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
      recycle: { type: "string" },
      slot: { type: "string" },
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

  if (values.recycle) {
    await recycleAndExit(values.recycle, values.slot)
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
    console.log()
    console.log(`  ${c.bold(fellLogo())}  ${c.dim("Interactive Worktree Cleanup")}`)
    console.log()
    console.log(c.dim("  Could not determine main worktree. Are you in a git repo?"))
    console.log()
    process.exit(1)
  }

  const nonMain = allWorktrees.filter((w) => !w.isMain)
  if (nonMain.length === 0) {
    console.log()
    console.log(`  ${c.bold(fellLogo())}  ${c.dim("Interactive Worktree Cleanup")}`)
    console.log()
    console.log(c.dim("  No worktrees to manage (only main). Nothing to do."))
    console.log()
    process.exit(0)
  }

  // Initialise state
  const state: State = {
    items: nonMain.map((w) => ({
      worktree: w,
      prStatus: { type: "loading" },
      fileStatus: { type: "loading" },
      dirSize: { type: "loading" },
      sessionInfo: { type: "loading" },
      parentSession: { type: "loading" },
      deleteStatus: null,
      releaseStatus: null,
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

    // Start background fetching: PR, file status, sessions, parent sessions, size
    startPrFetching(state, () => render(state))
    startFileStatusFetching(state, () => render(state))
    startSessionFetching(state, () => render(state))
    startParentSessionFetching(state, () => render(state))
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

        case "open-target":
          await handleOpenTargetKey(state, key)
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

        case "confirm-release":
          await handleConfirmReleaseKey(state, key, state.mode.indices)
          break

        case "confirm-prune":
          await handleConfirmPruneKey(state, key)
          break

        case "result":
          // Any key returns to browse
          state.mode = { type: "browse" }
          state.message = null
          break

        case "help": {
          const hk = keyChar(key)
          if (key === "escape" || hk === "?" || hk === "q") {
            state.mode = { type: "browse" }
          } else if (hk === "l") {
            setTheme("light")
          } else if (hk === "d") {
            setTheme("dark")
          } else if (key === "ctrl-c") {
            state.shouldQuit = true
          }
          break
        }
      }

      if (!state.shouldQuit) {
        render(state)
      }
    }

    clearInterval(spinnerTimer)
  } finally {
    cleanup()
    // Force exit immediately. Background async tasks (PR fetching, size
    // estimation) hold the event loop open. They're non-critical UI state
    // -- no data corruption risk from terminating mid-flight.
    process.exit(0)
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
