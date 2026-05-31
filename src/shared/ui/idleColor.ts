/**
 * Idle / non-ok foreground color used across the usage widgets. Dim
 * enough that a widget reads as "paused, not live" against both dark
 * and light VS Code themes but still legible. Bar emoji squares ignore
 * `item.color` (they carry their own intrinsic color), so the color
 * only affects the codicon and number text. Value matches Tailwind
 * `neutral-700`. Single source of truth: every widget that paints a
 * non-ok / error state imports this constant rather than redeclaring
 * the literal.
 */
export const IDLE_DIM_COLOR = "#404040";
