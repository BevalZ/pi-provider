/**
 * Shared Enhanced Select component for Pi extensions.
 *
 * Improvements over built-in ctx.ui.select():
 *   - Keyboard shortcut support: items starting with a single letter + space
 *     (e.g. "s Save", "x Discard") can be triggered by pressing that letter key
 *   - Cyclic navigation: pressing Up at the first item wraps to the last item,
 *     and pressing Down at the last item wraps to the first item
 *
 * Usage:
 *   import { enhancedSelect } from "../_shared/enhanced-select";
 *   const result = await enhancedSelect(ctx, "Title", ["s Save", "x Discard"]);
 *
 * Returns the selected item string, or undefined if cancelled.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { topBorder, bottomBorder, midBorder, lineInBox, sidePad, V } from "./box-drawing";

// ── Extract shortcut key from item text ──────────────────────────────────

/**
 * Parse a shortcut key from an item like "s Save" → "s".
 * Only matches pattern: single letter + space + rest of text.
 * Returns lowercase letter or undefined.
 */
function parseShortcut(item: string): string | undefined {
  const match = item.match(/^([a-zA-Z])\s/);
  return match ? match[1].toLowerCase() : undefined;
}

// ── Fuzzy match ──────────────────────────────────────────────────────────

/**
 * Case-insensitive fuzzy match: every character in `filter` must appear
 * in order within `text`, but they need not be consecutive.
 * Returns true when filter is empty.
 */
export function fuzzyMatch(text: string, filter: string): boolean {
  if (!filter) return true;
  const t = text.toLowerCase();
  const f = filter.toLowerCase();
  let fi = 0;
  for (let i = 0; i < t.length && fi < f.length; i++) {
    if (t[i] === f[fi]) fi++;
  }
  return fi === f.length;
}

// ── Enhanced Select Component ───────────────────────────────────────────

/** Options for the enhanced select dialog. */
export interface EnhancedSelectOptions {
  /**
   * Enable fuzzy filtering: as the user types printable characters, items are
   * filtered in real-time. Characters must appear in order (case-insensitive)
   * but need not be consecutive.
   *
   * Shortcut keys (single-letter prefix) still work when the filter is empty.
   * Backspace removes the last character; Escape clears the filter first, then
   * cancels on the second press.
   *
   * Default: false (backward-compatible).
   */
  fuzzy?: boolean;
  /**
   * Sort items before display.
   * - "name": case-insensitive, numeric-aware localeCompare (Chinese-friendly, "file2" before "file10").
   * - "none"/undefined: keep caller-provided order (backward-compatible).
   */
  sort?: "name" | "none";
  /**
   * Action keys: single-letter keys that, when pressed while the fuzzy filter
   * is empty, resolve the select with a sentinel-encoded result indicating
   * which action was triggered on the *currently highlighted* item (rather than
   * plain selection). Use `parseAction(result)` to decode.
   *
   * Only active in fuzzy mode (where a-z would otherwise filter). The action
   * key takes precedence over filter input, mirroring shortcut-key behavior.
   */
  actionKeys?: Array<{ key: string; label: string }>;
}

/** Sentinel prefix marking an action-key result from enhancedSelect. */
const ACTION_SENTINEL = "\u0000action\u0000";
const ACTION_SEP = "\u0000";

/**
 * Decode an enhancedSelect result produced by an `actionKeys` press.
 * Returns `{ key, item }` if the result is an action, else `null`.
 */
export function parseAction(result: string | undefined): { key: string; item: string } | null {
  if (!result || !result.startsWith(ACTION_SENTINEL)) return null;
  const rest = result.slice(ACTION_SENTINEL.length);
  const sep = rest.indexOf(ACTION_SEP);
  if (sep === -1) return null;
  return { key: rest.slice(0, sep), item: rest.slice(sep + 1) };
}

class EnhancedSelectComponent {
  private title: string;
  private items: string[];
  private selectedIdx = 0;
  private scrollOffset = 0;
  private theme: any;
  private tui: any;
  private done: (result?: string) => void;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private maxVisibleRows = 16;

  /** Map of shortcut key → item index */
  private shortcutMap: Map<string, number> = new Map();

  constructor(
    title: string,
    items: string[],
    tui: any,
    theme: any,
    done: (result?: string) => void,
    private options: EnhancedSelectOptions = {},
  ) {
    this.title = title;
    this.items = items;
    this.tui = tui;
    this.theme = theme;
    this.done = done;

    // Optional pre-sort (name: case-insensitive, numeric-aware, Chinese-friendly)
    if (this.options.sort === "name") {
      this.items = [...items].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    }

    for (let i = 0; i < this.items.length; i++) {
      const key = parseShortcut(this.items[i]!);
      if (key) {
        this.shortcutMap.set(key, i);
      }
    }
  }

  // ── Fuzzy filter state ──────────────────────────────────────────────

