#!/usr/bin/env node
/**
 * sync-shared.mjs — keep the packaged extension files in sync with the
 * canonical copies in your local Pi install.
 *
 * The package vendors `extensions/provider/index.ts` plus a handful of
 * `extensions/_shared/*` helpers. Those helpers are edited in-place in the
 * live Pi install (`~/.pi/agent/extensions`), so the vendored copies drift
 * over time. This script copies the canonical files into the package and can
 * verify there is no drift before a release.
 *
 * Usage:
 *   node scripts/sync-shared.mjs            # copy canonical → package
 *   node scripts/sync-shared.mjs --check    # exit 1 if any file differs
 *   node scripts/sync-shared.mjs --source <dir>   # override canonical dir
 *
 * Source resolution order:
 *   1. --source <dir>
 *   2. $PI_EXTENSIONS_DIR
 *   3. ~/.pi/agent/extensions
 */

import { readFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

// ── Files vendored into this package (relative to the extensions/ dir) ──
const FILES = [
  "provider/index.ts",
  "_shared/box-drawing.ts",
  "_shared/enhanced-select.ts",
  "_shared/entity-crud.ts",
  "_shared/edit-menu.ts",
  "_shared/json-io.ts",
  "_shared/fetch-utils.ts",
];

// ── Paths ──
const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageExtDir = resolve(scriptDir, "..", "extensions");

function resolveSource(argv) {
  const flagIdx = argv.indexOf("--source");
  if (flagIdx !== -1 && argv[flagIdx + 1]) return resolve(argv[flagIdx + 1]);
  if (process.env.PI_EXTENSIONS_DIR) return resolve(process.env.PI_EXTENSIONS_DIR);
  return join(homedir(), ".pi", "agent", "extensions");
}

function read(path) {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function main() {
  const argv = process.argv.slice(2);
  const checkMode = argv.includes("--check");
  const sourceDir = resolveSource(argv);

  if (!existsSync(sourceDir)) {
    console.error(`✗ Canonical source dir not found: ${sourceDir}`);
    console.error("  Set --source <dir> or $PI_EXTENSIONS_DIR.");
    process.exit(2);
  }

  const drift = [];
  const missing = [];
  let copied = 0;

  for (const rel of FILES) {
    const src = join(sourceDir, rel);
    const dst = join(packageExtDir, rel);
    const srcContent = read(src);

    if (srcContent === null) {
      missing.push(rel);
      continue;
    }

    if (checkMode) {
      const dstContent = read(dst);
      if (dstContent !== srcContent) drift.push(rel);
    } else {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      copied++;
      console.log(`  synced  ${rel}`);
    }
  }

  if (missing.length) {
    console.error(`✗ Missing in canonical source (${sourceDir}):`);
    for (const m of missing) console.error(`    ${m}`);
    process.exit(2);
  }

  if (checkMode) {
    if (drift.length) {
      console.error(`✗ Drift detected in ${drift.length} file(s):`);
      for (const d of drift) console.error(`    ${d}`);
      console.error("  Run: node scripts/sync-shared.mjs");
      process.exit(1);
    }
    console.log(`✓ In sync (${FILES.length} files) with ${sourceDir}`);
    return;
  }

  console.log(`✓ Synced ${copied}/${FILES.length} files from ${sourceDir}`);
}

main();
