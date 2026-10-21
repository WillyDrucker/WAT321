// WAT321 audit measurement. Prints the static facts one audit pass needs
// so the pass spends its budget on judgment: size census, directory
// census, exports with no caller, files nobody imports, stale file
// references in comments, the banned-pattern matrix, the settings
// dual-anchoring check, and byte-identical duplicates. Reports
// candidates, decides nothing. Run: npm run audit:scan
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const SIZE_TARGET = 300;
const SIZE_CEILING = 350;
const DIR_LOOK_TRIGGER = 25;
const HEADER_LOOK = 20;
const BLOCK_LOOK = 15;
/** Files whose version markers are the sanctioned legacy sweep, not
 * release stamps. */
const VERSION_MARKER_SANCTIONED = new Set([
  "src/shared/workspaceScopeHeal.ts",
  "src/shared/resetSettings.ts",
  "src/WAT321_EPIC_HANDSHAKE/repair/legacyMigration.ts",
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mjs)$/.test(name)) out.push(p);
  }
  return out;
}
const files = walk(SRC).sort();
const rel = (p) => relative(ROOT, p).replace(/\\/g, "/");
const text = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const lines = (f) => text.get(f).split(/\r?\n/).length;
const isCommentLine = (l) => /^\s*(\/\/|\*|\/\*)/.test(l);

// ---- size census
console.log("## Size census");
const sized = files.map((f) => [lines(f), rel(f)]).sort((a, b) => b[0] - a[0]);
const buckets = { overCeiling: 0, overTarget: 0, b201to300: 0, upto200: 0 };
for (const [n] of sized) {
  if (n > SIZE_CEILING) buckets.overCeiling++;
  else if (n > SIZE_TARGET) buckets.overTarget++;
  else if (n > 200) buckets.b201to300++;
  else buckets.upto200++;
}
console.log(
  `files=${files.length} total_lines=${sized.reduce((a, [n]) => a + n, 0)} target=${SIZE_TARGET} ceiling=${SIZE_CEILING} buckets=${JSON.stringify(buckets)}`
);
console.log(`over ${SIZE_TARGET}:`);
for (const [n, p] of sized.filter(([n]) => n > SIZE_TARGET)) console.log(`  ${String(n).padStart(4)} ${p}`);

// ---- directory census
console.log(`\n## Directory census (files per folder, ${DIR_LOOK_TRIGGER} is the trigger to look)`);
const dirCount = new Map();
for (const f of files) {
  const d = rel(dirname(f));
  dirCount.set(d, (dirCount.get(d) ?? 0) + 1);
}
for (const [d, n] of [...dirCount].sort((a, b) => b[1] - a[1])) {
  if (n > 8) console.log(`  ${String(n).padStart(3)} ${d}${n > DIR_LOOK_TRIGGER ? "  <- look" : ""}`);
}

// ---- re-exports: barrels and name-only forwards
console.log("\n## Re-exports (barrels and name-only forwards)");
const barrelRe = /^export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+/gm;
const forwardRe = /^export\s+(?:type\s+)?\{([^}]+)\};?\s*$/gm;
const importRe = /^import\s+(?:type\s+)?\{([^}]+)\}\s+from/gm;
const bareName = (part) => part.replace(/^\s*type\s+/, "").split(/\s+as\s+/)[0].trim();
let reexports = 0;
for (const f of files) {
  const src = text.get(f);
  const imported = new Set();
  for (const m of src.matchAll(importRe)) {
    for (const part of m[1].split(",")) {
      const name = part.replace(/^\s*type\s+/, "").split(/\s+as\s+/).pop().trim();
      if (name) imported.add(name);
    }
  }
  const report = (line) => {
    reexports++;
    console.log(`  ${rel(f)}: ${line.trim()}`);
  };
  for (const m of src.matchAll(barrelRe)) report(m[0]);
  for (const m of src.matchAll(forwardRe)) {
    const names = m[1].split(",").map(bareName).filter(Boolean);
    if (names.some((n) => imported.has(n))) report(m[0]);
  }
}
console.log(`  (${reexports} candidates)`);

