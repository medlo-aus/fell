import { describe, expect, test, afterEach } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  parseWorktreeListOutput,
  parseFileStatusOutput,
  parseFileListOutput,
  parsePrListOutput,
  parseDuOutput,
  parsePruneOutput,
  encodeClaudeProjectPath,
  extractFirstPrompt,
  extractCwd,
  formatBytes,
} from "./git"

// ---------------------------------------------------------------------------
// parseWorktreeListOutput
// ---------------------------------------------------------------------------

describe("parseWorktreeListOutput", () => {
  test("parses single main worktree", () => {
    const output = `worktree /Users/x/repo\nHEAD abc1234def5678\nbranch refs/heads/main\n`
    const result = parseWorktreeListOutput(output)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      path: "/Users/x/repo",
      head: "abc1234def5678",
      branch: "main",
      isMain: true,
      isBare: false,
      isLocked: false,
      isDetached: false,
      isPrunable: false,
    })
  })

  test("parses multiple worktrees", () => {
    const output = [
      "worktree /Users/x/repo",
      "HEAD aaa1111",
      "branch refs/heads/main",
      "",
      "worktree /Users/x/repo/.worktrees/feature-a",
      "HEAD bbb2222",
      "branch refs/heads/feature-a",
      "",
      "worktree /Users/x/repo/.worktrees/feature-b",
      "HEAD ccc3333",
      "branch refs/heads/feature-b",
    ].join("\n")

    const result = parseWorktreeListOutput(output)
    expect(result).toHaveLength(3)
    expect(result[0].isMain).toBe(true)
    expect(result[1].isMain).toBe(false)
    expect(result[1].branch).toBe("feature-a")
    expect(result[2].branch).toBe("feature-b")
  })

  test("parses detached HEAD", () => {
    const output = [
      "worktree /Users/x/repo",
      "HEAD aaa1111",
      "branch refs/heads/main",
      "",
      "worktree /Users/x/repo/.worktrees/detached",
      "HEAD ddd4444",
      "detached",
    ].join("\n")

    const result = parseWorktreeListOutput(output)
    expect(result[1].isDetached).toBe(true)
    expect(result[1].branch).toBeNull()
  })

  test("parses locked worktree without reason", () => {
    const output = [
      "worktree /Users/x/repo",
      "HEAD aaa1111",
      "branch refs/heads/main",
      "",
      "worktree /Users/x/repo/.worktrees/locked-one",
      "HEAD eee5555",
      "branch refs/heads/locked-one",
      "locked",
    ].join("\n")

    const result = parseWorktreeListOutput(output)
    expect(result[1].isLocked).toBe(true)
    expect(result[1].lockReason).toBeNull()
  })

  test("parses locked worktree with reason", () => {
    const output = [
      "worktree /Users/x/repo",
      "HEAD aaa1111",
      "branch refs/heads/main",
      "",
      "worktree /Users/x/repo/.worktrees/locked-one",
      "HEAD eee5555",
      "branch refs/heads/locked-one",
      "locked important work in progress",
    ].join("\n")

    const result = parseWorktreeListOutput(output)
    expect(result[1].isLocked).toBe(true)
    expect(result[1].lockReason).toBe("important work in progress")
  })

  test("parses prunable worktree without reason", () => {
    const output = [
      "worktree /Users/x/repo",
      "HEAD aaa1111",
      "branch refs/heads/main",
      "",
      "worktree /Users/x/repo/.worktrees/gone",
      "HEAD fff6666",
      "branch refs/heads/gone",
      "prunable",
    ].join("\n")

    const result = parseWorktreeListOutput(output)
    expect(result[1].isPrunable).toBe(true)
    expect(result[1].prunableReason).toBeNull()
  })

  test("parses prunable worktree with reason", () => {
    const output = [
      "worktree /Users/x/repo",
      "HEAD aaa1111",
      "branch refs/heads/main",
      "",
      "worktree /Users/x/repo/.worktrees/gone",
      "HEAD fff6666",
      "branch refs/heads/gone",
      "prunable gitdir file points to non-existent location",
    ].join("\n")

    const result = parseWorktreeListOutput(output)
    expect(result[1].isPrunable).toBe(true)
    expect(result[1].prunableReason).toBe("gitdir file points to non-existent location")
  })

  test("parses bare repository", () => {
    const output = "worktree /Users/x/repo.git\nHEAD aaa1111\nbare\n"
    const result = parseWorktreeListOutput(output)
    expect(result[0].isBare).toBe(true)
  })

  test("empty output returns empty array", () => {
    expect(parseWorktreeListOutput("")).toEqual([])
  })

  test("strips refs/heads/ prefix from branch names", () => {
    const output = "worktree /x\nHEAD abc\nbranch refs/heads/feature/JIRA-123-thing\n"
    const result = parseWorktreeListOutput(output)
    expect(result[0].branch).toBe("feature/JIRA-123-thing")
  })
})