  private filterText = "";
  /** Indices into this.items that match the current filter (only in fuzzy mode). */
  private filteredIndices: number[] = [];

  /** Return the list of items currently visible (filtered or full). */
  private get effectiveItems(): string[] {
    if (!this.options.fuzzy || this.filterText.length === 0) return this.items;
    return this.filteredIndices.map((i) => this.items[i]!);
  }

  /** Map a filtered-list index back to the original this.items index. */
  private origIndex(filteredIdx: number): number {
    if (!this.options.fuzzy || this.filterText.length === 0) return filteredIdx;
    return this.filteredIndices[filteredIdx] ?? filteredIdx;
  }

  private applyFilter(): void {
    const f = this.filterText.toLowerCase();
    this.filteredIndices = [];
    for (let i = 0; i < this.items.length; i++) {
      if (fuzzyMatch(this.items[i]!, f)) this.filteredIndices.push(i);
    }
    this.selectedIdx = 0;
    this.scrollOffset = 0;
  }

  private clearFilter(): void {
    this.filterText = "";
    this.filteredIndices = [];
    this.selectedIdx = 0;
    this.scrollOffset = 0;
  }

  handleInput(data: string): void {
    const th = this.theme;

    // ── Shortcut keys ──
    // Check single-character shortcuts (e.g. pressing "s" for "s Save").
    // Shortcuts are suppressed while a fuzzy filter is active so the user can
    // continue refining their filter string.
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      if (this.filterText.length === 0) {
        const key = data.toLowerCase();
        // Action keys: trigger an action on the currently highlighted item.
        const action = this.options.actionKeys?.find((a) => a.key.toLowerCase() === key);
        if (action) {
          const cur = this.effectiveItems[this.selectedIdx];
          if (cur !== undefined) {
            this.done(ACTION_SENTINEL + action.key.toLowerCase() + ACTION_SEP + cur);
            return;
          }
        }
        const idx = this.shortcutMap.get(key);
        if (idx !== undefined) {
          this.done(this.items[idx]);
          return;
        }
      }
      // ── Fuzzy filter input ──
      if (this.options.fuzzy) {
        this.filterText += data;
        this.applyFilter();
        this.invalidate();
        this.tui.requestRender();
        return;
      }
    }