// ---- exports with no caller outside their file
console.log("\n## Exports with no reference outside their own file");
const exportRe = /^export\s+(?:async\s+)?(?:function\*?|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
const exportListRe = /^export\s+(?:type\s+)?\{([^}]+)\}/gm;
const ENTRY = new Set(["activate", "deactivate"]);
// Per-file source with comment lines dropped, so a name that only
// survives in another file's comment does not count as a reference.
const code = new Map(
  [...text].map(([f, t]) => [f, t.split(/\r?\n/).filter((l) => !isCommentLine(l)).join("\n")])
);
let deadExports = 0;
for (const f of files) {
  const src = text.get(f);
  const names = new Set();
  for (const m of src.matchAll(exportRe)) names.add(m[1]);
  for (const m of src.matchAll(exportListRe)) {
    for (const part of m[1].split(",")) {
      const n = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
      if (n) names.add(n);
    }
  }
  for (const name of names) {
    if (ENTRY.has(name) && /extension\.ts$/.test(f)) continue;
    const re = new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`, "g");
    let refs = 0;
    for (const [g] of text) {
      if (g === f) continue;
      // A mention inside a comment is prose, not a caller.
      refs += (code.get(g).match(re) ?? []).length;
    }
    if (refs === 0) {
      deadExports++;
      console.log(`  ${rel(f)}: ${name}`);
    }
  }
}
console.log(`  (${deadExports} candidates)`);

// ---- files nobody imports
console.log("\n## Files no other file imports");
const ENTRY_FILES = new Set([
  "src/extension.ts",
  "src/WAT321_MCP_SERVER/bin/channel.mjs",
  "src/WAT321_EPIC_HANDSHAKE/bin/stage-clipboard.mjs",
]);
for (const f of files) {
  const r = rel(f);
  if (ENTRY_FILES.has(r)) continue;
  const stem = basename(f).replace(/\.(ts|mjs)$/, "").replace(/\./g, "\\.");
  const re = new RegExp(
    `from\\s+["'][^"']*\\/${stem}(?:\\.js|\\.mjs)?["']|import\\(["'][^"']*\\/${stem}(?:\\.js|\\.mjs)?["']|require\\(["'][^"']*\\/${stem}`
  );
  let imported = false;
  for (const [g, t] of text) {
    if (g === f) continue;
    if (re.test(t)) {
      imported = true;
      break;
    }
  }
  if (!imported) console.log(`  ${r}`);
}

// ---- stale file references inside comments
console.log("\n## Backticked source or doc file names in comments that do not exist");
const known = new Set(files.map((f) => basename(f)));
const repoFiles = new Set();
(function walkAll(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "out") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkAll(p);
    else repoFiles.add(name);
  }
})(ROOT);
/** A bare file name only has to exist somewhere in the repo. A ref
 * with a directory must resolve from the referencing file's folder,
 * one of its parents, `src/`, or the repo root. */
function refExists(fromFile, ref) {
  if (!ref.includes("/")) return known.has(basename(ref)) || repoFiles.has(basename(ref));
  const bases = [SRC, ROOT];
  for (let d = dirname(fromFile); d.startsWith(ROOT); d = dirname(d)) {
    bases.push(d);
    if (d === ROOT) break;
  }
  return bases.some((b) => existsSync(join(b, ref)));
}
const seenStale = new Set();
for (const f of files) {
  for (const line of text.get(f).split(/\r?\n/)) {
    // A line that says "upstream" points into another repository.
    if (/\bupstream\b/i.test(line)) continue;
    for (const m of line.matchAll(/`([A-Za-z0-9_./-]+\.(?:ts|mjs|md))`/g)) {
      if (refExists(f, m[1])) continue;
      const key = `${rel(f)} -> ${m[1]}`;
      if (seenStale.has(key)) continue;
      seenStale.add(key);
      console.log(`  ${key}`);
    }
  }
}

// ---- banned patterns
console.log("\n## Banned-pattern matrix");
const patterns = [
  ["console.log", (l) => /console\.log\(/.test(l)],
  ["em dash / unicode arrow", (l) => /[—→←↑↓↔↕]/.test(l)],
  ["`any` escape in code", (l) => !isCommentLine(l) && /:\s*any\b|as any\b|<any>/.test(l)],
  [
    "row discriminator named `kind:` on a QuickPick row",
    (l, t) => t.includes("QuickPickItem") && /^\s+kind:\s*"(?!separator)/.test(l),
  ],
  ["TODO / FIXME / TEMPORARY", (l) => /\b(TODO|FIXME|TEMPORARY)\b/.test(l)],
  [
    "chronology in comments",
    (l) =>
      isCommentLine(l) &&
      (/\b(formerly|was previously|were previously|has been moved|renamed from|migrated from|was replaced|no longer (needs|needed|uses|used|imports|requires|aborts|lives|ships))\b/i.test(l) ||
        // "X used to <verb>" is chronology, "is used to <verb>" is purpose.
        /(?<!\b(?:is|are|be|been|being|was|were|get|gets|got) )\bused to\b/.test(l)),
  ],
  [
    "version stamp in comment",
    // Quoted versions are input shapes a parser documents, not stamps.
    (l, _t, f) =>
      !VERSION_MARKER_SANCTIONED.has(rel(f)) && isCommentLine(l) && /(?<!["'])\bv?1\.[0-9]+\.[0-9]+\b(?!["'])/.test(l),
  ],
  ["raw writeFileSync", (l) => /\bwriteFileSync\(/.test(l)],
  ["semicolon inside a comment sentence", (l) => isCommentLine(l) && /\s[^`]*[a-z];\s+[a-z]/.test(l)],
];
for (const [label, test] of patterns) {
  const hits = [];
  for (const f of files) {
    const t = text.get(f);
    t.split(/\r?\n/).forEach((l, i) => {
      if (test(l, t, f)) hits.push(`${rel(f)}:${i + 1}`);
    });
  }
  console.log(`  ${label}: ${hits.length}`);
  for (const h of hits.slice(0, 25)) console.log(`      ${h}`);
  if (hits.length > 25) console.log(`      ... ${hits.length - 25} more`);
}

// ---- comment volume
console.log(`\n## Comment volume (module header over ${HEADER_LOOK} lines, other comment blocks over ${BLOCK_LOOK})`);
// Every comment block as [startLine, lineCount]: a block comment runs
// from its opening line to the line that closes it, and a run of
// whole-line `//` comments is one block.
function commentBlocks(src) {
  const out = [];
  const ls = src.split(/\r?\n/);
  for (let i = 0; i < ls.length; i++) {
    if (/^\s*\/\*/.test(ls[i])) {
      let j = i;
      while (j < ls.length && !ls[j].includes("*/")) j++;
      out.push([i + 1, j - i + 1]);
      i = j;
    } else if (/^\s*\/\//.test(ls[i])) {
      let j = i;
      while (j + 1 < ls.length && /^\s*\/\//.test(ls[j + 1])) j++;
      out.push([i + 1, j - i + 1]);
      i = j;
    }
  }
  return out;
}
// The module header is the first comment block that precedes the first
// line of non-import code. Null when the file opens with code.
function moduleHeader(src, blocks) {
  const ls = src.split(/\r?\n/);
  let firstCode = ls.length + 1;
  let inImport = false;
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    if (/^#!/.test(l)) continue;
    if (inImport) {
      if (/;\s*$/.test(l)) inImport = false;
      continue;
    }
    if (/^\s*$/.test(l) || isCommentLine(l)) continue;
    if (/^import\b/.test(l)) {
      inImport = !/;\s*$/.test(l);
      continue;
    }
    firstCode = i + 1;
    break;
  }
  return blocks.find(([start]) => start < firstCode) ?? null;
}
const longHeaders = [];
const longBlocks = [];
for (const f of files) {
  const src = text.get(f);
  const blocks = commentBlocks(src);
  const header = moduleHeader(src, blocks);
  if (header !== null && header[1] > HEADER_LOOK) longHeaders.push([header[1], `${rel(f)}:${header[0]}`]);
  for (const b of blocks) {
    if (b !== header && b[1] > BLOCK_LOOK) longBlocks.push([b[1], `${rel(f)}:${b[0]}`]);
  }
}
for (const [label, list] of [["module headers", longHeaders], ["other comment blocks", longBlocks]]) {
  list.sort((a, b) => b[0] - a[0]);
  console.log(`  ${label}: ${list.length}`);
  for (const [n, where] of list.slice(0, 25)) console.log(`      ${String(n).padStart(3)} ${where}`);
  if (list.length > 25) console.log(`      ... ${list.length - 25} more`);
}

// ---- settings dual-anchoring
console.log("\n## Settings dual-anchoring (application-scope keys)");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
// `contributes.configuration` is an array of titled sections, each
// with its own `properties`. Reading it as one object checks nothing.
const sections = [].concat(pkg.contributes?.configuration ?? []);
const props = Object.assign({}, ...sections.map((s) => s.properties ?? {}));
const appKeys = Object.entries(props)
  .filter(([, v]) => v.scope === "application")
  .map(([k]) => k);
const heal = readFileSync(join(SRC, "shared/workspaceScopeHeal.ts"), "utf8");
const reset = readFileSync(join(SRC, "shared/resetSettings.ts"), "utf8");
// Both sweeps name keys through `SETTING.<constant>`, never as string
// literals, so resolve each key to its constant first. A key with no
// constant is its own finding: the registry is the canonical home.
const settingConstants = new Map();
for (const m of readFileSync(join(SRC, "engine/settingsKeys.ts"), "utf8").matchAll(
  /^\s*([A-Za-z_$][\w$]*):\s*"([^"]+)"/gm
)) {
  settingConstants.set(m[2], m[1]);
}
for (const k of appKeys) {
  const short = k.replace(/^wat321\./, "");
  const constant = settingConstants.get(short);
  if (constant === undefined) {
    console.log(`  ${k}: no SETTING constant in engine/settingsKeys.ts`);
    continue;
  }
  const ref = new RegExp(`\\bSETTING\\.${constant}\\b`);
  const inHeal = ref.test(heal);
  const inReset = ref.test(reset);
  if (!inHeal || !inReset) console.log(`  ${k}: heal=${inHeal} reset=${inReset}`);
}
console.log(`  (${appKeys.length} application-scope keys checked)`);

// ---- byte-identical duplicates
console.log("\n## Byte-identical files");
const byHash = new Map();
for (const f of files) {
  const h = createHash("sha1").update(text.get(f)).digest("hex");
  byHash.set(h, [...(byHash.get(h) ?? []), rel(f)]);
}
for (const group of byHash.values()) if (group.length > 1) console.log(`  ${group.join(" == ")}`);
console.log("\n(done)");
