#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const IMPORT_FILE =
  process.env.GBRAIN_IMPORT_SOURCE ||
  path.join(os.homedir(), "node_modules/gbrain/src/commands/import.ts");
const APPLY = process.argv.includes("--apply");
const IMPORT_ANCHOR =
  "  isImageFilePath as isImageFilePathFromSync,\n  pruneDir,";
const IMPORT_REPLACEMENT =
  "  isImageFilePath as isImageFilePathFromSync,\n  isSyncable,\n  pruneDir,";
const WALKER_ANCHOR =
  "    if (!isCollectibleForWalker(rel, strategy, multimodalOn)) continue;\n    const full = join(dir, rel);";
const WALKER_REPLACEMENT =
  "    if (!isCollectibleForWalker(rel, strategy, multimodalOn)) continue;\n" +
  "    if (!isSyncable(rel, { strategy })) continue;\n" +
  "    const full = join(dir, rel);";

if (!existsSync(IMPORT_FILE)) {
  throw new Error(`Cannot inspect GBrain import source: ${IMPORT_FILE}`);
}

let source = readFileSync(IMPORT_FILE, "utf8");
const hasImport = /\bisSyncable,\s*\n\s*pruneDir,/.test(source);
const hasWalkerGuard =
  source.includes("if (!isSyncable(rel, { strategy })) continue;");

if (hasImport && hasWalkerGuard) {
  console.log("GBrain full-import filter is compatible.");
  process.exit(0);
}

if (!APPLY) {
  console.error(
    "GBrain's full-import walker can admit governance/raw Markdown. " +
      "Run `node ops/ensure-gbrain-sync-filter.mjs --apply` after reviewing the installed version.",
  );
  process.exit(1);
}

if (!hasImport) {
  if (!source.includes(IMPORT_ANCHOR)) {
    throw new Error("GBrain import layout changed; cannot add isSyncable safely.");
  }
  source = source.replace(IMPORT_ANCHOR, IMPORT_REPLACEMENT);
}
if (!hasWalkerGuard) {
  if (!source.includes(WALKER_ANCHOR)) {
    throw new Error("GBrain Git walker layout changed; cannot add the filter safely.");
  }
  source = source.replace(WALKER_ANCHOR, WALKER_REPLACEMENT);
}

writeFileSync(IMPORT_FILE, source, "utf8");
console.log(`Patched GBrain full-import filtering: ${IMPORT_FILE}`);
