import { describe, expect, test, mock } from "bun:test"
import {
  handleBrowseKey,
  handleConfirmDeleteKey,
  handleConfirmForceKey,
  handleConfirmPruneKey,
  renderRow,
  type State,
  type WorktreeItem,
} from "./cli"
import { stripAnsi } from "./lib/tui"
import type { Worktree } from "./lib/git"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    path: "/test/repo/.worktrees/feature",
    head: "abc1234def5678",
    branch: "feature",
    isBare: false,
    isMain: false,
    isLocked: false,
    lockReason: null,
    isPrunable: false,
    prunableReason: null,
    isDetached: false,
    ...overrides,
  }
}

function makeItem(overrides: Partial<WorktreeItem> = {}): WorktreeItem {
  return {
    worktree: makeWorktree(),
    prStatus: { type: "none" },
    fileStatus: { type: "clean" },
    dirSize: { type: "done", bytes: 1024 * 1024 },
    sessionInfo: { type: "none" },
    parentSession: { type: "none" },
    deleteStatus: null,
    ...overrides,
  }
}

function makeState(overrides: Partial<State> = {}): State {
  return {
    items: [
      makeItem({ worktree: makeWorktree({ branch: "feature-a", path: "/test/.worktrees/a" }) }),
      makeItem({ worktree: makeWorktree({ branch: "feature-b", path: "/test/.worktrees/b" }) }),
      makeItem({ worktree: makeWorktree({ branch: "feature-c", path: "/test/.worktrees/c" }) }),
    ],
    mainWorktree: makeWorktree({ branch: "main", path: "/test/repo", isMain: true }),
    cursor: 0,
    selected: new Set(),
    mode: { type: "browse" },
    spinnerFrame: 0,
    message: null,
    shouldQuit: false,
    ghDiagnostic: { type: "available" },
    expandedIndex: null,
    expandedFiles: null,
    repoDir: "/test/repo",
    scrollOffset: 0,
    isDeleting: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// handleBrowseKey — Navigation
// ---------------------------------------------------------------------------

describe("handleBrowseKey — navigation", () => {
  test("down moves cursor forward", async () => {
    const state = makeState({ cursor: 0 })
    await handleBrowseKey(state, "down")
    expect(state.cursor).toBe(1)
  })

  test("j moves cursor forward", async () => {
    const state = makeState({ cursor: 0 })
    await handleBrowseKey(state, { char: "j" })
    expect(state.cursor).toBe(1)
  })

  test("up moves cursor backward", async () => {
    const state = makeState({ cursor: 1 })
    await handleBrowseKey(state, "up")
    expect(state.cursor).toBe(0)
  })

  test("k moves cursor backward", async () => {
    const state = makeState({ cursor: 2 })
    await handleBrowseKey(state, { char: "k" })
    expect(state.cursor).toBe(1)
  })

  test("up at top stays at 0", async () => {
    const state = makeState({ cursor: 0 })
    await handleBrowseKey(state, "up")
    expect(state.cursor).toBe(0)
  })

  test("down at bottom stays at last", async () => {
    const state = makeState({ cursor: 2 })
    await handleBrowseKey(state, "down")
    expect(state.cursor).toBe(2)
  })

  test("navigation collapses expanded item", async () => {
    const state = makeState({ cursor: 0, expandedIndex: 0, expandedFiles: [] })
    await handleBrowseKey(state, "down")
    expect(state.expandedIndex).toBeNull()
    expect(state.expandedFiles).toBeNull()
  })

  test("navigation clears message", async () => {
    const state = makeState({ cursor: 0, message: { text: "old message", kind: "info" } })
    await handleBrowseKey(state, "down")
    expect(state.message).toBeNull()
  })

  test("down skips items being deleted", async () => {
    const state = makeState({ cursor: 0 })
    state.items[1].deleteStatus = { phase: "removing" }
    await handleBrowseKey(state, "down")
    expect(state.cursor).toBe(2)
  })

  test("up skips items being deleted", async () => {
    const state = makeState({ cursor: 2 })
    state.items[1].deleteStatus = { phase: "done", message: "removed" }
    await handleBrowseKey(state, "up")
    expect(state.cursor).toBe(0)
  })

  test("scroll-up moves cursor backward", async () => {
    const state = makeState({ cursor: 1 })
    await handleBrowseKey(state, "scroll-up")
    expect(state.cursor).toBe(0)
  })

  test("scroll-down moves cursor forward", async () => {
    const state = makeState({ cursor: 0 })
    await handleBrowseKey(state, "scroll-down")
    expect(state.cursor).toBe(1)
  })

  test("unknown key is ignored", async () => {
    const state = makeState({ cursor: 1 })
    await handleBrowseKey(state, "unknown")
    expect(state.cursor).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// handleBrowseKey — Selection
// ---------------------------------------------------------------------------

describe("handleBrowseKey — selection", () => {
  test("space toggles selection on", async () => {
    const state = makeState({ cursor: 0 })
    await handleBrowseKey(state, "space")
    expect(state.selected.has(0)).toBe(true)
  })

  test("space toggles selection off", async () => {
    const state = makeState({ cursor: 0, selected: new Set([0]) })
    await handleBrowseKey(state, "space")
    expect(state.selected.has(0)).toBe(false)
  })

  test("space auto-advances cursor", async () => {
    const state = makeState({ cursor: 0 })
    await handleBrowseKey(state, "space")
    expect(state.cursor).toBe(1)
  })

  test("space at last item does not advance past end", async () => {
    const state = makeState({ cursor: 2 })
    await handleBrowseKey(state, "space")
    expect(state.cursor).toBe(2)
  })

  test("space on deleting item is ignored", async () => {
    const state = makeState({ cursor: 0 })
    state.items[0].deleteStatus = { phase: "removing" }
    await handleBrowseKey(state, "space")
    expect(state.selected.has(0)).toBe(false)
  })

  test("a selects all", async () => {
    const state = makeState()
    await handleBrowseKey(state, { char: "a" })
    expect(state.selected.size).toBe(3)
  })

  test("a deselects all when all selected", async () => {
    const state = makeState({ selected: new Set([0, 1, 2]) })
    await handleBrowseKey(state, { char: "a" })
    expect(state.selected.size).toBe(0)
  })

  test("space is blocked while deleting", async () => {
    const state = makeState({ cursor: 0, isDeleting: true })
    await handleBrowseKey(state, "space")
    expect(state.selected.has(0)).toBe(false)
  })

  test("a is blocked while deleting", async () => {
    const state = makeState({ isDeleting: true })
    await handleBrowseKey(state, { char: "a" })
    expect(state.selected.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// handleBrowseKey — Mode transitions
// ---------------------------------------------------------------------------

describe("handleBrowseKey — mode transitions", () => {
  test("d is blocked while deleting", async () => {
    const state = makeState({ cursor: 0, isDeleting: true })
    await handleBrowseKey(state, { char: "d" })
    expect(state.mode.type).toBe("browse")
  })

  test("r is blocked while deleting", async () => {
    const state = makeState({ isDeleting: true })
    await handleBrowseKey(state, { char: "r" })
    expect(state.message).toBeNull()
  })

  test("p is blocked while deleting", async () => {
    const state = makeState({ isDeleting: true })
    await handleBrowseKey(state, { char: "p" })
    expect(state.mode.type).toBe("browse")
  })

  test("d enters confirm-delete with cursor index", async () => {
    const state = makeState({ cursor: 1 })
    await handleBrowseKey(state, { char: "d" })
    expect(state.mode).toEqual({ type: "confirm-delete", indices: [1] })
  })

  test("d with selection uses selected indices", async () => {
    const state = makeState({ selected: new Set([0, 2]) })
    await handleBrowseKey(state, { char: "d" })
    expect(state.mode).toEqual({ type: "confirm-delete", indices: [0, 2] })
  })

  test("d on locked worktree shows error", async () => {
    const state = makeState({ cursor: 0 })
    state.items[0].worktree.isLocked = true
    await handleBrowseKey(state, { char: "d" })
    expect(state.mode.type).toBe("browse")
    expect(state.message?.kind).toBe("error")
    expect(state.message?.text).toContain("locked")
  })

  test("? enters help mode", async () => {
    const state = makeState()
    await handleBrowseKey(state, { char: "?" })
    expect(state.mode).toEqual({ type: "help" })
  })

  test("q sets shouldQuit", async () => {
    const state = makeState()
    await handleBrowseKey(state, { char: "q" })
    expect(state.shouldQuit).toBe(true)
  })

  test("ctrl-c sets shouldQuit", async () => {
    const state = makeState()
    await handleBrowseKey(state, "ctrl-c")
    expect(state.shouldQuit).toBe(true)
  })

  test("escape sets shouldQuit", async () => {
    const state = makeState()
    await handleBrowseKey(state, "escape")
    expect(state.shouldQuit).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// handleBrowseKey — Expand
// ---------------------------------------------------------------------------

describe("handleBrowseKey — expand", () => {
  test("e expands current item", async () => {
    const state = makeState({ cursor: 1 })
    await handleBrowseKey(state, { char: "e" })
    expect(state.expandedIndex).toBe(1)
    expect(state.expandedFiles).toBeNull() // loading
  })

  test("e collapses already expanded item", async () => {
    const state = makeState({ cursor: 1, expandedIndex: 1, expandedFiles: [] })
    await handleBrowseKey(state, { char: "e" })
    expect(state.expandedIndex).toBeNull()
    expect(state.expandedFiles).toBeNull()
  })

  test("e on different item switches expansion", async () => {
    const state = makeState({ cursor: 2, expandedIndex: 0, expandedFiles: [] })
    await handleBrowseKey(state, { char: "e" })
    expect(state.expandedIndex).toBe(2)
    expect(state.expandedFiles).toBeNull() // loading new item
  })
})

// ---------------------------------------------------------------------------
// handleConfirmDeleteKey
// ---------------------------------------------------------------------------

describe("handleConfirmDeleteKey", () => {
  test("n cancels and returns to browse", async () => {
    const state = makeState({ mode: { type: "confirm-delete", indices: [0] } })
    await handleConfirmDeleteKey(state, { char: "n" }, [0])
    expect(state.mode.type).toBe("browse")
  })

  test("escape cancels and returns to browse", async () => {
    const state = makeState({ mode: { type: "confirm-delete", indices: [0] } })
    await handleConfirmDeleteKey(state, "escape", [0])
    expect(state.mode.type).toBe("browse")
  })

  test("y starts deletion (marks items)", async () => {
    const state = makeState({ mode: { type: "confirm-delete", indices: [0] } })
    // We can't fully test startDelete (it calls git), but we can verify
    // it sets deleteStatus on the item
    await handleConfirmDeleteKey(state, { char: "y" }, [0])
    expect(state.items[0].deleteStatus).not.toBeNull()
    expect(state.selected.size).toBe(0) // selection cleared
  })

  test("b starts deletion with branch flag", async () => {
    const state = makeState({ mode: { type: "confirm-delete", indices: [0] } })
    await handleConfirmDeleteKey(state, { char: "b" }, [0])
    expect(state.items[0].deleteStatus).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// handleConfirmForceKey
// ---------------------------------------------------------------------------

describe("handleConfirmForceKey", () => {
  test("n cancels and returns to browse", async () => {
    const state = makeState({ mode: { type: "confirm-force", indices: [0], withBranch: false } })
    await handleConfirmForceKey(state, { char: "n" }, [0], false)
    expect(state.mode.type).toBe("browse")
  })

  test("escape cancels", async () => {
    const state = makeState({ mode: { type: "confirm-force", indices: [0], withBranch: false } })
    await handleConfirmForceKey(state, "escape", [0], false)
    expect(state.mode.type).toBe("browse")
  })

  test("y starts force deletion", async () => {
    const state = makeState({ mode: { type: "confirm-force", indices: [0], withBranch: false } })
    await handleConfirmForceKey(state, { char: "y" }, [0], false)
    expect(state.items[0].deleteStatus).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// handleConfirmPruneKey
// ---------------------------------------------------------------------------

describe("handleConfirmPruneKey", () => {
  test("n cancels and returns to browse", async () => {
    const state = makeState({ mode: { type: "confirm-prune", candidates: ["stale ref"] } })
    await handleConfirmPruneKey(state, { char: "n" })
    expect(state.mode.type).toBe("browse")
  })

  test("escape cancels", async () => {
    const state = makeState({ mode: { type: "confirm-prune", candidates: ["stale ref"] } })
    await handleConfirmPruneKey(state, "escape")
    expect(state.mode.type).toBe("browse")
  })
})

// ---------------------------------------------------------------------------
// renderRow
// ---------------------------------------------------------------------------

describe("renderRow", () => {
  test("normal row: shows branch and sha", () => {
    const state = makeState({ cursor: 0 })
    const lines = renderRow(state.items[0], 0, state)
    expect(lines.length).toBeGreaterThanOrEqual(1)
    const plain = stripAnsi(lines[0])
    expect(plain).toContain("feature-a")
    expect(plain).toContain("abc1234") // first 7 chars of SHA
  })

  test("focused row: has cursor marker", () => {
    const state = makeState({ cursor: 0 })
    const lines = renderRow(state.items[0], 0, state)
    const plain = stripAnsi(lines[0])
    // Focused cursor marker (❯)
    expect(lines[0]).toContain("\u276F")
  })

  test("unfocused row: no cursor marker", () => {
    const state = makeState({ cursor: 1 })
    const lines = renderRow(state.items[0], 0, state)
    expect(lines[0]).not.toContain("\u276F")
  })

  test("selected row: shows filled circle", () => {
    const state = makeState({ cursor: 1, selected: new Set([0]) })
    const lines = renderRow(state.items[0], 0, state)
    // Filled circle (●) for selected
    expect(lines[0]).toContain("\u25CF")
  })

  test("unselected row: shows empty circle", () => {
    const state = makeState({ cursor: 1 })
    const lines = renderRow(state.items[0], 0, state)
    // Empty circle (○) for unselected
    expect(lines[0]).toContain("\u25CB")
  })

  test("locked worktree: shows locked tag", () => {
    const state = makeState()
    state.items[0].worktree.isLocked = true
    const lines = renderRow(state.items[0], 0, state)
    const plain = stripAnsi(lines[0])
    expect(plain).toContain("locked")
  })

  test("prunable worktree: shows prunable tag", () => {
    const state = makeState()
    state.items[0].worktree.isPrunable = true
    const lines = renderRow(state.items[0], 0, state)
    const plain = stripAnsi(lines[0])
    expect(plain).toContain("prunable")
  })

  test("dirty file status: shows sub-line", () => {
    const state = makeState()
    state.items[0].fileStatus = {
      type: "dirty",
      status: { staged: 2, modified: 1, untracked: 0, ahead: 0, behind: 0 },
    }
    const lines = renderRow(state.items[0], 0, state)
    expect(lines.length).toBeGreaterThan(1)
    const subPlain = stripAnsi(lines[1])
    expect(subPlain).toContain("2 staged")
    expect(subPlain).toContain("1 modified")
  })

  test("clean file status: no sub-line", () => {
    const state = makeState()
    state.items[0].fileStatus = { type: "clean" }
    const lines = renderRow(state.items[0], 0, state)
    expect(lines.length).toBe(1)
  })

  test("detached HEAD: shows (detached)", () => {
    const state = makeState()
    state.items[0].worktree.branch = null
    state.items[0].worktree.isDetached = true
    const lines = renderRow(state.items[0], 0, state)
    const plain = stripAnsi(lines[0])
    expect(plain).toContain("(detached)")
  })

  // Delete status phases
  test("delete removing: shows spinner", () => {
    const state = makeState()
    state.items[0].deleteStatus = { phase: "removing" }
    const lines = renderRow(state.items[0], 0, state)
    const plain = stripAnsi(lines[0])
    expect(plain).toContain("removing")
  })

  test("delete branch: shows deleting branch", () => {
    const state = makeState()
    state.items[0].deleteStatus = { phase: "branch" }
    const lines = renderRow(state.items[0], 0, state)
    const plain = stripAnsi(lines[0])
    expect(plain).toContain("deleting branch")
  })

  test("delete done: shows checkmark and message", () => {
    const state = makeState()
    state.items[0].deleteStatus = { phase: "done", message: "removed" }
    const lines = renderRow(state.items[0], 0, state)
    const plain = stripAnsi(lines[0])
    expect(plain).toContain("removed")
    expect(lines[0]).toContain("\u2713") // checkmark
  })

  test("delete error: shows X and message", () => {
    const state = makeState()
    state.items[0].deleteStatus = { phase: "error", message: "permission denied" }
    const lines = renderRow(state.items[0], 0, state)
    const plain = stripAnsi(lines[0])
    expect(plain).toContain("permission denied")
    expect(lines[0]).toContain("\u2717") // X mark
  })

  test("delete needs-force: shows ! and message", () => {
    const state = makeState()
    state.items[0].deleteStatus = { phase: "needs-force" }
    const lines = renderRow(state.items[0], 0, state)
    const plain = stripAnsi(lines[0])
    expect(plain).toContain("uncommitted changes")
  })

  test("expanded item: shows file list", () => {
    const state = makeState({
      cursor: 0,
      expandedIndex: 0,
      expandedFiles: [
        { path: "src/main.ts", status: "staged" },
        { path: "README.md", status: "modified" },
      ],
    })
    const lines = renderRow(state.items[0], 0, state)
    const allPlain = lines.map(stripAnsi).join("\n")
    expect(allPlain).toContain("src/main.ts")
    expect(allPlain).toContain("README.md")
  })

  test("expanded with no changed files", () => {
    const state = makeState({ cursor: 0, expandedIndex: 0, expandedFiles: [] })
    const lines = renderRow(state.items[0], 0, state)
    const allPlain = lines.map(stripAnsi).join("\n")
    expect(allPlain).toContain("no changed files")
  })

  test("expanded while loading: shows loading", () => {
    const state = makeState({ cursor: 0, expandedIndex: 0, expandedFiles: null })
    const lines = renderRow(state.items[0], 0, state)
    const allPlain = lines.map(stripAnsi).join("\n")
    expect(allPlain).toContain("loading files")
  })

  test("expanded file list truncation at 12 files", () => {
    const state = makeState({
      cursor: 0,
      expandedIndex: 0,
      expandedFiles: Array.from({ length: 15 }, (_, i) => ({
        path: `file${i}.ts`,
        status: "modified" as const,
      })),
    })
    const lines = renderRow(state.items[0], 0, state)
    const allPlain = lines.map(stripAnsi).join("\n")
    expect(allPlain).toContain("file0.ts")
    expect(allPlain).toContain("file11.ts")
    expect(allPlain).not.toContain("file12.ts")
    expect(allPlain).toContain("3 more")
  })

  test("parent session inline indicator shown", () => {
    const state = makeState()
    state.items[0].parentSession = {
      type: "found",
      session: { sessionId: "abc", cwd: "/test", prompt: "fix bug" },
    }
    const lines = renderRow(state.items[0], 0, state)
    const plain = stripAnsi(lines[0])
    expect(plain).toContain("session")
  })

  test("size shown when loaded", () => {
    const state = makeState()
    state.items[0].dirSize = { type: "done", bytes: 1024 * 1024 * 100 }
    const lines = renderRow(state.items[0], 0, state)
    const plain = stripAnsi(lines[0])
    expect(plain).toContain("100.0 MB")
  })

  test("PR status shown in row", () => {
    const state = makeState()
    state.items[0].prStatus = {
      type: "found",
      pr: { number: 42, state: "MERGED", url: "https://x.com/42", title: "Fix" },
    }
    const lines = renderRow(state.items[0], 0, state)
    const plain = stripAnsi(lines[0])
    expect(plain).toContain("#42")
    expect(plain).toContain("merged")
  })
})
