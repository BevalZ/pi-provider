/**
 * Shared box-drawing utilities for TUI dashboards.
 *
 * Reusable across extensions (cost-tracker, session-manager, etc.).
 * Import: import { … } from "../_shared/box-drawing"
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ── Unicode box-drawing characters ─────────────────────────────────────

export const H = "─";
export const V = "│";
export const TL = "╭";
export const TR = "╮";
export const BL = "╰";
export const BR = "╯";
export const LT = "├";
export const RT = "┤";

// ── Border helpers ─────────────────────────────────────────────────────

/** Top border with optional title (title rendered by caller, not inserted here). */
export function topBorder(w: number, title: string, th: any): string {
  const titleVis = visibleWidth(title);
  const left = 2;
  const right = w - 2 - left - titleVis;
  return th.fg("accent", TL + H.repeat(left)) + title + th.fg("accent", H.repeat(Math.max(0, right)) + TR);
}

/** Simple top border without title. */
export function topBorderPlain(w: number, th: any): string {
  return th.fg("accent", TL + H.repeat(w - 2) + TR);
}

/** Bottom border. */
export function bottomBorder(w: number, th: any): string {
  return th.fg("borderMuted", BL + H.repeat(w - 2) + BR);
}

/** Mid horizontal divider. */
export function midBorder(w: number, th: any): string {
  return th.fg("borderMuted", LT + H.repeat(w - 2) + RT);
}

/** Pad text to a fixed visible width, truncating if too long. */
export function sidePad(text: string, width: number): string {
  const vis = visibleWidth(text);
  if (vis >= width) return truncateToWidth(text, width);
  return text + " ".repeat(width - vis);
}

/** Render a single content line inside a box: `│ content │`. */
export function lineInBox(content: string, boxWidth: number, th: any): string {
  const contentW = boxWidth - 4;
  if (contentW <= 0) return th.fg("borderMuted", V) + V;
  return th.fg("borderMuted", V) + " " + sidePad(content, contentW) + " " + th.fg("borderMuted", V);
}
