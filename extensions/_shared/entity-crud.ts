/**
 * Shared entity CRUD helpers for Pi extensions.
 *
 * Reduces duplication between provider, web-search, and web-proxy
 * which all manage named entities with active/archived lifecycle.
 *
 * Usage:
 *   import { selectActiveEntity, selectArchivedEntity, stampArchived, stripArchived, browseArchived } from "../_shared/entity-crud";
 *
 *   const sel = await selectActiveEntity(ctx, "Select", items, { fuzzy: true });
 *   if (!sel) return;
 *   // sel.name, sel.config
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { enhancedSelect } from "./enhanced-select";

// ── Selection ───────────────────────────────────────────────────────────

export interface SelectOptions {
  /** Enable fuzzy type-ahead filtering (pass through to enhancedSelect). */
  fuzzy?: boolean;
}

/**
 * Select an active entity by its key. Items are displayed as raw keys.
 * Returns { name, config } or undefined if cancelled/empty.
 */
export async function selectActiveEntity<T>(
  ctx: ExtensionCommandContext,
  title: string,
  active: Record<string, T>,
  options: SelectOptions = {},
): Promise<{ name: string; config: T } | undefined> {
  const names = Object.keys(active);
  if (names.length === 0) {
    ctx.ui.notify("No items configured", "info");
    return undefined;
  }
  const enhancedOpts = options.fuzzy ? { fuzzy: true as const } : undefined;
  const selected = await enhancedSelect(ctx, title, names, enhancedOpts);
  if (!selected) return undefined;
  return { name: selected, config: active[selected] };
}

/**
 * Select an archived entity by its key.
 */
export async function selectArchivedEntity<T>(
  ctx: ExtensionCommandContext,
  title: string,
  archived: Record<string, T>,
  options: SelectOptions = {},
): Promise<{ name: string; config: T } | undefined> {
  const names = Object.keys(archived);
  if (names.length === 0) {
    ctx.ui.notify("No archived items", "info");
    return undefined;
  }
  const enhancedOpts = options.fuzzy ? { fuzzy: true as const } : undefined;
  const selected = await enhancedSelect(ctx, title, names, enhancedOpts);
  if (!selected) return undefined;
  return { name: selected, config: archived[selected] };
}

// ── Pure data transforms ───────────────────────────────────────────────

/** Add an archivedAt timestamp to an entity. */
export function stampArchived<T>(entity: T): T & { archivedAt: string } {
  return { ...entity, archivedAt: new Date().toISOString() };
}

/** Remove the archivedAt field from an entity. */
export function stripArchived<T extends { archivedAt?: string }>(entity: T): Omit<T, "archivedAt"> {
  const { archivedAt: _a, ...rest } = entity;
  return rest;
}

// ── Archived browser ────────────────────────────────────────────────────

export interface BrowseArchivedCallbacks<T> {
  /** Format function for archived entries. Default: raw key. */
  format?: (name: string, config: T) => string;
  /** Called when user picks "Restore". */
  onRestore: (name: string) => Promise<void>;
  /** Called when user picks "Delete". */
  onDelete: (name: string) => Promise<void>;
  /**
   * Extra action entries shown before Restore/Delete.
   * Each has a label, a match prefix, and a handler.
   * The handler receives the entity key.
   */
  extraActions?: Array<{
    label: string;
    match: string;
    run: (name: string) => Promise<void>;
  }>;
  /** Enable fuzzy filtering on the archived list. */
  fuzzy?: boolean;
}

function defaultFormat(name: string): string {
  return name;
}

// ── Archive / Restore workflow helpers ──────────────────────────────────

/**
 * Move an entity from active to archived.
 * Returns the new active key (null if the archived entity was active).
 * Caller must persist the updated records afterwards.
 */
export function archiveEntity<T>(
  key: string,
  active: Record<string, T>,
  archived: Record<string, T & { archivedAt: string }>,
  activeKey: string | null,
): string | null {
  archived[key] = stampArchived(active[key]);
  delete active[key];
  return activeKey === key ? null : activeKey;
}

/**
 * Move an entity from archived back to active.
 * Returns the restored entity (without archivedAt).
 * Caller must persist the updated records afterwards.
 */
export function restoreEntity<T>(
  key: string,
  active: Record<string, T>,
  archived: Record<string, T & { archivedAt: string }>,
): T {
  const entity = stripArchived(archived[key]);
  delete archived[key];
  active[key] = entity;
  return entity;
}

/**
 * Generic archived-item browser:
 *   1. Select an archived entity from the list (with optional fuzzy filtering)
 *   2. Show action menu (extra actions → Restore → Delete → Back)
 *   3. Execute the chosen action
 *
 * The `format` callback determines how each archived item is displayed.
 * The caller must handle mapping from formatted display back to the entity
 * key — typically by including the key in the format string (e.g. "name — url")
 * and splitting it in the callback.
 *
 * For raw-key browsing (no format), the selected item is the key directly.
 */
export async function browseArchived<T extends { archivedAt?: string }>(
  ctx: ExtensionCommandContext,
  archived: Record<string, T>,
  callbacks: BrowseArchivedCallbacks<T>,
): Promise<void> {
  const names = Object.keys(archived);
  if (names.length === 0) {
    ctx.ui.notify("No archived items", "info");
    return;
  }

  const fmt = callbacks.format ?? defaultFormat;
  const items = names.map((n) => fmt(n, archived[n]));
  const enhancedOpts = callbacks.fuzzy ? { fuzzy: true as const } : undefined;

  const selected = await enhancedSelect(ctx, "Archived items", items, enhancedOpts);
  if (!selected) return;

  // Map back to key: if format was used, caller must match; else use selected directly
  const key = callbacks.format
    ? (names.find((n) => fmt(n, archived[n]) === selected) ?? selected)
    : selected;

  const entry = archived[key];
  if (!entry) { ctx.ui.notify(`Item not found: ${key}`, "error"); return; }

  // Build action menu
  const menu: string[] = [];
  if (callbacks.extraActions) {
    for (const a of callbacks.extraActions) menu.push(a.label);
    menu.push("───────────────");
  }
  menu.push(
    "Restore — Restore and activate",
    "Delete  — Permanently delete",
    "← Back",
  );

  const action = await enhancedSelect(ctx, key, menu);
  if (!action || action.startsWith("←")) return;

  if (action.startsWith("Restore")) { await callbacks.onRestore(key); return; }
  if (action.startsWith("Delete")) {
    const confirmed = await ctx.ui.confirm("Confirm delete", `Permanently delete "${key}"?`);
    if (!confirmed) { ctx.ui.notify("Cancelled", "info"); return; }
    await callbacks.onDelete(key);
    return;
  }

  // Check extra actions
  if (callbacks.extraActions) {
    for (const a of callbacks.extraActions) {
      if (action.startsWith(a.match)) { await a.run(key); return; }
    }
  }
}
