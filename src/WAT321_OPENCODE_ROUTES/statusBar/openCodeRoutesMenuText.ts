import type { MenuRowText } from "../../shared/ui/menuRows";

/**
 * Description copy for the shared pause, resume, and cancel rows in
 * the OpenCode Routes menus. Pause refuses NEW tool calls while the
 * in-flight call finishes normally, and the drain tools stay
 * reachable while paused. Cancel drops the sentinel `channel.mjs`
 * observes and aborts the active call against.
 */
export const OPENCODE_ROUTES_MENU_TEXT: MenuRowText = {
  pause: "Block new tool calls until you resume.",
  resume: "Re-enable OpenCode Routes tool calls.",
  cancel: "Abort the in-flight tool call.",
};