// ---------------------------------------------------------------------------
// parseFileStatusOutput
// ---------------------------------------------------------------------------

describe("parseFileStatusOutput", () => {
  test("clean repo: returns clean", () => {
    const output = "# branch.oid abc123\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n"
    expect(parseFileStatusOutput(output)).toEqual({ type: "clean" })
  })

  test("empty output: returns clean", () => {
    expect(parseFileStatusOutput("")).toEqual({ type: "clean" })
  })

  test("staged files counted", () => {
    const output = "1 A. N... 000000 100644 100644 0000000 abc1234 file.txt\n"
    const result = parseFileStatusOutput(output)
    expect(result).toEqual({
      type: "dirty",
      status: { staged: 1, modified: 0, untracked: 0, ahead: 0, behind: 0 },
    })
  })

  test("modified files counted", () => {
    const output = "1 .M N... 100644 100644 100644 abc1234 def5678 file.txt\n"
    const result = parseFileStatusOutput(output)
    expect(result).toEqual({
      type: "dirty",
      status: { staged: 0, modified: 1, untracked: 0, ahead: 0, behind: 0 },
    })
  })

  test("staged AND modified in same entry counted separately", () => {
    // XY = "MM" -> both staged and modified
    const output = "1 MM N... 100644 100644 100644 abc1234 def5678 file.txt\n"
    const result = parseFileStatusOutput(output)
    expect(result).toEqual({
      type: "dirty",
      status: { staged: 1, modified: 1, untracked: 0, ahead: 0, behind: 0 },
    })
  })

  test("untracked files counted", () => {
    const output = "? newfile.txt\n? another.txt\n"
    const result = parseFileStatusOutput(output)
    expect(result).toEqual({
      type: "dirty",
      status: { staged: 0, modified: 0, untracked: 2, ahead: 0, behind: 0 },
    })
  })

  test("unmerged entries counted as modified", () => {
    const output = "u UU N... 100644 100644 100644 100644 abc1234 def5678 ghi9012 file.txt\n"
    const result = parseFileStatusOutput(output)
    expect(result).toEqual({
      type: "dirty",
      status: { staged: 0, modified: 1, untracked: 0, ahead: 0, behind: 0 },
    })
  })

  test("ahead/behind parsed from branch.ab", () => {
    const output = "# branch.ab +3 -2\n"
    const result = parseFileStatusOutput(output)
    expect(result).toEqual({
      type: "dirty",
      status: { staged: 0, modified: 0, untracked: 0, ahead: 3, behind: 2 },
    })
  })

  test("rename entries counted", () => {
    // "2 " prefix for renames, XY = "R."
    const output = "2 R. N... 100644 100644 100644 abc1234 def5678 R100\told.txt\tnew.txt\n"
    const result = parseFileStatusOutput(output)
    expect(result).toEqual({
      type: "dirty",
      status: { staged: 1, modified: 0, untracked: 0, ahead: 0, behind: 0 },
    })
  })

  test("mixed status", () => {
    const output = [
      "# branch.ab +1 -0",
      "1 A. N... 000000 100644 100644 0000000 abc1234 new.txt",
      "1 .M N... 100644 100644 100644 abc1234 def5678 changed.txt",
      "? untracked.txt",
    ].join("\n")
    const result = parseFileStatusOutput(output)
    expect(result).toEqual({
      type: "dirty",
      status: { staged: 1, modified: 1, untracked: 1, ahead: 1, behind: 0 },
    })
  })
})

