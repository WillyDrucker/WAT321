---
name: wat-publish
description: Pre-publication checklist and version bump for WAT321 VS Code extension. Delegates Step 1 to /watsession-update.
user-invocable: true
---

# wat-publish

Runs the full WAT321 release pipeline end-to-end with **zero user prompts**. Once invoked, this skill executes every step sequentially and only halts on a hard failure (build error, git error, auth error). The user does not need to confirm anything mid-run.

**Invocation:** `/wat-publish`, `/wat-publish -FULL`, `/wat-publish -SKIM`. Flag passes through to `/watsession-update` in Step 1.

**Memory-track separation.** This skill does NOT invoke `/watmemory-update`. Memory-track updates are manual-only per the System 1 / System 2 split. If `/watsession-update` Step 5 flags memory-track items, they appear in the final report; the user decides when to run `/watmemory-update`.

## Prerequisite (user responsibility before invoking)

If you want to sanity-check the current working state before shipping, press `F5` in VS Code (for widget/UI work) or relaunch the isolated test instance at `C:\Dev\WAT321-testing\` (for bridge work) and eyeball everything. The skill assumes the code is ready. If you're not sure, test first, then invoke the skill.

## Key conventions

- Branch name, `package.json` version, `package-lock.json` version, and `CHANGELOG.md` entry must always be in sync. Branch `WAT321_v1.0.1` means both package files say `1.0.1` and the changelog has a `## [1.0.1]` entry. `package-lock.json` is easy to forget because `npm install` only touches it when dependencies change - it must be bumped manually at rollover.
- **Commit messages must be descriptive and specific** so GitHub shows meaningful per-file history. Group related changes into focused commits rather than one giant dump.
  - Good: "fix Codex session token readHead buffer size for large session_meta"
  - Good: "add warning color threshold at 90% for all usage widgets"
  - Bad: "WAT321 v1.0.4 - bug fixes and polish"
  - Bad: "update everything"
- Only changelog entries and version-bump commits should mention the version number.

## Halt-on-failure rule

If any step returns a non-zero exit or fails a verification, **stop the skill immediately** with a clear error explaining what broke and where. Do not prompt, do not retry, do not proceed past a broken state. The user will read the error and either fix it or invoke the skill again.

---

## Step 1: Sync Session track (delegate to /watsession-update)

Invoke `/watsession-update` with the flag passthrough (`-FULL` or `-SKIM` if the user supplied one; otherwise let it auto-detect). Let the skill do its job. Do not duplicate its logic here.

The skill will:
- Update `WD_WAT321_SESSION_HANDOFF.md` (one-liners + cross-refs)
- Update `WD_WAT321_SESSION_HANDOFF_EXTENDED.md` (per in-flight item detail)
- Update `CHANGELOG.md` `[Unreleased]` bullets
- Flag any memory-track changes needed

Capture the output summary for the final report.

**Do NOT commit yet** - files will be staged + committed in Step 3.

Halt if: `/watsession-update` reports an error. The rest of the pipeline depends on a consistent session-track state.

## Step 2: Pre-flight gathering (silent)

Gather state without producing any user-visible output yet:

