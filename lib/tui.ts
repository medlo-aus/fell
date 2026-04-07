/**
 * Terminal UI primitives for fell.
 * Stateless helpers: ANSI colours, key parsing, text formatting,
 * and the help screen content.
 */

import type { PrStatus, FileStatusResult, SessionResult, GlobalRepoGroup, ParentSessionResult } from "./git"

// ---------------------------------------------------------------------------
// ANSI escape helpers
// ---------------------------------------------------------------------------

const ESC = "\x1b"
const CSI = `${ESC}[`

/** Colour/style wrappers using standard ANSI escape codes. */
export const c = {
  dim: (s: string) => `${CSI}2m${s}${CSI}0m`,
  bold: (s: string) => `${CSI}1m${s}${CSI}0m`,
  italic: (s: string) => `${CSI}3m${s}${CSI}0m`,
  underline: (s: string) => `${CSI}4m${s}${CSI}0m`,
  inverse: (s: string) => `${CSI}7m${s}${CSI}0m`,
  cyan: (s: string) => `${CSI}36m${s}${CSI}0m`,
  green: (s: string) => `${CSI}32m${s}${CSI}0m`,
  red: (s: string) => `${CSI}31m${s}${CSI}0m`,
  yellow: (s: string) => `${CSI}33m${s}${CSI}0m`,
  magenta: (s: string) => `${CSI}35m${s}${CSI}0m`,
  white: (s: string) => `${CSI}37m${s}${CSI}0m`,
  lime: (s: string) => `${CSI}38;5;154m${s}${CSI}0m`,
} as const

/**
 * Apply a linear gradient across a string using 256-colour ANSI.
 * Each character gets an interpolated colour between the start and end RGB values.
 */
export function gradient(
  s: string,
  from: [number, number, number],
  to: [number, number, number],
): string {
  const len = s.length
  if (len === 0) return s
  return s
    .split("")
    .map((ch, i) => {
      const t = len === 1 ? 0 : i / (len - 1)
      const r = Math.round(from[0] + (to[0] - from[0]) * t)
      const g = Math.round(from[1] + (to[1] - from[1]) * t)
      const b = Math.round(from[2] + (to[2] - from[2]) * t)
      return `${CSI}38;2;${r};${g};${b}m${ch}`
    })
    .join("") + `${CSI}0m`
}

/** Pre-built gradient for the "fell" brand text. Cyan -> lime. */
export function fellLogo(): string {
  return gradient("fell", [80, 200, 255], [160, 230, 80])
}

export const SPINNER_FRAMES = [
  "\u28CB", "\u28D9", "\u28F9", "\u28F8", "\u28FC", "\u28F4",
  "\u28E6", "\u28E7", "\u28C7", "\u28CF",
] as const

// ---------------------------------------------------------------------------
// Terminal control
// ---------------------------------------------------------------------------

export const term = {
  enterAltScreen: () => process.stdout.write(`${CSI}?1049h`),
  exitAltScreen: () => process.stdout.write(`${CSI}?1049l`),
  hideCursor: () => process.stdout.write(`${CSI}?25l`),
  showCursor: () => process.stdout.write(`${CSI}?25h`),
  home: () => process.stdout.write(`${CSI}H`),
  clearBelow: () => process.stdout.write(`${CSI}J`),
  clearScreen: () => process.stdout.write(`${CSI}2J`),
  /** Erase from cursor to end of line - append to each line to prevent ghost chars. */
  EL: `${CSI}K`,
}

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

/**
 * OSC 8 hyperlink - clickable in iTerm2, Kitty, WezTerm, etc.
 * Terminals that don't support it simply render the text.
 */
export function hyperlink(text: string, url: string): string {
  return `${ESC}]8;;${url}\x07${text}${ESC}]8;;\x07`
}

/** Strip ANSI escape codes (colours + OSC 8 links) for width calculation. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07]*\x07/g, "") // OSC sequences
    .replace(/\x1b\[[0-9;]*m/g, "") // SGR sequences
}

/** Visible character count excluding ANSI codes. */
export function visibleLength(s: string): number {
  return stripAnsi(s).length
}

/** Pad a (possibly ANSI-coloured) string to `width` visible chars. */
export function pad(s: string, width: number): string {
  const diff = width - visibleLength(s)
  return diff > 0 ? s + " ".repeat(diff) : s
}

/** Truncate plain text with ".." suffix when it exceeds `width`. */
export function truncate(s: string, width: number): string {
  if (s.length <= width) return s
  if (width <= 2) return s.slice(0, width)
  return s.slice(0, width - 2) + ".."
}

