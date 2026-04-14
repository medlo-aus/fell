---
name: release
description: Release a new version of fell to both npm and GitHub. Bumps version, publishes to npm (@doccy/fell), pushes tag, creates a GitHub release with generated notes, then prompts for custom release notes if the auto-generated ones are too thin. Use when the user says "release fell", "publish fell", "cut a release", "bump the version", or similar.
argument-hint: [patch|minor|major]
---

# Release fell

Dual-publish workflow: npm (`@doccy/fell`) + GitHub (`medlo-aus/fell`). Both must be updated on every release. The version bump type is provided as `$ARGUMENTS` (defaults to `patch` if omitted).

---

## Pre-flight checks

Before starting, verify the working tree is clean and npm auth is valid. Run these in parallel:

```bash
cd ~/code/fell
git status                                  # must be clean on main
git branch --show-current                   # must be "main"
bunx npm whoami                             # must return the publisher account
bunx npm pkg get version                    # current version
bunx npm pack --dry-run 2>&1 | tail -15     # verify package contents
```

**Abort if:**
- Not on `main` → checkout main
- `bunx npm whoami` fails → user needs to run `bunx npm login` manually (cannot be automated; opens a browser)
- `bunx npm pack --dry-run` output includes `.env`, `node_modules/`, `.claude/worktrees/`, or other secrets → fix the `files` field in `package.json` before releasing

**If the working tree is dirty**, see "Handling pre-release changes" below before proceeding. Do NOT proceed past pre-flight without the user's go-ahead if any of the abort conditions above fail.

---

## Handling pre-release changes

If `git status` shows uncommitted or untracked changes before you start, those need to be resolved before running `npm version` — otherwise the version bump commit will accidentally bundle unrelated work.

**Step 1: Inspect what's changed**

```bash
git status --short
git diff --stat
git diff              # review actual changes
```

Classify each change:

| Change type | What to do |
|-------------|------------|
| Belongs with this release (README, docs, the feature being shipped) | Commit it with a descriptive message (see below) |
| Unrelated work-in-progress | Stash it: `git stash push -m "pre-release wip"` |
| Accidentally modified files you don't recognize | Ask the user — do NOT discard without confirmation |
| Untracked files that shouldn't be in the repo | Add to `.gitignore` or ask the user |

**Step 2: Commit release-relevant changes with a real message**

Do NOT use generic messages like "updates" or "changes for release". Write a conventional commit that describes the *user-visible change*, following the repo's existing style.

Read recent commit messages first to match the repo convention:

```bash
git log --oneline -10
```

Then stage specific files (avoid `git add -A` — it can sweep up unrelated changes) and commit with a HEREDOC for multi-line messages:

```bash
git add README.md lib/foo.ts
git commit -m "$(cat <<'EOF'
feat: short imperative title under 60 chars

Optional body explaining the why, not the what. Reference the
user-facing change, not the internal refactor. Wrap at ~72 chars.
EOF
)"
```

**Commit message rules for this skill:**

- **Title**: imperative mood ("add", "fix", "update"), under 60 chars, no trailing period
- **Prefix**: match existing style — look at `git log --oneline` before writing. This repo uses conventional-ish prefixes: `feat:`, `fix:`, `refactor:`, `docs:`, or none at all
- **Body**: only if non-trivial. Explain *why* the change matters, not what the diff shows. Skip for one-line fixes
- **One logical change per commit**: if the dirty tree has two unrelated changes, make two commits
- **Never**: "updates", "wip", "more changes", "fixes", "release prep", or any message that would make a future reader ask "what changed?"

**Step 3: Verify clean working tree**

```bash
git status    # must show nothing
```

Only proceed to the Release steps below once `git status` is clean. The `npm version` commit in Step 1 is a minimal marker (just the version number) — its job is to be a clean release boundary, not to describe the changes. The logical narrative lives in the commits you just made.

---

## Release steps

Run these sequentially. Do not skip or reorder.

### Step 1: Bump version

```bash
cd ~/code/fell
bunx npm version $ARGUMENTS    # patch | minor | major
```

This does three things in one command:
1. Updates `version` in `package.json`
2. Creates a git commit (e.g. `0.4.0`)
3. Creates a local git tag (e.g. `v0.4.0`)

The tag only exists locally until step 3.

### Step 2: Publish to npm

```bash
bunx npm publish --access public
```

Scoped packages (`@doccy/*`) require `--access public` on every publish — omitting it fails with a 402 on the free tier. This pushes the tarball to npmjs.com. It does NOT interact with git or GitHub.

### Step 3: Push commit + tag to GitHub

```bash
git push && git push --tags
```

Both pushes are required:
- `git push` → publishes the version bump commit to `main`
- `git push --tags` → publishes the `v<version>` tag

