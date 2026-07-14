/**
 * Shared JSON file I/O utilities for Pi extensions.
 *
 * Provides atomic write, backup, and safe read with consistent patterns.
 * Import: import { … } from "../_shared/json-io"
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

// ── Timestamp ───────────────────────────────────────────────────────────

/** Compact timestamp for backup file names, e.g. "20260616T143045". */
export function timestampForBackup(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

/** ISO-8601 timestamp string, e.g. "2026-06-17T12:30:45.123Z". */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Compact timestamp for file/dir names, e.g. "20260617T123045". */
export function tsCompact(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 15);
}

// ── Safe read ──────────────────────────────────────────────────────────

/** Read JSON with a fallback default. Missing/corrupt file returns fallback. */
export function readJsonSafe<T>(file: string, fallback: T): T {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return { ...fallback, ...data };
  } catch (_error) {
    return fallback;
  }
}

// ── Ensure directory ───────────────────────────────────────────────────

/** Create directory (and parents) if it doesn't exist. */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

// ── Atomic JSON write ──────────────────────────────────────────────────

export interface WriteJsonOptions {
  /** If true, back up the existing file before overwriting. */
  backup?: boolean;
  /**
   * When backing up, keep at most this many `<file>.bak-*` snapshots
   * (newest kept, oldest pruned). Defaults to DEFAULT_KEEP_BACKUPS.
   * Set to 0 to disable pruning.
   */
  keepBackups?: number;
}

/** Default number of timestamped backups retained per file. */
export const DEFAULT_KEEP_BACKUPS = 5;

/**
 * Atomically write a JSON file:
 *  1. Write to a temp file
 *  2. Validate the temp file parses as JSON
 *  3. Optionally back up the existing file
 *  4. Rename temp → target
 *
 * On failure the temp file is cleaned up and the original is preserved.
 */
export function writeJsonAtomic(
  file: string,
  value: unknown,
  options: WriteJsonOptions = {},
): void {
  ensureDir(dirname(file));
  const dir = dirname(file);
  const tempFile = `${dir}/.${basename(file)}.${process.pid}.${Date.now()}.tmp`;
  try {
    const text = JSON.stringify(value, null, 2);
    writeFileSync(tempFile, text, "utf8");
    // Validate what we just wrote
    JSON.parse(readFileSync(tempFile, "utf8"));

    if (options.backup && existsSync(file)) {
      copyFileSync(file, `${file}.bak-${timestampForBackup()}`);
      const keep = options.keepBackups ?? DEFAULT_KEEP_BACKUPS;
      if (keep > 0) pruneBackups(file, keep);
    }
    renameSync(tempFile, file);
  } catch (error) {
    try {
      if (existsSync(tempFile)) unlinkSync(tempFile);
    } catch (_cleanupError) {
      // Best-effort cleanup only; preserve the original write failure.
    }
    throw error;
  }
}

// ── Backup rotation ────────────────────────────────────────────────────

/**
 * Prune `<file>.bak-*` snapshots, keeping the newest `keep` by mtime.
 * Safe no-op when the directory is missing or fewer than `keep` exist.
 * Returns the list of removed backup paths.
 */
export function pruneBackups(file: string, keep: number): string[] {
  if (keep < 0) return [];
  const dir = dirname(file);
  const prefix = `${basename(file)}.bak-`;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const backups = entries
    .filter((n) => n.startsWith(prefix))
    .map((n) => {
      const full = join(dir, n);
      let mtime = 0;
      try {
        mtime = statSync(full).mtimeMs;
      } catch {
        // Fall back to lexical order via name when stat fails.
      }
      return { full, name: n, mtime };
    })
    // Newest first: primary by mtime, tie-break by name descending.
    .sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1));

  const removed: string[] = [];
  for (const b of backups.slice(keep)) {
    try {
      rmSync(b.full, { recursive: true, force: true });
      removed.push(b.full);
    } catch {
      // Best-effort; skip files we cannot remove.
    }
  }
  return removed;
}

/**
 * Prune timestamped snapshot directories/files matching `<prefix>*` inside
 * `dir`, keeping the newest `keep` by mtime. Use for backup dirs that hold
 * timestamped snapshots (e.g. github-skills/backups/20260630120401).
 * Returns the list of removed paths.
 */
export function pruneSnapshots(dir: string, keep: number, prefix = ""): string[] {
  if (keep < 0) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const snaps = entries
    .filter((n) => n.startsWith(prefix))
    .map((n) => {
      const full = join(dir, n);
      let mtime = 0;
      try {
        mtime = statSync(full).mtimeMs;
      } catch {
        // Ignore stat failures; name order is the fallback.
      }
      return { full, name: n, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1));

  const removed: string[] = [];
  for (const s of snaps.slice(keep)) {
    try {
      rmSync(s.full, { recursive: true, force: true });
      removed.push(s.full);
    } catch {
      // Best-effort.
    }
  }
  return removed;
}

// ── Simple JSON write (no atomic guarantee, no backup) ─────────────────

/** Write JSON file directly (no atomic rename, no backup). For non-critical data. */
export function writeJson(file: string, value: unknown): void {
  ensureDir(dirname(file));
  writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

// ── Append JSONL ───────────────────────────────────────────────────────

/** Append a JSON line to a JSONL file, creating the directory if needed. */
export function appendJsonl(file: string, value: unknown): void {
  ensureDir(dirname(file));
  const { appendFileSync } = require("node:fs");
  appendFileSync(file, JSON.stringify(value) + "\n", "utf8");
}

// ── Internal helper (avoid importing path.basename at module level) ────

function basename(file: string): string {
  return file.split(/[\\/]/).pop() || file;
}
