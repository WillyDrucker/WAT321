# WAT321 Bridge - Dispatch judgement (optional)

For the case where user intent is implicit and you're weighing whether
to override sticky Adaptive with `fire_and_forget: true` on your own
initiative. Direct asks ("fire and forget Codex", "don't wait for
this") need no judgement - pass `fire_and_forget: true` and move on.

For wait-mode mechanics see `bridge://docs/dispatch`. For sticky-flag
mechanics see `bridge://docs/dispatch/routing`.

## What you can do

Explicit `fire_and_forget: true` overrides the sticky widget mode.
The override exists - it is permission, not requirement. You have the
option when your read of the conversation says the user wouldn't want
to block on this prompt.

## Where the option can fit

Heuristic, not a rule. The bar is high - a miscalculation here leaves
the user wondering why you didn't wait. Lean toward FF only when the
case is clear:

- A prompt you can see will obviously run long (full-codebase audit,
  multi-file refactor, deep review of a large doc set).
- The user is mid-flow on something else and would rather you hand
  control back than block their turn for 5-20 minutes.
- You wouldn't want to sit on a 10-minute adaptive timer yourself for
  the answer.

## Where to leave the sticky alone

- The user asked a direct question and expects the answer this turn.
- The prompt is short or medium and adaptive would land it normally.
- You can't read whether the user wants the reply now or later -
  default to the sticky widget. The user can override via the toggle
  or a per-call arg next time if they meant otherwise.

## If you do override

Pass `fire_and_forget: true` and return control. The reply lands in
the bridge inbox; the user (or the next Codex turn) drains it via
`wat321_bridge()` when ready.
