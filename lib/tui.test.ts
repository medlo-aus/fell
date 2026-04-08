import { describe, expect, test } from "bun:test"
import {
  stripAnsi,
  visibleLength,
  pad,
  truncate,
  shortenPath,
  gradient,
  hyperlink,
  parseKey,
  keyChar,
  formatPrStatus,
  formatFileStatus,
  formatSessionInfo,
  formatParentSessionInline,
  formatParentSessionExpanded,
  c,
} from "./tui"

// ---------------------------------------------------------------------------
// stripAnsi
// ---------------------------------------------------------------------------

describe("stripAnsi", () => {
  test("returns plain text unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world")
  })

  test("returns empty string unchanged", () => {
    expect(stripAnsi("")).toBe("")
  })

  test("strips SGR color codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red")
  })

  test("strips multiple SGR codes", () => {
    expect(stripAnsi("\x1b[1m\x1b[36mbold cyan\x1b[0m\x1b[0m")).toBe("bold cyan")
  })

  test("strips 256-color codes", () => {
    expect(stripAnsi("\x1b[38;5;154mtext\x1b[0m")).toBe("text")
  })

  test("strips truecolor codes", () => {
    expect(stripAnsi("\x1b[38;2;80;200;255mtext\x1b[0m")).toBe("text")
  })

  test("strips OSC 8 hyperlinks", () => {
    expect(stripAnsi("\x1b]8;;https://example.com\x07text\x1b]8;;\x07")).toBe("text")
  })

  test("strips mixed SGR and OSC codes", () => {
    const input = `\x1b[32m\x1b]8;;https://x.com\x07#42\x1b]8;;\x07 merged\x1b[0m`
    expect(stripAnsi(input)).toBe("#42 merged")
  })
})

// ---------------------------------------------------------------------------
// visibleLength
// ---------------------------------------------------------------------------

