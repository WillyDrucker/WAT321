---
name: 321
description: Router for the /321 skill family. Resolves -<Flag> against AIDOCS/_index.json -> skills.dispatch and loads the matching sub-skill body.
---

# /321

**Purpose:** Single entry point for the /321 skill family. The user invokes `/321 -<Flag>` and this router resolves the flag against `AIDOCS/_index.json -> skills.dispatch`, loads the sub-skill body, and executes it.

## How to invoke

```
/321 -SessionUpdate    refresh SESSION (Current State + LIFO)
/321 -MemoryUpdate     distill MEMORY (LIFO + Big-6) + BACKLOG
/321 -Update           the daily driver: chain -SessionUpdate then -MemoryUpdate
/321 -Update -Sync     update the engine itself from upstream (project data untouched)
/321 -DevAudit         audit the source against DEV-AUDIT.md (-FULL)
/321 -AutoPush         capture, commit, and push to the anchored remote
```

`/321` alone prints this usage block.

## Dispatch

1. Parse the flag - the first token after `/321`.
2. Normalize it to a key: drop the leading `-` and lowercase (`-SessionUpdate` -> `sessionupdate`).
3. Look up `skills.dispatch.<key>.body` in `AIDOCS/_index.json`.
4. Load the body, treat it as inlined, and execute it. The body owns its own flow.

Unknown flag -> list the available flags from `skills.dispatch` and exit. Do not guess.

## Rules

- **Resolve and load.** The router does not duplicate sub-skill logic.
- **Body paths come from `_index.json`.** Do not hardcode them here.
- **Registration is mechanical.** A skill body in `AIDOCS/SKILL/` plus `sync` registers it - no router edit needed.