Without `--tags`, GitHub's "Releases" sidebar stays empty even though npm has the version.

### Step 4: Create GitHub release with auto-generated notes

```bash
VERSION=$(bunx npm pkg get version | tr -d '"')
gh release create "v$VERSION" --generate-notes --latest
```

`--generate-notes` auto-generates a changelog from commits and merged PRs since the previous tag. `--latest` marks this as the current latest release on the repo sidebar.

**Important**: `--generate-notes` is often thin. For feature releases it frequently produces just:

```
**Full Changelog**: https://github.com/medlo-aus/fell/compare/v0.3.0...v0.4.0
```

If that's all you get, proceed to Step 5 to write proper notes.

### Step 5: Write custom release notes (if auto-generated are thin)

Check what was generated:

```bash
gh release view "v$VERSION" --json body --jq .body
```

If the body is just the "Full Changelog" link (or otherwise unhelpful), overwrite it with structured notes. Read recent commits to understand what changed:

```bash
git log --oneline "v$PREVIOUS_VERSION..v$VERSION"
```

Then update with a HEREDOC for clean formatting:

```bash
gh release edit "v$VERSION" --notes "$(cat <<'EOF'
## Highlights

Brief one-line summary of the most important change.

### New: Feature A

Detailed description of the main feature, what it does, why it matters.

```bash
fell --some-flag              # example usage
```

### New: Feature B

...

### Other changes

- Small improvement
- Bug fix
- Docs update

**Full Changelog**: https://github.com/medlo-aus/fell/compare/vPREVIOUS...vCURRENT
EOF
)"
```

Replace `vPREVIOUS` and `vCURRENT` with the actual version strings. Keep the notes focused on what's visible to users — not internal refactors unless they affect behavior.

### Step 6: Verify both registries

```bash
# npm — should show the new version
bunx npm info @doccy/fell version

# GitHub — should show the tag and publishedAt
gh release view "v$VERSION" --repo medlo-aus/fell --json tagName,publishedAt,url
```

Both should reflect the new version. Report the release URL to the user.

---

## Quick reference (patch release, clean main, auto-notes sufficient)

```bash
cd ~/code/fell
bunx npm version patch
bunx npm publish --access public
git push && git push --tags
gh release create "v$(bunx npm pkg get version | tr -d '"')" --generate-notes --latest
```

Five commands. Takes ~30 seconds end-to-end.

---

## How the pieces connect

Four independent systems tied together manually:

| System | Command | What it does |
|--------|---------|--------------|
| **package.json** | `bunx npm version` | Bumps version, creates commit + local tag |
| **npmjs.com** | `bunx npm publish` | Publishes tarball to the npm registry |
| **GitHub repo** | `git push --tags` | Pushes commits + tags to GitHub |
| **GitHub Releases** | `gh release create` | Creates a Release entry from an existing tag |

Skipping any one leaves a partial release. Common failure modes:
- Forgot `git push --tags` → npm has the version, GitHub sidebar is empty
- Forgot `gh release create` → tag exists but no Release entry, no auto-notes
- Forgot `bunx npm publish` → GitHub has the tag but `bunx npm info` shows old version
- Used wrong `--access` → 402 error from npm

---

## Rollback

If something goes wrong AFTER publish:

```bash
VERSION=<the broken version>

# 1. Delete the GitHub release
gh release delete "v$VERSION" --yes

# 2. Delete the tag locally and on the remote
git tag -d "v$VERSION"
git push origin ":refs/tags/v$VERSION"

# 3. Revert the version bump commit (creates a new commit)
git revert HEAD
git push

# 4. Unpublish from npm (only works within 72h, and only if nothing depends on it)
bunx npm unpublish "@doccy/fell@$VERSION"
```

After 72h, npm refuses unpublish to protect the ecosystem. In that case, bump a new patch version with a fix and use `npm deprecate` to discourage the broken version:

```bash
bunx npm deprecate "@doccy/fell@$VERSION" "Broken — use $NEW_VERSION"
```

---

## Rules for this skill

- **Never run `npm login`** — it's interactive and needs a browser. Ask the user to run it if auth fails.
- **Never skip `--access public`** on publish — scoped packages require it every time.
- **Never skip `git push --tags`** — without it the GitHub release step has no tag to create from.
- **Never use `--no-verify`** on any git operation.
- **Never force-push to main** — if the version bump commit needs to be redone, use `git revert` (see Rollback).
- **Always use the `--latest` flag** on `gh release create` — otherwise the release doesn't become the headline on the repo homepage.
- **Always verify version bumped correctly** before publishing — `bunx npm pkg get version` should match the tag being created.
- **Check `git status` again after the version bump** — `npm version` creates a commit, so the working tree should still be clean.
- **When writing custom release notes, read `git log` first** to know what actually changed. Don't invent features.
