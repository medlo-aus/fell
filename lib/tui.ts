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

// ---------------------------------------------------------------------------
// Theme detection
// ---------------------------------------------------------------------------

export type Theme = "dark" | "light"

/**
 * Detect terminal background colour.
 * Checks COLORFGBG (set by iTerm2, xterm, etc.) — format "fg;bg".
 * bg >= 8 typically means light background.
 * Falls back to FELL_THEME env var, then defaults to dark.
 */
export function detectTheme(): Theme {
  const explicit = process.env.FELL_THEME?.toLowerCase()
  if (explicit === "light") return "light"
  if (explicit === "dark") return "dark"

  const colorfgbg = process.env.COLORFGBG
  if (colorfgbg) {
    const parts = colorfgbg.split(";")
    const bg = parseInt(parts[parts.length - 1], 10)
    if (!isNaN(bg) && bg >= 8) return "light"
  }

  return "dark"
}

// ---------------------------------------------------------------------------
// Colour helpers (theme-aware, runtime-switchable)
// ---------------------------------------------------------------------------

/** 256-colour foreground. */
const fg256 = (n: number, s: string) => `${CSI}38;5;${n}m${s}${CSI}0m`
/** True-colour foreground. */
const fgRgb = (r: number, g: number, b: number, s: string) =>
  `${CSI}38;2;${r};${g};${b}m${s}${CSI}0m`

type Palette = Record<string, (s: string) => string>

const darkPalette: Palette = {
  dim: (s) => `${CSI}2m${s}${CSI}0m`,
  bold: (s) => `${CSI}1m${s}${CSI}0m`,
  italic: (s) => `${CSI}3m${s}${CSI}0m`,
  underline: (s) => `${CSI}4m${s}${CSI}0m`,
  inverse: (s) => `${CSI}7m${s}${CSI}0m`,
  cyan: (s) => `${CSI}36m${s}${CSI}0m`,
  green: (s) => `${CSI}32m${s}${CSI}0m`,
  red: (s) => `${CSI}31m${s}${CSI}0m`,
  yellow: (s) => `${CSI}33m${s}${CSI}0m`,
  magenta: (s) => `${CSI}35m${s}${CSI}0m`,
  white: (s) => `${CSI}37m${s}${CSI}0m`,
  lime: (s) => fg256(154, s),
}

const lightPalette: Palette = {
  dim: (s) => fg256(249, s),              // gray-400 — light, widens gap from hotkeys
  bold: (s) => `${CSI}1m${s}${CSI}0m`,
  italic: (s) => `${CSI}3m${s}${CSI}0m`,
  underline: (s) => `${CSI}4m${s}${CSI}0m`,
  inverse: (s) => `${CSI}7m${s}${CSI}0m`,
  cyan: (s) => fgRgb(0, 105, 135, s),     // teal-800 — vivid, high contrast vs dim
  green: (s) => fgRgb(0, 125, 25, s),     // green-800 saturated
  red: (s) => fgRgb(185, 0, 0, s),        // red-800 vivid
  yellow: (s) => fgRgb(165, 115, 0, s),   // amber-800 warm
  magenta: (s) => fgRgb(135, 0, 135, s),  // purple-800 vivid
  white: (s) => `${CSI}30m${s}${CSI}0m`,  // black on light
  lime: (s) => fgRgb(30, 130, 0, s),      // lime-800 vivid
}

/** Current theme — mutable, switched via setTheme(). */
let _theme: Theme = detectTheme()

/**
 * Colour wrappers. Stable object reference — methods are swapped
 * in-place by setTheme() so all importers see the update.
 */
export const c: Palette = { ...((_theme === "dark") ? darkPalette : lightPalette) }

/** Get current theme. */
export function getTheme(): Theme { return _theme }

/** Switch theme at runtime. Updates c in-place. */
export function setTheme(t: Theme): void {
  _theme = t
  Object.assign(c, t === "dark" ? darkPalette : lightPalette)
}