/** Replace $HOME prefix with ~ and truncate to maxWidth. */
export function shortenPath(fullPath: string, maxWidth: number): string {
  const home = process.env.HOME ?? ""
  let display = fullPath
  if (home && display.startsWith(home)) {
    display = "~" + display.slice(home.length)
  }
  return truncate(display, maxWidth)
}

// ---------------------------------------------------------------------------
// Key parsing
// ---------------------------------------------------------------------------

export type Key =
  | "up"
  | "down"
  | "left"
  | "right"
  | "enter"
  | "space"
  | "escape"
  | "backspace"
  | "ctrl-c"
  | { char: string }

/** Parse raw stdin bytes into a Key value. */
export function parseKey(data: Buffer): Key {
  if (data[0] === 0x1b && data[1] === 0x5b) {
    switch (data[2]) {
      case 0x41:
        return "up"
      case 0x42:
        return "down"
      case 0x43:
        return "right"
      case 0x44:
        return "left"
    }
  }
  switch (data[0]) {
    case 0x03:
      return "ctrl-c"
    case 0x0d:
    case 0x0a:
      return "enter"
    case 0x20:
      return "space"
    case 0x7f:
      return "backspace"
    case 0x1b:
      return "escape"
  }
  return { char: data.toString("utf8") }
}

/** Extract the character value from a Key, or null for special keys. */
export function keyChar(key: Key): string | null {
  if (typeof key === "object" && "char" in key) return key.char
  return null
}

// ---------------------------------------------------------------------------
// PR status formatting
// ---------------------------------------------------------------------------

/** Render a PrStatus value to a coloured string for the worktree list. */
export function formatPrStatus(status: PrStatus, spinnerFrame: number): string {
  switch (status.type) {
    case "loading": {
      const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]
      return c.dim(`${frame} fetching`)
    }
    case "found": {
      const { pr } = status
      const tag = hyperlink(`#${pr.number}`, pr.url)
      switch (pr.state) {
        case "MERGED":
          return c.green(`${tag} merged`)
        case "OPEN":
          return c.yellow(`${tag} open`)
        case "CLOSED":
          return c.red(`${tag} closed`)
      }
      break
    }
    case "none":
      return c.dim("no PR")
    case "error":
      return c.dim("fetch error")
    case "skipped":
      return c.dim("-")
  }
  return ""
}

// ---------------------------------------------------------------------------
// File status formatting
// ---------------------------------------------------------------------------

/**
 * Render a file status sub-line for a worktree.
 * Returns null if clean or still loading - only renders when dirty.
 * Warning triangle prefix to draw attention to uncommitted/unpushed work.
 */
export function formatFileStatus(result: FileStatusResult): string | null {
  if (result.type !== "dirty") return null

  const { staged, modified, untracked, ahead, behind } = result.status
  const parts: string[] = []

  if (staged > 0) parts.push(c.green(`${staged} staged`))
  if (modified > 0) parts.push(c.yellow(`${modified} modified`))
  if (untracked > 0) parts.push(c.dim(`${untracked} untracked`))
  if (ahead > 0) parts.push(c.cyan(`${ahead} unpushed`))
  if (behind > 0) parts.push(c.magenta(`${behind} behind`))

  if (parts.length === 0) return null

  return `${c.yellow("\u26A0")} ${parts.join(c.dim("  \u00B7  "))}`
}

// ---------------------------------------------------------------------------
// Session info formatting
// ---------------------------------------------------------------------------

/**
 * Render a Claude Code session sub-line for a worktree.
 * Returns null if no sessions or still loading.
 */
export function formatSessionInfo(
  result: SessionResult,
  maxPromptWidth: number,
): string | null {
  if (result.type !== "found") return null

  const { sessionCount, latestPrompt } = result.info
  const s = sessionCount === 1 ? "session" : "sessions"
  const count = c.dim(`${sessionCount} ${s}`)

  if (!latestPrompt) {
    return `${c.dim("\u25C8")} ${count}`
  }

  const prompt = truncate(latestPrompt, maxPromptWidth)
  return `${c.dim("\u25C8")} ${count} ${c.dim("\u00B7")} ${c.dim(c.italic(`"${prompt}"`))}`
}

// ---------------------------------------------------------------------------
// Parent session formatting
// ---------------------------------------------------------------------------

/** Orange 256-colour code for Claude/session indicators. */
const orange = (s: string) => `\x1b[38;5;208m${s}\x1b[0m`

/**
 * Render an inline orange dot indicator for worktrees with an active parent session.
 * Shown on the main row (not a sub-line). Returns empty string if no parent session.
 */
export function formatParentSessionInline(result: ParentSessionResult): string {
  if (result.type !== "found") return ""
  return orange("\u25CF") + " " + c.dim("session")
}