// ---------------------------------------------------------------------------
// parseFileListOutput
// ---------------------------------------------------------------------------

describe("parseFileListOutput", () => {
  test("empty output: returns empty array", () => {
    expect(parseFileListOutput("")).toEqual([])
  })

  test("ordinary staged entry", () => {
    const output = "1 A. N... 000000 100644 100644 0000000 abc1234 src/new.ts\n"
    const result = parseFileListOutput(output)
    expect(result).toEqual([{ path: "src/new.ts", status: "staged" }])
  })

  test("ordinary modified entry", () => {
    const output = "1 .M N... 100644 100644 100644 abc1234 def5678 src/changed.ts\n"
    const result = parseFileListOutput(output)
    expect(result).toEqual([{ path: "src/changed.ts", status: "modified" }])
  })

  test("rename entry extracts current path", () => {
    // porcelain v2 format: "2 XY ... Xscore\t<current-path>\t<original-path>"
    const output = "2 R. N... 100644 100644 100644 abc1234 def5678 R100\trenamed.txt\toriginal.txt\n"
    const result = parseFileListOutput(output)
    expect(result).toEqual([{ path: "renamed.txt", status: "staged" }])
  })

  test("untracked entry", () => {
    const output = "? path/to/file.txt\n"
    const result = parseFileListOutput(output)
    expect(result).toEqual([{ path: "path/to/file.txt", status: "untracked" }])
  })

  test("unmerged entry", () => {
    const output = "u UU N... 100644 100644 100644 100644 abc1234 def5678 ghi9012 conflict.txt\n"
    const result = parseFileListOutput(output)
    expect(result).toEqual([{ path: "conflict.txt", status: "unmerged" }])
  })

  test("mixed entries", () => {
    const output = [
      "1 A. N... 000000 100644 100644 0000000 abc1234 added.ts",
      "1 .M N... 100644 100644 100644 abc1234 def5678 modified.ts",
      "? untracked.ts",
    ].join("\n")
    const result = parseFileListOutput(output)
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({ path: "added.ts", status: "staged" })
    expect(result[1]).toEqual({ path: "modified.ts", status: "modified" })
    expect(result[2]).toEqual({ path: "untracked.ts", status: "untracked" })
  })

  test("branch header lines are skipped", () => {
    const output = [
      "# branch.oid abc123",
      "# branch.head main",
      "1 A. N... 000000 100644 100644 0000000 abc1234 file.ts",
    ].join("\n")
    const result = parseFileListOutput(output)
    expect(result).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// parsePrListOutput
// ---------------------------------------------------------------------------

describe("parsePrListOutput", () => {
  test("empty array: returns null", () => {
    expect(parsePrListOutput("[]")).toBeNull()
  })

  test("invalid JSON: returns null", () => {
    expect(parsePrListOutput("not json")).toBeNull()
  })

  test("single PR: returns it", () => {
    const json = JSON.stringify([
      { number: 42, state: "MERGED", url: "https://github.com/x/pull/42", title: "Fix bug" },
    ])
    const result = parsePrListOutput(json)
    expect(result).toEqual({
      number: 42,
      state: "MERGED",
      url: "https://github.com/x/pull/42",
      title: "Fix bug",
    })
  })

  test("multiple PRs: returns highest number", () => {
    const json = JSON.stringify([
      { number: 10, state: "CLOSED", url: "https://github.com/x/pull/10", title: "Old" },
      { number: 42, state: "OPEN", url: "https://github.com/x/pull/42", title: "New" },
      { number: 20, state: "MERGED", url: "https://github.com/x/pull/20", title: "Mid" },
    ])
    const result = parsePrListOutput(json)
    expect(result!.number).toBe(42)
    expect(result!.state).toBe("OPEN")
  })
})

// ---------------------------------------------------------------------------
// parseDuOutput
// ---------------------------------------------------------------------------

describe("parseDuOutput", () => {
  test("valid output: returns bytes", () => {
    const result = parseDuOutput("1024\t/some/path\n")
    expect(result).toEqual({ type: "done", bytes: 1024 * 1024 })
  })

  test("large directory", () => {
    const result = parseDuOutput("5242880\t/big/dir\n")
    expect(result).toEqual({ type: "done", bytes: 5242880 * 1024 })
  })

  test("invalid output: returns error", () => {
    expect(parseDuOutput("not a number")).toEqual({ type: "error" })
  })

  test("empty output: returns error", () => {
    expect(parseDuOutput("")).toEqual({ type: "error" })
  })
})

// ---------------------------------------------------------------------------
// parsePruneOutput
// ---------------------------------------------------------------------------

describe("parsePruneOutput", () => {
  test("empty output: returns empty array", () => {
    expect(parsePruneOutput("")).toEqual([])
  })

  test("whitespace only: returns empty array", () => {
    expect(parsePruneOutput("  \n  \n")).toEqual([])
  })

  test("multiple lines: returns each", () => {
    const output = "Removing worktrees/foo: gitdir file missing\nRemoving worktrees/bar: not valid"
    const result = parsePruneOutput(output)
    expect(result).toHaveLength(2)
    expect(result[0]).toContain("foo")
    expect(result[1]).toContain("bar")
  })
})

// ---------------------------------------------------------------------------
// encodeClaudeProjectPath
// ---------------------------------------------------------------------------

describe("encodeClaudeProjectPath", () => {
  test("replaces slashes with dashes", () => {
    expect(encodeClaudeProjectPath("/Users/x/code")).toBe("-Users-x-code")
  })

  test("replaces dots with dashes", () => {
    expect(encodeClaudeProjectPath("/Users/x/.claude")).toBe("-Users-x--claude")
  })

  test("preserves alphanumeric characters", () => {
    expect(encodeClaudeProjectPath("abc123")).toBe("abc123")
  })

  test("replaces spaces with dashes", () => {
    expect(encodeClaudeProjectPath("/path/with spaces/dir")).toBe("-path-with-spaces-dir")
  })

  test("handles typical worktree path", () => {
    const result = encodeClaudeProjectPath("/Users/x/code/fell/.worktrees/session-column")
    expect(result).toBe("-Users-x-code-fell--worktrees-session-column")
  })
})

// ---------------------------------------------------------------------------
// formatBytes
// ---------------------------------------------------------------------------

describe("formatBytes", () => {
  test("bytes range", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(1023)).toBe("1023 B")
  })

  test("KB range", () => {
    expect(formatBytes(1024)).toBe("1 KB")
    expect(formatBytes(1024 * 512)).toBe("512 KB")
  })

  test("MB range", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB")
    expect(formatBytes(1024 * 1024 * 5.5)).toBe("5.5 MB")
  })

  test("GB range", () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB")
    expect(formatBytes(1024 * 1024 * 1024 * 2.3)).toBe("2.3 GB")
  })
})