    // ── Navigation ──
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      const len = this.effectiveItems.length;
      if (len === 0) return;
      // Cyclic: wrap from top to bottom
      if (this.selectedIdx > 0) {
        this.selectedIdx--;
      } else {
        this.selectedIdx = len - 1;
      }
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      const len = this.effectiveItems.length;
      if (len === 0) return;
      // Cyclic: wrap from bottom to top
      if (this.selectedIdx < len - 1) {
        this.selectedIdx++;
      } else {
        this.selectedIdx = 0;
      }
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.pageUp)) {
      const len = this.effectiveItems.length;
      if (len === 0) return;
      this.selectedIdx = Math.max(0, this.selectedIdx - 10);
      // Clamp to valid range
      if (this.selectedIdx >= len) this.selectedIdx = len - 1;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.pageDown)) {
      const len = this.effectiveItems.length;
      if (len === 0) return;
      this.selectedIdx = Math.min(len - 1, this.selectedIdx + 10);
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // ── Home / End ──
    if (matchesKey(data, Key.home)) {
      this.selectedIdx = 0;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.end)) {
      this.selectedIdx = this.effectiveItems.length - 1;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // ── Confirm ──
    if (matchesKey(data, Key.enter)) {
      const items = this.effectiveItems;
      if (items.length > 0) {
        this.done(items[this.selectedIdx]);
      }
      return;
    }

    // ── Cancel / backspace ──
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      // In fuzzy mode: first Escape clears the filter, second Escape cancels.
      if (this.options.fuzzy && this.filterText.length > 0) {
        this.clearFilter();
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      this.done(undefined);
      return;
    }

    if (matchesKey(data, Key.backspace)) {
      if (this.options.fuzzy && this.filterText.length > 0) {
        this.filterText = this.filterText.slice(0, -1);
        this.applyFilter();
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      return; // backspace is a no-op without an active filter
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const th = this.theme;
    const lines: string[] = [];
    const boxW = Math.min(width - 2, 76);
    const items = this.effectiveItems;

    lines.push("");

    // ── Title ──
    const title = th.fg("accent", th.bold(` ${this.title} `));
    lines.push(topBorder(boxW, title, th));

    // ── Filter indicator (fuzzy mode) ──
    if (this.options.fuzzy && this.filterText.length > 0) {
      const matchInfo = `Filter: "${this.filterText}"  → ${items.length}/${this.items.length} matches`;
      lines.push(lineInBox(th.fg("dim", matchInfo), boxW, th));
    }

    if (items.length === 0) {
      const msg = this.filterText.length > 0
        ? th.fg("dim", `  (no items match "${this.filterText}")`)
        : th.fg("dim", "  (no items)");
      lines.push(lineInBox(msg, boxW, th));
      lines.push(bottomBorder(boxW, th));
      this.cachedWidth = width;
      this.cachedLines = lines;
      return lines;
    }

    // ── Adjust scroll ──
    const maxVisible = this.maxVisibleRows;
    if (this.selectedIdx < this.scrollOffset) {
      this.scrollOffset = this.selectedIdx;
    }
    if (this.selectedIdx >= this.scrollOffset + maxVisible) {
      this.scrollOffset = this.selectedIdx - maxVisible + 1;
    }

    const visible = items.slice(
      this.scrollOffset,
      this.scrollOffset + maxVisible
    );

    // ── Render items ──
    for (let i = 0; i < visible.length; i++) {
      const item = visible[i]!;
      const idx = this.scrollOffset + i;
      const isSelected = idx === this.selectedIdx;
      const shortcut = parseShortcut(item);

      // Separator lines (───────────────)
      if (item.match(/^─+$/)) {
        lines.push(midBorder(boxW, th));
        continue;
      }

      const contentW = boxW - 6; // minus borders and prefix (3 prefix + 3 trailing pad in box)

      if (isSelected) {
        // Selected row: prefer full-width background highlight (theme.bg("selectedBg"))
        // when available; fall back to accent+bold prefix for themes without bg.
        const hasBg = typeof (th as any).bg === "function";
        if (hasBg && contentW > 0) {
          const sel = th.fg("accent", th.bold(item));
          const inner = " " + sidePad(sel, contentW) + " ";
          lines.push(th.fg("borderMuted", V) + th.bg("selectedBg", inner) + th.fg("borderMuted", V));
        } else {
          const sel = th.fg("accent", th.bold(item));
          const line = th.fg("accent", " ▶ ") + (contentW > 0 ? truncateToWidth(sel, contentW) : sel);
          lines.push(lineInBox(line, boxW, th));
        }
      } else {
        // Non-selected: shortcut key highlighted in accent, rest in text
        let styledItem: string;
        if (shortcut) {
          const keyChar = item[0]!;
          const rest = item.slice(1);
          styledItem = th.fg("accent", keyChar) + th.fg("text", rest);
        } else {
          styledItem = th.fg("text", item);
        }
        const line = "   " + truncateToWidth(styledItem, contentW);
        lines.push(lineInBox(line, boxW, th));
      }
    }

    // ── Scroll indicator ──
    if (items.length > maxVisible) {
      const from = this.scrollOffset + 1;
      const to = Math.min(this.scrollOffset + maxVisible, items.length);
      const total = items.length;
      const scrollText = th.fg("dim", `─ ${from}-${to} of ${total} ─`);
      lines.push(lineInBox(scrollText, boxW, th));
    }

    lines.push(bottomBorder(boxW, th));

    // ── Help line ──
    const hintParts: string[] = [];
    hintParts.push(th.fg("dim", "↵") + th.fg("muted", ":select"));
    hintParts.push(th.fg("dim", "↑↓") + th.fg("muted", ":navigate"));
    hintParts.push(th.fg("dim", "Esc") + th.fg("muted", ":cancel"));
    if (this.options.fuzzy) {
      hintParts.push(th.fg("dim", "⌫") + th.fg("muted", ":backspace"));
      hintParts.push(th.fg("dim", "a-z") + th.fg("muted", ":filter"));
    } else if (this.shortcutMap.size > 0) {
      const keys = Array.from(this.shortcutMap.keys()).join("/");
      hintParts.push(th.fg("dim", keys) + th.fg("muted", ":shortcut"));
    }
    if (this.options.actionKeys && this.options.actionKeys.length > 0 && this.filterText.length === 0) {
      for (const a of this.options.actionKeys) {
        hintParts.push(th.fg("dim", a.key) + th.fg("muted", ":" + a.label));
      }
    }
    lines.push("  " + hintParts.join("  "));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Show an enhanced select dialog with:
 *   - Keyboard shortcut support (single-letter prefix)
 *   - Cyclic navigation (Up wraps to bottom, Down wraps to top)
 *
 * @param ctx Extension command context
 * @param title Dialog title
 * @param items Array of option strings. Items like "s Save" can be
 *              triggered by pressing "s" directly.
 * @returns Selected item string, or undefined if cancelled
 */
export async function enhancedSelect(
  ctx: ExtensionCommandContext,
  title: string,
  items: string[],
  options?: EnhancedSelectOptions
): Promise<string | undefined> {
  if (!ctx.hasUI) {
    // Fallback to built-in select in non-TUI modes
    return ctx.ui.select(title, items);
  }

  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    const component = new EnhancedSelectComponent(title, items, tui, theme, done, options);
    return {
      handleInput: (data: string) => component.handleInput(data),
      render: (w: number) => component.render(w),
      invalidate: () => component.invalidate(),
    };
  });
}