/**
 * Apply a linear gradient across a string using true-colour ANSI.
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

/** Pre-built gradient for the "fell" brand text. Theme-aware. */
export function fellLogo(): string {
  if (getTheme() === "light") {
    return gradient("fell", [0, 130, 170], [50, 140, 20])
  }
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
const orange = (s: string) =>
  getTheme() === "dark"
    ? `\x1b[38;5;208m${s}\x1b[0m`
    : fgRgb(170, 80, 0, s)

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

/** Content lines for the help overlay (without box). */
export function helpContentLines(): string[] {
  const t = getTheme()
  const themeLabel = t === "dark"
    ? `${c.bold("\u25CF dark")}  ${c.cyan("(l)")}${c.dim("ight")}`
    : `${c.cyan("(d)")}${c.dim("ark")}  ${c.bold("\u25CF light")}`

  return [
    `  ${c.bold("Shortcuts")}`,
    "",
    `  ${c.cyan("j/k")} or ${c.cyan("\u2191\u2193")}       Navigate`,
    `  ${c.cyan("space")}            Toggle selection`,
    `  ${c.cyan("a")}                Select / deselect all`,
    `  ${c.cyan("e")}                Expand / collapse details`,
    `  ${c.cyan("o")}                Open \u2192 ${c.cyan("f")} finder  ${c.cyan("c")} cursor`,
    `  ${c.cyan("c")}                Release for recycling`,
    `  ${c.cyan("d")}                Delete worktree`,
    `  ${c.cyan("p")}                Prune stale references`,
    `  ${c.cyan("r")}                Refresh`,
    `  ${c.cyan("q")} / ${c.cyan("Esc")}          Quit`,
    "",
    `  ${c.dim("Theme")} ${themeLabel}`,
    "",
    `  ${c.dim("? or Esc to close")}`,
  ]
}

/**
 * Render a bordered overlay panel centered on the screen.
 * Takes existing rendered lines and composites the overlay on top.
 * Uses Unicode box-drawing characters (┌─┐│└─┘).
 */
export function compositeOverlay(
  baseLines: string[],
  contentLines: string[],
  termRows: number,
  termCols: number,
): string[] {
  // Calculate overlay dimensions
  const contentWidth = contentLines.reduce(
    (max, line) => Math.max(max, visibleLength(line)),
    0,
  )
  const boxWidth = contentWidth + 4 // 2 padding + 2 border chars
  const boxHeight = contentLines.length + 2 // +2 for top/bottom borders

  // Center the overlay
  const startRow = Math.max(0, Math.floor((termRows - boxHeight) / 2))
  const startCol = Math.max(0, Math.floor((termCols - boxWidth) / 2))

  // Pad base lines to fill the screen
  const output = [...baseLines]
  while (output.length < termRows) output.push("")

  // Draw the box on top of base lines
  const top = `\u250C${"─".repeat(boxWidth - 2)}\u2510`
  const bot = `\u2514${"─".repeat(boxWidth - 2)}\u2518`

  // Helper: overwrite a line at row with overlay content starting at col
  function overlayLine(row: number, content: string): void {
    if (row < 0 || row >= output.length) return
    const base = output[row]
    const basePlain = stripAnsi(base)

    // Build: left part of base + overlay content + right part of base
    // For simplicity in alt screen, just pad and replace
    const leftPad = " ".repeat(startCol)
    const rightFill = " ".repeat(Math.max(0, termCols - startCol - visibleLength(content)))
    output[row] = leftPad + content + rightFill
  }

  // Top border
  overlayLine(startRow, c.dim(top))

  // Content lines inside the box
  for (let i = 0; i < contentLines.length; i++) {
    const line = contentLines[i]
    const innerPad = " ".repeat(boxWidth - 4 - visibleLength(line))
    const boxLine = `${c.dim("\u2502")} ${line}${innerPad} ${c.dim("\u2502")}`
    overlayLine(startRow + 1 + i, boxLine)
  }

  // Bottom border
  overlayLine(startRow + 1 + contentLines.length, c.dim(bot))

  return output
}

/** @deprecated Use helpContentLines() + compositeOverlay() instead. */
export function renderHelpLines(): string[] {
  return ["", ...helpContentLines()]
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
  console.log(`    ${c.dim("$")} fell                          ${c.dim("Interactive mode (default)")}`)
  console.log(`    ${c.dim("$")} fell ${c.cyan("--list")}                   ${c.dim("Print worktrees and exit")}`)
  console.log(`    ${c.dim("$")} fell ${c.cyan("--recycle")} ${c.dim("<branch>")}         ${c.dim("Recycle a worktree for a new branch")}`)
  console.log(`    ${c.dim("$")} fell ${c.cyan("--recycle")} ${c.dim("<branch>")} ${c.cyan("--slot")} ${c.dim("<path>")}  ${c.dim("Recycle a specific worktree")}`)
  console.log(`    ${c.dim("$")} fell ${c.cyan("--help")}                   ${c.dim("Show this help")}`)
  console.log()
  console.log(c.yellow("  INTERACTIVE COMMANDS"))
  console.log()
  console.log(`    ${c.cyan("up/down")} or ${c.cyan("k/j")}   Navigate worktree list`)
  console.log(`    ${c.cyan("space")}             Toggle selection`)
  console.log(`    ${c.cyan("a")}                 Select / deselect all`)
  console.log(`    ${c.cyan("e")}                 Expand / collapse file list`)
  console.log(`    ${c.cyan("o")}                 Open worktree \u2192 ${c.cyan("f")} finder  ${c.cyan("c")} cursor`)
  console.log(`    ${c.cyan("c")}                 Release worktree(s) for recycling (detach HEAD)`)
  console.log(`    ${c.cyan("d")}                 Delete worktree(s) + optionally branches`)
  console.log(`    ${c.cyan("p")}                 Prune stale references`)
  console.log(`    ${c.cyan("r")}                 Refresh list + PR statuses`)
  console.log(`    ${c.cyan("?")}                 In-app help (terminology explained)`)
  console.log(`    ${c.cyan("q")} / ${c.cyan("ctrl+c")}        Quit`)
  console.log()
  console.log(c.yellow("  TERMINOLOGY"))
  console.log()
  console.log(`    ${c.bold("release")} Detaches HEAD from a worktree without deleting the directory.`)
  console.log(`            The worktree becomes an empty slot with deps intact, ready`)
  console.log(`            to be recycled for a new branch via ${c.cyan("fell --recycle <branch>")}.`)
  console.log()
  console.log(`    ${c.bold("delete")}  Removes the worktree directory from disk and cleans up git`)
  console.log(`            tracking. Equivalent to ${c.cyan("git worktree remove <path>")}.`)
  console.log(`            Optionally also deletes the associated branch.`)
  console.log()
  console.log(`    ${c.bold("prune")}   Removes stale git references to worktrees whose directories`)
  console.log(`            no longer exist. Equivalent to ${c.cyan("git worktree prune")}.`)
  console.log(`            Does ${c.underline("not")} touch any actual worktree directories.`)
  console.log()
}