// ---------------------------------------------------------------------------
// extractFirstPrompt (file I/O — uses temp files)
// ---------------------------------------------------------------------------

describe("extractFirstPrompt", () => {
  let tempDir: string

  const setup = async () => {
    tempDir = await mkdtemp(join(tmpdir(), "fell-test-"))
  }

  const cleanup = async () => {
    await rm(tempDir, { recursive: true, force: true })
  }

  test("extracts user prompt from valid JSONL", async () => {
    await setup()
    const file = join(tempDir, "session.jsonl")
    const lines = [
      JSON.stringify({ type: "system", message: { content: "system prompt" }, timestamp: "2024-01-01" }),
      JSON.stringify({ type: "user", message: { content: "fix the login bug" }, timestamp: "2024-01-02" }),
    ].join("\n")
    await Bun.write(file, lines)

    const result = await extractFirstPrompt(file)
    expect(result).toEqual({ prompt: "fix the login bug", timestamp: "2024-01-02" })
    await cleanup()
  })

  test("handles array content blocks", async () => {
    await setup()
    const file = join(tempDir, "session.jsonl")
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "text", text: "implement authentication" },
        ],
      },
      timestamp: "2024-01-01",
    })
    await Bun.write(file, line)

    const result = await extractFirstPrompt(file)
    expect(result?.prompt).toBe("implement authentication")
    await cleanup()
  })

  test("strips XML-like tags", async () => {
    await setup()
    const file = join(tempDir, "session.jsonl")
    const line = JSON.stringify({
      type: "user",
      message: { content: "<local-command-caveat>info</local-command-caveat> actual prompt here" },
      timestamp: "2024-01-01",
    })
    await Bun.write(file, line)

    const result = await extractFirstPrompt(file)
    expect(result?.prompt).toBe("actual prompt here")
    await cleanup()
  })

  test("skips entries that are purely XML tags", async () => {
    await setup()
    const file = join(tempDir, "session.jsonl")
    const lines = [
      JSON.stringify({ type: "user", message: { content: "<tag>content</tag>" }, timestamp: "2024-01-01" }),
      JSON.stringify({ type: "user", message: { content: "real prompt" }, timestamp: "2024-01-02" }),
    ].join("\n")
    await Bun.write(file, lines)

    const result = await extractFirstPrompt(file)
    expect(result?.prompt).toBe("real prompt")
    await cleanup()
  })

  test("collapses whitespace", async () => {
    await setup()
    const file = join(tempDir, "session.jsonl")
    const line = JSON.stringify({
      type: "user",
      message: { content: "fix\n  the\n  bug\n  please" },
      timestamp: "2024-01-01",
    })
    await Bun.write(file, line)

    const result = await extractFirstPrompt(file)
    expect(result?.prompt).toBe("fix the bug please")
    await cleanup()
  })

  test("returns null for file not found", async () => {
    const result = await extractFirstPrompt("/nonexistent/path/file.jsonl")
    expect(result).toBeNull()
  })

  test("returns null for empty file", async () => {
    await setup()
    const file = join(tempDir, "empty.jsonl")
    await Bun.write(file, "")

    const result = await extractFirstPrompt(file)
    expect(result).toBeNull()
    await cleanup()
  })

  test("skips malformed JSON lines", async () => {
    await setup()
    const file = join(tempDir, "session.jsonl")
    const lines = [
      "not valid json",
      JSON.stringify({ type: "user", message: { content: "good prompt" }, timestamp: "2024-01-01" }),
    ].join("\n")
    await Bun.write(file, lines)

    const result = await extractFirstPrompt(file)
    expect(result?.prompt).toBe("good prompt")
    await cleanup()
  })
})

