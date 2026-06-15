---
name: 321
description: Router for the /321 skill family. Resolves -<Flag> against AIDOCS/_index.json -> skills.dispatch and loads the matching sub-skill body.
---

# /321

**Purpose:** Single entry point for the /321 skill family. The user invokes `/321 -<Flag>` and this router resolves the flag against `AIDOCS/_index.json -> skills.dispatch`, loads the sub-skill body, and executes it.

## How to invoke

```
/321 -Setup            onboard a project: fresh fill or migrate (deregistered at graduation)
/321 -UpdateSession    refresh SESSION (Current State + LIFO)
/321 -UpdateMemory     distill MEMORY (LIFO + Big-6) + BACKLOG
/321 -Update           the daily driver: chain -UpdateSession then -UpdateMemory (-FULL propagates)
/321 -UpdateSync       upgrade from upstream: engine, skills, router, manifest ops (project content + customizations[] preserved)
/321 -DevAudit         audit the source against DEV-AUDIT.md (-FULL refactors)
/321 -AutoPush         capture, commit, and push to the anchored remote
/321 -Compact          emit ready-to-paste /compact instructions for the next conversation
```

`/321` alone prints this usage block.

## Dispatch

1. Parse the flag - the first token after `/321`. Any tokens after it (e.g. `-FULL`) are arguments for the resolved sub-skill, not part of the lookup.
2. Normalize it to a key: drop the leading `-`, strip any remaining hyphens, and lowercase. So `-UpdateSession`, `-updatesession`, `-UPDATESESSION`, and `-Update-Session` all resolve to `updatesession`. Documentation uses the camelCase canonical form, but the router accepts the variants for typing forgiveness.
3. Look up `skills.dispatch.<key>.body` in `AIDOCS/_index.json`.
4. Load the body, treat it as inlined, and execute it. The body owns its own flow.

Unknown flag -> list the available flags from `skills.dispatch` and exit. Do not guess.

## Rules

- **Resolve and load.** The router does not duplicate sub-skill logic.
- **Body paths come from `_index.json`.** Do not hardcode them here.
- **Variant suffixes pass through.** Tokens after the skill flag (`-FULL`, `-CHECK`, etc.) reach the sub-skill body as arguments. The router only resolves the first token.
- **Registration is mechanical.** A skill body in `AIDOCS/SKILL/` plus `sync` registers it for dispatch - adding one needs no router edit. The quick-ref above is a human usage hint, reconciled mechanically: `graduate` and `upgrade` both prune any `/321 -Flag` line whose `SKILL_<Name>.md` body is no longer on disk, so the deregistered `-Setup` line drops on its own at graduation.