/**
 * Render expanded parent session detail lines (shown when user presses "e").
 * Includes the parent session's CWD and prompt summary.
 */
export function formatParentSessionExpanded(
  result: ParentSessionResult,
  maxWidth: number,
): string[] {
  if (result.type !== "found") return []

  const { cwd, prompt } = result.session
  const home = process.env.HOME ?? ""
  let cwdDisplay = cwd
  if (home && cwdDisplay.startsWith(home)) {
    cwdDisplay = "~" + cwdDisplay.slice(home.length)
  }

  const lines: string[] = []
  const label = `${orange("\u25CF")} ${c.dim("session")} ${c.dim("\u00B7")} ${c.dim(truncate(cwdDisplay, 35))}`

  if (prompt) {
    lines.push(`${label} ${c.dim("\u00B7")} ${c.dim(c.italic(`"${truncate(prompt, maxWidth - 50)}"`))}`)
  } else {
    lines.push(label)
  }

  return lines
}

// ---------------------------------------------------------------------------
// Global session rendering
// ---------------------------------------------------------------------------

/**
 * Render the "other repos" global session section for the TUI.
 * Shows a compact summary of sessions grouped by repo.
 */
export function renderGlobalSessionLines(
  groups: GlobalRepoGroup[],
  maxWidth: number,
): string[] {
  if (groups.length === 0) return []

  const totalRepos = groups.length
  const totalWorktrees = groups.reduce((sum, g) => sum + g.worktrees.length, 0)
  const totalSessions = groups.reduce((sum, g) => sum + g.totalSessions, 0)

  const lines: string[] = []
  lines.push("")
  lines.push(
    `  ${c.dim(`${totalRepos} other repo${totalRepos === 1 ? "" : "s"}`)} ${c.dim("\u00B7")} ${c.dim(`${totalWorktrees} worktree${totalWorktrees === 1 ? "" : "s"}`)} ${c.dim("\u00B7")} ${c.dim(`${totalSessions} session${totalSessions === 1 ? "" : "s"}`)}`,
  )

  for (const group of groups) {
    const home = process.env.HOME ?? ""
    let repoDisplay = group.repoRoot
    if (home && repoDisplay.startsWith(home)) {
      repoDisplay = "~" + repoDisplay.slice(home.length)
    }

    const wtCount = group.worktrees.length
    const sessCount = group.totalSessions

    lines.push(
      `    ${c.dim(truncate(repoDisplay, maxWidth - 30))}  ${c.dim(`${wtCount} wt`)} ${c.dim("\u00B7")} ${c.dim(`${sessCount} sess`)}`,
    )

    // Show worktrees with their latest prompt (compact)
    for (const wt of group.worktrees.slice(0, 3)) {
      const name = wt.worktreeName ?? "main"
      const prompt = wt.latestPrompt
        ? ` ${c.dim("\u00B7")} ${c.dim(c.italic(`"${truncate(wt.latestPrompt, maxWidth - 40)}"`))}`
        : ""
      lines.push(
        `      ${c.dim("\u25C8")} ${c.dim(name)}${prompt}`,
      )
    }
    if (group.worktrees.length > 3) {
      lines.push(`      ${c.dim(`... ${group.worktrees.length - 3} more`)}`)
    }
  }

  return lines
}

/**
 * Render global sessions for --list mode (more expanded than TUI).
 */
