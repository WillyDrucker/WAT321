import * as vscode from "vscode";
import type { ProviderKey, WidgetDescriptor } from "./contracts";
import { SETTING } from "./settingsKeys";

/**
 * Centralized catalog of every WAT321 widget. Single source of
 * truth for widget IDs, slots, and provider ownership.
 *
 * Metadata-only: widgets still create and own their own VS Code
 * StatusBarItems. The catalog feeds:
 *   - Reset WAT321's status-bar visibility restore
 *   - Priority resolution via `getWidgetPriority`
 *   - Startup validation (duplicate ID/slot detection)
 */

const DEFAULT_BASE_PRIORITY = 1001;

/** All registered widget descriptors. Order determines default
 * left-to-right status bar position (slot 0 = leftmost). */
const WIDGETS = [
  { id: "wat321.session",               name: "Claude Usage (5hr)",           provider: "claude", slot: 0 },
  { id: "wat321.weekly",                name: "Claude Usage (Weekly)",        provider: "claude", slot: 1 },
  { id: "wat321.codexSession",          name: "Codex Usage (5 hour)",         provider: "codex",  slot: 2 },
  { id: "wat321.codexWeekly",           name: "Codex Usage (Weekly)",         provider: "codex",  slot: 3 },
  { id: "wat321.sessionTokens",         name: "Claude Session Tokens",        provider: "claude", slot: 4 },
  { id: "wat321.epicHandshake",         name: "Epic Handshake",               provider: "engine", slot: 5 },
  { id: "wat321.codexSessionTokens",    name: "Codex Session Tokens",         provider: "codex",  slot: 6 },
] as const satisfies readonly WidgetDescriptor[];

/** Every widget ID registered in the catalog. Used by Reset WAT321
 * to restore right-click "Hide" decisions. */
export function getAllWidgetIds(): readonly string[] {
  return WIDGETS.map((w) => w.id);
}

/** Widget IDs belonging to a specific provider. */
export function getWidgetIdsForProvider(
  provider: ProviderKey | "engine"
): readonly string[] {
  return WIDGETS.filter((w) => w.provider === provider).map((w) => w.id);
}

/** Resolve a widget's slot offset to a concrete VS Code priority. */
export function getWidgetPriority(slot: number): number {
  const base = vscode.workspace
    .getConfiguration("wat321")
    .get<number>(SETTING.statusBarPriority, DEFAULT_BASE_PRIORITY);
  return base - slot;
}

/** Named slot constants for widget constructors. Validated against
 * the WIDGETS array by `validateCatalog()` at startup so they
 * cannot drift silently. */
export const WIDGET_SLOT = {
  claudeUsage5H: 0,
  claudeUsageWeekly: 1,
  codexUsage5H: 2,
  codexUsageWeekly: 3,
  claudeSessionTokens: 4,
  epicHandshake: 5,
  codexSessionTokens: 6,
} as const;

/** Derived reverse map: slot number -> widget ID. Built from
 * WIDGETS at module init so the relationship is authoritative. */
const SLOT_TO_WIDGET_ID = new Map<number, string>(
  WIDGETS.map((w) => [w.slot, w.id])
);

/** Startup validation. Checks for duplicate IDs, duplicate slots,
 * and consistency between WIDGET_SLOT constants and the WIDGETS
 * array. Throws on any mismatch so drift is caught before it
 * ships. */
export function validateCatalog(): void {
  const ids = new Set<string>();
  const slots = new Set<number>();
  for (const w of WIDGETS) {
    if (ids.has(w.id) || slots.has(w.slot)) {
      throw new Error(
        `[WAT321] Widget catalog validation failed: duplicate ${ids.has(w.id) ? "ID" : "slot"} in ${w.id}`
      );
    }
    ids.add(w.id);
    slots.add(w.slot);
  }
  for (const [name, slot] of Object.entries(WIDGET_SLOT)) {
    const expectedId = SLOT_TO_WIDGET_ID.get(slot);
    if (!expectedId) {
      throw new Error(
        `[WAT321] WIDGET_SLOT.${name} = ${slot} has no matching widget in WIDGETS`
      );
    }
  }
}
