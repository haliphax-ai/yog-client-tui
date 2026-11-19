#!/usr/bin/env node
/**
 * Comment column formatter — a repo dev helper, not part of the runtime.
 *
 * Within each comment block (lines beginning with `*`, `//`, or `#`),
 * "label <spaces> description" lines (and their indented continuation
 * lines) are aligned so every description starts at the same column.
 * Prose and code are left untouched.
 *
 * Usage:
 *   node helpers/align-columns.mjs <file...> [options]
 *
 * Options:
 *   --column N  target description column (default: longest label + 2)
 *   --check     report files that would change and exit 1; write nothing
 *   -h/--help   show this help
 */

import { readFileSync, writeFileSync } from "node:fs";

const HELP = `Usage:
  node helpers/align-columns.mjs <file...> [options]

Aligns "label <spaces> description" comment lines within each comment block
to a common description column. Continuation lines (indented text under a
label line) follow the same column. Only comment lines are touched; prose
and code are left alone.

Options:
  --column N   target description column (default: longest label + 2)
  --check      exit 1 if any file would change, without writing
  -h, --help  show this help
`;

const args = process.argv.slice(2);
let check = false;
let explicitColumn = null;
const files = [];
for (const arg of args) {
  if (arg === "--check") {
    check = true;
  } else if (arg.startsWith("--column=")) {
    explicitColumn = Number(arg.slice("--column=".length));
  } else if (arg === "-h" || arg === "--help") {
    process.stdout.write(HELP);
    process.exit(0);
  } else {
    files.push(arg);
  }
}

if (files.length === 0) {
  process.stderr.write("usage: node helpers/align-columns.mjs <file...> [--check] [--column=N]\n");
  process.exit(2);
}

/** True when a line begins a comment (after leading whitespace). */
function isCommentLine(line) {
  return /^(\s*)(\*|\/\/|#)/.test(line);
}

/**
 * One parsed block line: a LABEL line ("label<2+ spaces>description"), a
 * CONTinuation line (2+ spaces of body under an active label), or an
 * OTHER line (prose/code) that closes the active label run.
 */
const LABEL = "label";
const CONT = "cont";
const OTHER = "other";

/** Split a block line into its comment furniture and its body. */
function partsOf(line) {
  const m = line.match(/^(\s*)(\*|\/\/|#)(\s*)/);
  if (m === null) return { lead: "", marker: "", indent: "", baseLen: 0, body: line };
  const [, lead, marker, indent] = m;
  const baseLen = lead.length + marker.length + indent.length;
  return {
    lead,
    marker,
    indent,
    baseLen,
    body: line.slice(baseLen),
  };
}

/** Parse a comment block into label/continuation/other records. */
function parseBlock(block) {
  const parsed = [];
  let active = false;
  for (const line of block) {
    const { lead, marker, indent, baseLen, body } = partsOf(line);
    const fm = /^(.*?)\s{2,}(\S.*)$/.exec(body);
    if (fm !== null) {
      active = true;
      parsed.push({
        type: LABEL,
        prefix: lead + marker + indent,
        label: fm[1],
        desc: fm[2],
        labelEnd: baseLen + fm[1].length,
      });
    } else if (active && /^\s{2,}\S/.test(body)) {
      parsed.push({ type: CONT, lead, marker, baseLen, body });
    } else {
      active = false;
      parsed.push({ type: OTHER });
    }
  }
  return parsed;
}

/** The aligned replacement for one parsed record (OTHER keeps its line). */
function alignedLineOf(p, original, target) {
  if (p.type === LABEL) return labelLineOf(p, target);
  if (p.type === CONT) return contLineOf(p, target);
  return original;
}

/** The aligned label line: description pinned at the target column. */
function labelLineOf(p, target) {
  const pad = Math.max(2, target - p.labelEnd);
  return p.prefix + p.label + " ".repeat(pad) + p.desc;
}

/** The aligned continuation line: body pinned at the target column. */
function contLineOf(p, target) {
  const pad = Math.max(0, target - p.baseLen);
  return p.lead + p.marker + " ".repeat(pad) + p.body.trimStart();
}

/**
 * Rebuild one comment block so label/description lines (and their
 * continuations) share a column. Returns the new block, or the original
 * array when nothing changes.
 */
function alignBlock(block, explicitColumn) {
  const parsed = parseBlock(block);
  const labels = parsed.filter((p) => p.type === LABEL);
  if (labels.length === 0) return block;
  const maxLabelEnd = Math.max(...labels.map((l) => l.labelEnd));
  const target = explicitColumn ?? maxLabelEnd + 2;

  const out = [];
  for (let i = 0; i < block.length; i++) {
    out.push(alignedLineOf(parsed[i], block[i], target));
  }
  return out.some((line, i) => line !== block[i]) ? out : block;
}

let anyChanged = false;
for (const file of files) {
  const source = readFileSync(file, "utf8");
  const hadTrailing = source.endsWith("\n");
  const lines = source.split("\n");
  if (hadTrailing) lines.pop(); // strip the empty trailing element

  const result = [];
  let i = 0;
  while (i < lines.length) {
    if (isCommentLine(lines[i])) {
      let j = i;
      while (j < lines.length && isCommentLine(lines[j])) j += 1;
      const block = lines.slice(i, j);
      result.push(...alignBlock(block, explicitColumn));
      i = j;
    } else {
      result.push(lines[i]);
      i += 1;
    }
  }

  const out = result.join("\n") + (hadTrailing ? "\n" : "");
  if (out !== source) {
    anyChanged = true;
    if (check) {
      process.stdout.write(`would reformat: ${file}\n`);
    } else {
      writeFileSync(file, out);
      process.stdout.write(`reformatted: ${file}\n`);
    }
  }
}

if (check && anyChanged) process.exit(1);