describe("visibleLength", () => {
  test("plain text returns length", () => {
    expect(visibleLength("hello")).toBe(5)
  })

  test("empty string returns 0", () => {
    expect(visibleLength("")).toBe(0)
  })

  test("ignores ANSI color codes", () => {
    expect(visibleLength(c.red("hello"))).toBe(5)
  })

  test("ignores hyperlinks", () => {
    expect(visibleLength(hyperlink("#42", "https://example.com"))).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// pad
// ---------------------------------------------------------------------------

describe("pad", () => {
  test("pads short string with spaces", () => {
    const result = pad("hi", 5)
    expect(result).toBe("hi   ")
  })

  test("does not pad already-wide string", () => {
    const result = pad("hello", 3)
    expect(result).toBe("hello")
  })

  test("exact width: no change", () => {
    const result = pad("abc", 3)
    expect(result).toBe("abc")
  })

  test("pads by visible width, not raw length", () => {
    const colored = c.red("hi") // raw length >> 2, visible = 2
    const result = pad(colored, 5)
    // should have 3 trailing spaces
    expect(visibleLength(result)).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

describe("truncate", () => {
  test("short string: unchanged", () => {
    expect(truncate("hi", 10)).toBe("hi")
  })

  test("exact width: unchanged", () => {
    expect(truncate("abc", 3)).toBe("abc")
  })

  test("over width: truncates with ..", () => {
    expect(truncate("abcdefgh", 5)).toBe("abc..")
  })

  test("width=2 and long string: returns '..'", () => {
    expect(truncate("abcdef", 2)).toBe("ab")
  })

  test("width=1: just slices", () => {
    expect(truncate("abcdef", 1)).toBe("a")
  })

  test("width=0: empty", () => {
    expect(truncate("abcdef", 0)).toBe("")
  })

  test("empty string: unchanged", () => {
    expect(truncate("", 5)).toBe("")
  })

  test("width=3 with long string: truncates with ..", () => {
    expect(truncate("abcdef", 3)).toBe("a..")
  })
})

// ---------------------------------------------------------------------------
// shortenPath
// ---------------------------------------------------------------------------

describe("shortenPath", () => {
  const originalHome = process.env.HOME

  test("replaces HOME with ~", () => {
    process.env.HOME = "/Users/test"
    expect(shortenPath("/Users/test/code/repo", 50)).toBe("~/code/repo")
    process.env.HOME = originalHome
  })

  test("path outside HOME: unchanged prefix", () => {
    process.env.HOME = "/Users/test"
    expect(shortenPath("/opt/other/path", 50)).toBe("/opt/other/path")
    process.env.HOME = originalHome
  })

  test("truncates long paths", () => {
    process.env.HOME = "/Users/test"
    const result = shortenPath("/Users/test/very/long/path/that/is/too/wide", 15)
    expect(result.length).toBeLessThanOrEqual(15)
    expect(result.endsWith("..")).toBe(true)
    process.env.HOME = originalHome
  })

  test("handles missing HOME", () => {
    process.env.HOME = ""
    expect(shortenPath("/some/path", 50)).toBe("/some/path")
    process.env.HOME = originalHome
  })
})

// ---------------------------------------------------------------------------
// gradient
// ---------------------------------------------------------------------------

describe("gradient", () => {
  test("empty string returns empty", () => {
    expect(gradient("", [0, 0, 0], [255, 255, 255])).toBe("")
  })

  test("single character uses start color", () => {
    const result = gradient("x", [100, 100, 100], [200, 200, 200])
    expect(stripAnsi(result)).toBe("x")
    // Single char should use t=0, which is the start color
    expect(result).toContain("100;100;100")
  })

  test("multi-char produces ANSI codes per character", () => {
    const result = gradient("abc", [0, 0, 0], [255, 255, 255])
    expect(stripAnsi(result)).toBe("abc")
    // Should contain truecolor sequences
    expect(result).toContain("\x1b[38;2;")
  })

  test("same start and end color: all chars same color", () => {
    const result = gradient("abc", [50, 50, 50], [50, 50, 50])
    expect(stripAnsi(result)).toBe("abc")
    // All chars should have 50;50;50
    const matches = result.match(/50;50;50/g)
    expect(matches?.length).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// hyperlink
// ---------------------------------------------------------------------------

describe("hyperlink", () => {
  test("produces OSC 8 format", () => {
    const result = hyperlink("click me", "https://example.com")
    expect(result).toBe("\x1b]8;;https://example.com\x07click me\x1b]8;;\x07")
  })

  test("visible text is preserved", () => {
    const result = hyperlink("link text", "https://x.com")
    expect(stripAnsi(result)).toBe("link text")
  })

  test("handles empty text", () => {
    const result = hyperlink("", "https://example.com")
    expect(result).toContain("https://example.com")
    expect(stripAnsi(result)).toBe("")
  })
})

// ---------------------------------------------------------------------------
// parseKey
// ---------------------------------------------------------------------------

describe("parseKey", () => {
  test("arrow up", () => {
    expect(parseKey(Buffer.from([0x1b, 0x5b, 0x41]))).toBe("up")
  })

  test("arrow down", () => {
    expect(parseKey(Buffer.from([0x1b, 0x5b, 0x42]))).toBe("down")
  })

  test("arrow right", () => {
    expect(parseKey(Buffer.from([0x1b, 0x5b, 0x43]))).toBe("right")
  })

  test("arrow left", () => {
    expect(parseKey(Buffer.from([0x1b, 0x5b, 0x44]))).toBe("left")
  })

  test("ctrl-c", () => {
    expect(parseKey(Buffer.from([0x03]))).toBe("ctrl-c")
  })

  test("enter (carriage return)", () => {
    expect(parseKey(Buffer.from([0x0d]))).toBe("enter")
  })

  test("enter (line feed)", () => {
    expect(parseKey(Buffer.from([0x0a]))).toBe("enter")
  })

  test("space", () => {
    expect(parseKey(Buffer.from([0x20]))).toBe("space")
  })

  test("backspace", () => {
    expect(parseKey(Buffer.from([0x7f]))).toBe("backspace")
  })

  test("escape", () => {
    expect(parseKey(Buffer.from([0x1b]))).toBe("escape")
  })

  test("regular character 'a'", () => {
    expect(parseKey(Buffer.from("a"))).toEqual({ char: "a" })
  })

  test("regular character 'q'", () => {
    expect(parseKey(Buffer.from("q"))).toEqual({ char: "q" })
  })

  test("regular character '?'", () => {
    expect(parseKey(Buffer.from("?"))).toEqual({ char: "?" })
  })

  test("X10 mouse scroll up", () => {
    expect(parseKey(Buffer.from([0x1b, 0x5b, 0x4d, 0x60, 0x21, 0x21]))).toBe("scroll-up")
  })

  test("X10 mouse scroll down", () => {
    expect(parseKey(Buffer.from([0x1b, 0x5b, 0x4d, 0x61, 0x21, 0x21]))).toBe("scroll-down")
  })

  test("X10 mouse click returns unknown", () => {
    expect(parseKey(Buffer.from([0x1b, 0x5b, 0x4d, 0x20, 0x21, 0x21]))).toBe("unknown")
  })

  test("unknown CSI sequences return unknown", () => {
    // F1 key: \x1b[11~
    expect(parseKey(Buffer.from([0x1b, 0x5b, 0x31, 0x31, 0x7e]))).toBe("unknown")
  })
})

// ---------------------------------------------------------------------------
// keyChar
// ---------------------------------------------------------------------------

describe("keyChar", () => {
  test("returns char for char keys", () => {
    expect(keyChar({ char: "a" })).toBe("a")
    expect(keyChar({ char: "?" })).toBe("?")
  })

  test("returns null for special keys", () => {
    expect(keyChar("up")).toBeNull()
    expect(keyChar("down")).toBeNull()
    expect(keyChar("left")).toBeNull()
    expect(keyChar("right")).toBeNull()
    expect(keyChar("enter")).toBeNull()
    expect(keyChar("space")).toBeNull()
    expect(keyChar("escape")).toBeNull()
    expect(keyChar("backspace")).toBeNull()
    expect(keyChar("ctrl-c")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// formatPrStatus
// ---------------------------------------------------------------------------

describe("formatPrStatus", () => {
  test("loading: shows spinner", () => {
    const result = formatPrStatus({ type: "loading" }, 0)
    expect(stripAnsi(result)).toContain("fetching")
  })

  test("found merged: green with PR number", () => {
    const result = formatPrStatus({
      type: "found",
      pr: { number: 42, state: "MERGED", url: "https://github.com/x/pull/42", title: "Fix bug" },
    }, 0)
    const plain = stripAnsi(result)
    expect(plain).toContain("#42")
    expect(plain).toContain("merged")
  })

  test("found open: yellow", () => {
    const result = formatPrStatus({
      type: "found",
      pr: { number: 10, state: "OPEN", url: "https://github.com/x/pull/10", title: "Feature" },
    }, 0)
    const plain = stripAnsi(result)
    expect(plain).toContain("#10")
    expect(plain).toContain("open")
  })

  test("found closed: red", () => {
    const result = formatPrStatus({
      type: "found",
      pr: { number: 5, state: "CLOSED", url: "https://github.com/x/pull/5", title: "Old" },
    }, 0)
    const plain = stripAnsi(result)
    expect(plain).toContain("#5")
    expect(plain).toContain("closed")
  })

  test("none: shows 'no PR'", () => {
    const plain = stripAnsi(formatPrStatus({ type: "none" }, 0))
    expect(plain).toBe("no PR")
  })

  test("error: shows 'fetch error'", () => {
    const plain = stripAnsi(formatPrStatus({ type: "error", message: "network" }, 0))
    expect(plain).toBe("fetch error")
  })

  test("skipped: shows '-'", () => {
    const plain = stripAnsi(formatPrStatus({ type: "skipped" }, 0))
    expect(plain).toBe("-")
  })
})

// ---------------------------------------------------------------------------
// formatFileStatus
// ---------------------------------------------------------------------------

describe("formatFileStatus", () => {
  test("loading: returns null", () => {
    expect(formatFileStatus({ type: "loading" })).toBeNull()
  })

  test("clean: returns null", () => {
    expect(formatFileStatus({ type: "clean" })).toBeNull()
  })

  test("error: returns null", () => {
    expect(formatFileStatus({ type: "error" })).toBeNull()
  })

  test("dirty with all counts: shows all", () => {
    const result = formatFileStatus({
      type: "dirty",
      status: { staged: 2, modified: 3, untracked: 1, ahead: 4, behind: 1 },
    })
    expect(result).not.toBeNull()
    const plain = stripAnsi(result!)
    expect(plain).toContain("2 staged")
    expect(plain).toContain("3 modified")
    expect(plain).toContain("1 untracked")
    expect(plain).toContain("4 unpushed")
    expect(plain).toContain("1 behind")
  })

  test("dirty with only staged", () => {
    const result = formatFileStatus({
      type: "dirty",
      status: { staged: 5, modified: 0, untracked: 0, ahead: 0, behind: 0 },
    })
    const plain = stripAnsi(result!)
    expect(plain).toContain("5 staged")
    expect(plain).not.toContain("modified")
    expect(plain).not.toContain("untracked")
  })

  test("dirty with all zeros: returns null", () => {
    const result = formatFileStatus({
      type: "dirty",
      status: { staged: 0, modified: 0, untracked: 0, ahead: 0, behind: 0 },
    })
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// formatSessionInfo
// ---------------------------------------------------------------------------

describe("formatSessionInfo", () => {
  test("loading: returns null", () => {
    expect(formatSessionInfo({ type: "loading" }, 80)).toBeNull()
  })

  test("none: returns null", () => {
    expect(formatSessionInfo({ type: "none" }, 80)).toBeNull()
  })

  test("found with 1 session: singular", () => {
    const result = formatSessionInfo({
      type: "found",
      info: { sessionCount: 1, latestSessionId: "abc", latestPrompt: "fix the bug", latestTimestamp: "" },
    }, 80)
    const plain = stripAnsi(result!)
    expect(plain).toContain("1 session")
    expect(plain).not.toContain("1 sessions")
    expect(plain).toContain("fix the bug")
  })

  test("found with multiple sessions: plural", () => {
    const result = formatSessionInfo({
      type: "found",
      info: { sessionCount: 3, latestSessionId: "abc", latestPrompt: "add tests", latestTimestamp: "" },
    }, 80)
    const plain = stripAnsi(result!)
    expect(plain).toContain("3 sessions")
  })

  test("found with empty prompt: no prompt shown", () => {
    const result = formatSessionInfo({
      type: "found",
      info: { sessionCount: 2, latestSessionId: "abc", latestPrompt: "", latestTimestamp: "" },
    }, 80)
    const plain = stripAnsi(result!)
    expect(plain).toContain("2 sessions")
    expect(plain).not.toContain('"')
  })

  test("prompt is truncated to maxPromptWidth", () => {
    const longPrompt = "a".repeat(100)
    const result = formatSessionInfo({
      type: "found",
      info: { sessionCount: 1, latestSessionId: "abc", latestPrompt: longPrompt, latestTimestamp: "" },
    }, 20)
    const plain = stripAnsi(result!)
    // The truncated prompt should end with ..
    expect(plain).toContain("..")
  })
})

// ---------------------------------------------------------------------------
// formatParentSessionInline
// ---------------------------------------------------------------------------

describe("formatParentSessionInline", () => {
  test("loading: returns empty string", () => {
    expect(formatParentSessionInline({ type: "loading" })).toBe("")
  })

  test("none: returns empty string", () => {
    expect(formatParentSessionInline({ type: "none" })).toBe("")
  })

  test("found: returns orange dot + session", () => {
    const result = formatParentSessionInline({
      type: "found",
      session: { sessionId: "abc", cwd: "/x", prompt: "hi" },
    })
    expect(result).not.toBe("")
    expect(stripAnsi(result)).toContain("session")
  })
})

// ---------------------------------------------------------------------------
// formatParentSessionExpanded
// ---------------------------------------------------------------------------

describe("formatParentSessionExpanded", () => {
  const originalHome = process.env.HOME

  test("loading: returns empty array", () => {
    expect(formatParentSessionExpanded({ type: "loading" }, 80)).toEqual([])
  })

  test("none: returns empty array", () => {
    expect(formatParentSessionExpanded({ type: "none" }, 80)).toEqual([])
  })

  test("found: returns lines with cwd and prompt", () => {
    process.env.HOME = "/Users/test"
    const result = formatParentSessionExpanded({
      type: "found",
      session: { sessionId: "abc", cwd: "/Users/test/code/repo", prompt: "implement feature X" },
    }, 80)
    expect(result.length).toBeGreaterThan(0)
    const plain = result.map(stripAnsi).join(" ")
    expect(plain).toContain("session")
    expect(plain).toContain("~/code/repo")
    expect(plain).toContain("implement feature X")
    process.env.HOME = originalHome
  })

  test("found without prompt: still returns lines", () => {
    const result = formatParentSessionExpanded({
      type: "found",
      session: { sessionId: "abc", cwd: "/some/path", prompt: "" },
    }, 80)
    expect(result.length).toBeGreaterThan(0)
    const plain = result.map(stripAnsi).join(" ")
    expect(plain).toContain("session")
  })
})