export function printGlobalSessions(groups: GlobalRepoGroup[]): void {
  if (groups.length === 0) return

  console.log()
  console.log(`  ${c.dim("OTHER REPOS")}`)
  console.log()

  for (const group of groups) {
    const home = process.env.HOME ?? ""
    let repoDisplay = group.repoRoot
    if (home && repoDisplay.startsWith(home)) {
      repoDisplay = "~" + repoDisplay.slice(home.length)
    }

    const parts: string[] = []
    if (group.worktrees.length > 0) {
      parts.push(`${group.worktrees.length} worktree${group.worktrees.length === 1 ? "" : "s"}`)
    }
    parts.push(`${group.totalSessions} session${group.totalSessions === 1 ? "" : "s"}`)

    console.log(`  ${c.dim(repoDisplay)}  ${c.dim(`(${parts.join(", ")})`)}`)

    // Main repo sessions
    if (group.main && group.main.sessionCount > 0) {
      const prompt = group.main.latestPrompt
        ? `  ${c.dim(c.italic(`"${truncate(group.main.latestPrompt, 60)}"`))}`
        : ""
      console.log(
        `    ${c.dim("\u25C8")} ${c.dim("main")} ${c.dim("\u00B7")} ${c.dim(`${group.main.sessionCount} session${group.main.sessionCount === 1 ? "" : "s"}`)}${prompt}`,
      )
    }

    // Worktree sessions
    for (const wt of group.worktrees) {
      const name = wt.worktreeName ?? "unknown"
      const prompt = wt.latestPrompt
        ? `  ${c.dim(c.italic(`"${truncate(wt.latestPrompt, 60)}"`))}`
        : ""
      console.log(
        `    ${c.dim("\u25C8")} ${c.dim(name)} ${c.dim("\u00B7")} ${c.dim(`${wt.sessionCount} session${wt.sessionCount === 1 ? "" : "s"}`)}${prompt}`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Help screen
// ---------------------------------------------------------------------------

export function renderHelpLines(): string[] {
  return [
    "",
    `  ${c.bold("KEYBINDINGS")}`,
    "",
    `    ${c.cyan("up/down")} or ${c.cyan("k/j")}   Navigate`,
    `    ${c.cyan("space")}             Toggle selection on focused item`,
    `    ${c.cyan("a")}                 Select / deselect all`,
    `    ${c.cyan("e")}                 Expand / collapse file list for focused worktree`,
    `    ${c.cyan("o")}                 Open focused worktree in file manager`,
    `    ${c.cyan("d")}                 Delete focused or selected worktree(s)`,
    `    ${c.cyan("p")}                 Prune stale worktree references`,
    `    ${c.cyan("r")}                 Refresh list + re-fetch PR statuses`,
    `    ${c.cyan("?")}                 Toggle this help screen`,
    `    ${c.cyan("q")} / ${c.cyan("ctrl+c")}        Quit`,
    "",
    `  ${c.bold("PRUNE vs DELETE")}`,
    "",
    `    ${c.yellow("prune")}   Cleans up ${c.italic("stale administrative references")}. When a worktree`,
    `            directory has been manually deleted (rm -rf) but git still`,
    `            tracks it, prune removes those orphaned references.`,
    `            ${c.dim("Safe: only affects already-missing worktrees.")}`,
    "",
    `    ${c.yellow("delete")}  ${c.italic("Properly removes")} a worktree: deletes the working directory`,
    `            and cleans up git tracking. Optionally also force-deletes`,
    `            the associated branch. Use for worktrees you no longer need.`,
    `            ${c.dim("Destructive: removes files from disk.")}`,
    "",
    `  ${c.dim("press ? or escape to return")}`,
  ]
}

// ---------------------------------------------------------------------------
// Non-interactive help (--help flag)
// ---------------------------------------------------------------------------

export function printCliHelp(): void {
  console.log()
  console.log(`  ${c.bold(fellLogo())}  ${c.dim("Interactive Worktree Cleanup")}`)
  console.log()
  console.log(c.yellow("  USAGE"))
  console.log()
  console.log(`    ${c.dim("$")} fell            ${c.dim("Interactive mode (default)")}`)
  console.log(`    ${c.dim("$")} fell ${c.cyan("--list")}     ${c.dim("Print worktrees and exit")}`)
  console.log(`    ${c.dim("$")} fell ${c.cyan("--help")}     ${c.dim("Show this help")}`)
  console.log()
  console.log(c.yellow("  INTERACTIVE COMMANDS"))
  console.log()
  console.log(`    ${c.cyan("up/down")} or ${c.cyan("k/j")}   Navigate worktree list`)
  console.log(`    ${c.cyan("space")}             Toggle selection`)
  console.log(`    ${c.cyan("a")}                 Select / deselect all`)
  console.log(`    ${c.cyan("e")}                 Expand / collapse file list`)
  console.log(`    ${c.cyan("o")}                 Open worktree in file manager`)
  console.log(`    ${c.cyan("d")}                 Delete worktree(s) + optionally branches`)
  console.log(`    ${c.cyan("p")}                 Prune stale references`)
  console.log(`    ${c.cyan("r")}                 Refresh list + PR statuses`)
  console.log(`    ${c.cyan("?")}                 In-app help (prune vs delete explained)`)
  console.log(`    ${c.cyan("q")} / ${c.cyan("ctrl+c")}        Quit`)
  console.log()
  console.log(c.yellow("  PRUNE vs DELETE"))
  console.log()
  console.log(`    ${c.bold("prune")}   Removes stale git references to worktrees whose directories`)
  console.log(`            no longer exist. Equivalent to ${c.cyan("git worktree prune")}.`)
  console.log(`            Does ${c.underline("not")} touch any actual worktree directories.`)
  console.log()
  console.log(`    ${c.bold("delete")}  Removes the worktree directory from disk and cleans up git`)
  console.log(`            tracking. Equivalent to ${c.cyan("git worktree remove <path>")}.`)
  console.log(`            Optionally also deletes the associated branch.`)
  console.log()
}