// ---------------------------------------------------------------------------
// extractCwd (file I/O — uses temp files)
// ---------------------------------------------------------------------------

describe("extractCwd", () => {
  let tempDir: string

  const setup = async () => {
    tempDir = await mkdtemp(join(tmpdir(), "fell-test-"))
  }

  const cleanup = async () => {
    await rm(tempDir, { recursive: true, force: true })
  }

  test("extracts cwd from JSONL", async () => {
    await setup()
    const file = join(tempDir, "session.jsonl")
    const line = JSON.stringify({ type: "system", cwd: "/Users/x/code/repo" })
    await Bun.write(file, line)

    const result = await extractCwd(file)
    expect(result).toBe("/Users/x/code/repo")
    await cleanup()
  })

  test("returns null when no cwd field", async () => {
    await setup()
    const file = join(tempDir, "session.jsonl")
    const line = JSON.stringify({ type: "system", message: "no cwd here" })
    await Bun.write(file, line)

    const result = await extractCwd(file)
    expect(result).toBeNull()
    await cleanup()
  })

  test("returns null for nonexistent file", async () => {
    const result = await extractCwd("/nonexistent/path/file.jsonl")
    expect(result).toBeNull()
  })

  test("skips malformed lines to find cwd", async () => {
    await setup()
    const file = join(tempDir, "session.jsonl")
    const lines = [
      "bad json",
      JSON.stringify({ type: "init", cwd: "/found/it" }),
    ].join("\n")
    await Bun.write(file, lines)

    const result = await extractCwd(file)
    expect(result).toBe("/found/it")
    await cleanup()
  })
})
