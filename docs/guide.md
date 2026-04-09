# fell Guide

## Recycling

The `♻` symbol next to a worktree means it can be reused for a new branch without reinstalling dependencies. A worktree is recyclable when its PR is merged and the working tree is clean, or when it has been explicitly released (detached HEAD).

**Release** (`c` key): detaches HEAD from a worktree, keeping the directory and `node_modules` intact. The worktree becomes an idle slot. Optionally deletes the old branch.

**Recycle** (CLI): `fell --recycle <branch>` finds the best recyclable worktree, fetches from origin, checks out the new branch, and prints the path. Warns if the lockfile changed (you may need to run your package manager).

```bash
fell --recycle feature-auth           # auto-picks best slot
fell --recycle feature-auth --slot ~/code/project/.claude/worktrees/wt-1
cd $(fell --recycle feature-auth)     # pipe-friendly
```

## Help Overlay

Press `?` to open the shortcuts panel. It overlays on top of the worktree list and shows all keybindings including hidden ones (`a` select all, `p` prune, `r` refresh) that aren't shown in the bottom bar.

The overlay also has a **theme toggle**: press `l` for light or `d` for dark. This switches the colour scheme instantly for terminals where auto-detection doesn't work. You can also set `FELL_THEME=light` or `FELL_THEME=dark` as an environment variable.

## Open Sub-menu

Press `o` to open the focused worktree. This enters a quick picker — press `f` for Finder or `c` for Cursor IDE. Any other key cancels. The picker only appears in the bottom bar; no mode change or overlay.
