/**
 * Shared Edit Draft Menu helper for Pi extensions.
 *
 * Three extensions (provider, web-search, web-proxy) share the same
 * "edit draft in a while-true loop with s Save / x Discard" pattern.
 * This module extracts the boilerplate.
 *
 * Usage:
 *   import { editDraft, field } from "../_shared/edit-menu";
 *
 *   const result = await editDraft(ctx, "Edit proxy",
 *     [
 *       field("✎ Name", () => draftName, async (ctx) => {
 *         const val = await ctx.ui.input(`Name [${draftName}]:`);
 *         if (val) draftName = val.trim();
 *       }),
 *       field("✎ URL",  () => draft.url, async (ctx) => {
 *         const url = await ctx.ui.input(`URL [${draft.url}]:`);
 *         if (url) draft.url = normalize(url);
 *       }),
 *     ],
 *     {
 *       beforeSave: async (ctx) => {
 *         if (!draftName) { ctx.ui.notify("Name required", "warning"); return false; }
 *         return true;
 *       }
 *     }
 *   );
 *   if (result === "save") { saveConfig(); }
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { enhancedSelect } from "./enhanced-select";

// ── Field Definition ──────────────────────────────────────────────────

export interface EditField {
  /** Label prefix shown before ": " in the menu row, e.g. "✎ Name" */
  label: string;
  /** Return the full display row, e.g. "✎ Name: myValue" */
  row: () => string;
  /** Handler called when this field is selected from the menu */
  edit: (ctx: ExtensionCommandContext) => Promise<void>;
}

/** Factory: create a simple EditField with a label, getter, and handler. */
export function field(
  label: string,
  display: () => string,
  edit: (ctx: ExtensionCommandContext) => Promise<void>
): EditField {
  return { label, row: () => `${label}: ${display()}`, edit };
}

// ── Edit Loop ─────────────────────────────────────────────────────────

export interface EditDraftOptions {
  /** Label for save action (default "s Save") */
  saveLabel?: string;
  /** Label for discard action (default "x Discard") */
  discardLabel?: string;
  /** Validation callback before save. Return false to stay in the loop. */
  beforeSave?: (ctx: ExtensionCommandContext) => Promise<boolean>;
}

/**
 * Run an edit-draft menu loop.
 *
 * @param ctx        Extension command context
 * @param titleOrFn  Dialog title, or a function returning the title
 * @param fields     Array of editable fields
 * @param opts       Customise labels and add save validation
 *
 * @returns "save" if user confirmed (validation passed), "discard" if
 *          cancelled, undefined if dialog closed (Escape).
 */
export async function editDraft(
  ctx: ExtensionCommandContext,
  titleOrFn: string | (() => string),
  fields: EditField[],
  opts: EditDraftOptions = {}
): Promise<"save" | "discard" | undefined> {
  const saveLabel = opts.saveLabel ?? "s Save";
  const discardLabel = opts.discardLabel ?? "x Discard";
  const getTitle = typeof titleOrFn === "function" ? titleOrFn : () => titleOrFn;

  while (true) {
    const items = [
      ...fields.map((f) => f.row()),
      "───────────────",
      saveLabel,
      discardLabel,
    ];

    const choice = await enhancedSelect(ctx, getTitle(), items);
    if (!choice) return undefined;
    if (choice === saveLabel) {
      if (opts.beforeSave) {
        const ok = await opts.beforeSave(ctx);
        if (!ok) continue;
      }
      return "save";
    }
    if (choice === discardLabel) return "discard";

    // Dispatch to the matching field
    for (const f of fields) {
      if (choice.startsWith(f.label + ":")) {
        await f.edit(ctx);
        break;
      }
    }
  }
}