- `git branch --show-current` - must match `WAT321_vX.X.X` pattern
- `git status --short` - list uncommitted changes (including the session-track files `/watsession-update` just wrote)
- `git log --oneline -10` - recent history
- Single-shot version sync check:

  ```bash
  node -e "const b=require('child_process').execSync('git branch --show-current').toString().trim().replace(/^WAT321_v/,'');const p=require('./package.json').version;const l=require('./package-lock.json');if(b!==p||b!==l.version||b!==l.packages[''].version){console.error('version mismatch',{branch:b,pkg:p,lockTop:l.version,lockPkgs:l.packages[''].version});process.exit(1)}console.log('version sync ok',b)"
  ```

  This asserts `branch == package.json.version == package-lock.json.version == package-lock.json.packages[""].version` in one step. If it fails, **fix the mismatched file(s) in the working tree** (to be committed in Step 3's metadata commit) and re-run the check. Do not prompt.

Halt if: branch name does not match `WAT321_vX.X.X`, or if there is no current branch.

## Step 3: Stage and commit uncommitted work

If `git status --short` is empty (excluding session-track files that /watsession-update just wrote), skip to Step 4.

Otherwise, group the modified files into focused commits by reading the diff of each file and clustering by **logical change intent**, not by filesystem location. Typical buckets:

- **Core engine** - provider registry, event hub, widget catalog, settings keys, contracts, toast notifier (`src/engine/**`)
- **Shared infrastructure** - polling, UI helpers, FS utilities, codex-rollout parsers, codex models cache (`src/shared/**`)
- **Per-tool work** - usage, session tokens, Epic Handshake (`src/WAT321_*/**`)
- **Entry and metadata** - `src/extension.ts`, `src/bootstrap.ts`, `package.json`, `package-lock.json`, `.vscodeignore`, `README.md`, `CLAUDE.md`
- **AIDOCS** - `AIDOCS/WD_WAT321_*.md` session/memory updates (committed as a separate metadata commit)
- **CHANGELOG** - always its own commit, always last

For each group, stage the specific files with `git add <file1> <file2>` (never `git add .` or `git add -A`) and commit with a descriptive message that explains the *change*, not the files touched. The message should answer "what did this change do and why" in one-to-three sentences.

**Windows line-ending noise:** `git add` on Windows prints `warning: LF will be replaced by CRLF` for every touched file. This is expected; ignore it and do not halt on it.

### Cross-cutting changes

Logical changes that span multiple groupings **land as a single focused commit, not split across groups.** The commit message names the logical change, not the filesystem locations. Only split if the pieces are genuinely independent and would ship separately in a hypothetical partial release.

Do not include the version number in commit messages except the changelog commit and version-bump commits.

Halt if: any commit fails (pre-commit hook rejection, unexpected file state, etc).

## Step 4: Changelog finalize

Read `CHANGELOG.md`. The current branch version must have an entry.

- If the entry exists with today's date (`## [X.X.X] - YYYY-MM-DD`), continue.
- If the entry exists as `## [X.X.X] - unreleased`, replace `unreleased` with today's date (`YYYY-MM-DD`) and commit as `"date X.X.X changelog entry"`.
- If the entry is missing entirely, `/watsession-update` should have populated `[Unreleased]` in Step 1. Convert `[Unreleased]` to `[X.X.X] - YYYY-MM-DD` and commit as `"finalize changelog entry for X.X.X"`.

### Tone rule for changelog entries

Same rule `/watsession-update` uses when writing `[Unreleased]` bullets: human-readable, bold one-liner first, short prose explanation, single technical reference at end max, bias prose over lists, never lead with version/file/PR/issue. Use "you"/"your". The `[1.0.11]` entry in CHANGELOG is the reference voice.

Halt if: commits exist since the last tag but none of the changelog sections can be populated (something very unusual is going on).

## Step 5: Pre-publish checklist

Four load-bearing checks. Halt on the first failure with a specific error message pointing at what to fix.

- [ ] `npm run build` passes (clean + lint + tsc + copy-assets + emit-prod-modules-manifest)
- [ ] `CHANGELOG.md` has an entry for this version with today's date (not `unreleased`)
- [ ] No debug logging in src. Scan for `console.log` and `\.appendLine\(`. Known allow-list: `panel.appendLine` inside `src/engine/healthCommand.ts` (hidden debug command output) and the EH logger at `src/WAT321_EPIC_HANDSHAKE/outputChannel.ts`. Any other `.appendLine` call is a debug-logging escape that must be removed.
- [ ] No em dashes or arrow characters in any tracked file (`git grep -nP '[\x{2014}\x{2192}\x{2190}\x{2191}\x{2193}]'`)

## Step 6: Build the .vsix

**Policy: only one .vsix ever lives in the working directory.** GitHub Releases is the historical archive (attached in Step 9); local files are ephemeral build output.

```bash
rm -f wat321-*.vsix
npm run package
```

After it finishes:

- Confirm the output file name matches `wat321-X.X.X.vsix`
- Confirm it is the only `.vsix` present: `ls wat321-*.vsix` should show exactly one file
- Note the size; flag if significantly larger or smaller than expected (~3.4MB with the current MCP SDK bundle)
- Verify package contents via `npx vsce ls` - it must contain NO internal docs (`AIDOCS`, `WDDOCS`, `CLAUDE.md`, `.vscode`, `.github`)

Halt if: build fails, output file missing, multiple `.vsix` present after cleanup, or package contents include internal docs.

## Step 7: Push the version branch

```bash
git push origin WAT321_vX.X.X
```

Halt if: push is rejected (needs rebase, hook failure, network).

## Step 8: Tag the release

Create the annotated tag locally, then push it.

```bash
git tag -a vX.X.X -m "Release vX.X.X"
git push origin vX.X.X
```

The tag message is deliberately minimal. The GitHub Release in Step 9 pulls its body from this tag message via `--notes-from-tag`, and we want the release page to be short and link to the changelog for detail.

Halt if: tag already exists or push is rejected.

## Step 9: GitHub Release with .vsix attached

```bash
gh release create vX.X.X wat321-X.X.X.vsix \
  --title "WAT321 vX.X.X" \
  --notes-from-tag
```

**Do not pass `--repo WillyDrucker/WAT321` when using `--notes-from-tag`.** The gh CLI rejects the combination. The skill is run from inside the WAT321 working directory which already has origin set to the repo, so `--repo` is redundant and only breaks the `--notes-from-tag` flow.

Halt if: `gh release create` fails (auth error, rate limit, network, tag not yet visible to gh).

## Step 10: Merge to main

```bash
git checkout main
git pull origin main
git merge --no-ff WAT321_vX.X.X -m "Merge branch 'WAT321_vX.X.X'"
git push origin main
```

Halt if: merge produces conflicts, or if the push is rejected.

## Step 11: Verification gate

All three of these must be true. Halt on any failure.

- `git ls-remote --heads origin main` returns the merge commit SHA
- `git ls-remote --tags origin | grep vX.X.X` returns the tag SHA
- `gh release view vX.X.X --repo WillyDrucker/WAT321` shows the release with the `.vsix` asset listed

If any check fails, stop and report the specific gap.

## Step 12: Rollover to the next development branch

```bash
git checkout -b WAT321_vX.X.Y
```

Increment the patch version (`1.0.10` -> `1.0.11`). If the user is mid-minor-bump, they'll create the branch manually instead of using the skill; this skill always assumes patch increment.

Update version fields in three places:

1. `package.json` `version`
2. `package-lock.json` top-level `version`
3. `package-lock.json` `packages[""].version`

**If the rollover branch already exists and `package.json` is already bumped**, skip the version writes and go straight to the changelog starter + commit. Run the Step 2 version-sync check to confirm.

Add a starter entry at the top of `CHANGELOG.md`:

```markdown
## [X.X.Y] - unreleased

### Added

### Changed

### Fixed

### Removed
```

Commit and push:

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "start vX.X.Y development"
git push -u origin WAT321_vX.X.Y
```

Halt if: commit or push fails.

## Step 13: Final report

Produce a single report block with all the relevant URLs, memory-track flags from Step 1, and a marketplace upload reminder.

```
WAT321 vX.X.X published to git and GitHub Releases.

.vsix:           wat321-X.X.X.vsix (in working directory)
Tag:             vX.X.X (on origin, points at merge commit)
Main:            merged and pushed
GitHub Release:  https://github.com/WillyDrucker/WAT321/releases/tag/vX.X.X
Next branch:     WAT321_vX.X.Y (package.json + package-lock.json bumped, changelog starter added)

Session-track sync: <summary from /watsession-update>

Memory-track flags (from /watsession-update Step 5):
  - <list, if any>
  - (or) None. Memory track is clean.

If memory-track flags surfaced, run /watmemory-update when convenient.

MARKETPLACE UPLOAD (manual, at your convenience):
  1. Open https://marketplace.visualstudio.com/manage/publishers/WillyDrucker
  2. Drag wat321-X.X.X.vsix onto the WAT321 row
  3. This bypasses the PAT requirement
  Until uploaded, marketplace still shows the previous version. GitHub Releases
  already has the new version available.
```

The marketplace upload is intentionally left as a manual post-skill step because the PAT-free drag-and-drop flow cannot be automated by this skill. Everything else is complete.

---

## Rules

- **No prompts, no confirmation dialogs between steps.**
- **Step 1 delegates to /watsession-update.** Do not duplicate session-update logic inline.
- **Never invoke /watmemory-update.** Memory-track flags surface in the final report; user decides timing.
- **Halt on failure.** A halt is a halt; the user investigates and re-invokes.
- **No destructive recovery.** If the working tree or git state is in an unexpected shape, halt and report rather than forcing through.
- **Does not upload to the VS Code Marketplace.** That remains a manual drag-and-drop step.
- **Does not run live widget tests.** The user is expected to have tested via `F5` or the isolated test instance before invoking the skill.
- **Does not retry failed steps.**
