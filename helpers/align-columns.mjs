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
 * Rebuild one comment block so label/description lines (and their
 * continuations) share a column. Returns the new block, or the original
 * array when nothing changes.
 */
function alignBlock(block, explicitColumn) {
  const items = block.map((line) => {
    const m = line.match(/^(\s*)(\*|\/\/|#)(\s*)/);
    if (m === null) return { line, lead: "", marker: "", baseLen: 0, body: line };
    const lead = m[1];
    const marker = m[2];
    const indent = m[3];
    const baseLen = lead.length + marker.length;
    return { line, lead, marker, indent, baseLen, body: line.slice(baseLen + indent.length) };
  });

  const parsed = [];
  let active = false;
  for (const it of items) {
    const fm = /^(.*?)\s{2,}(\S.*)$/.exec(it.body);
    if (fm !== null) {
      active = true;
      parsed.push({
        type: "label",
        line: it.line,
        prefix: it.lead + it.marker + it.indent,
        label: fm[1],
        desc: fm[2],
        labelEnd: it.lead.length + it.marker.length + it.indent.length + fm[1].length,
      });
    } else if (active && /^\s{2,}\S/.test(it.line.slice(it.baseLen))) {
      parsed.push({
        type: "cont",
        line: it.line,
        lead: it.lead,
        marker: it.marker,
        baseLen: it.baseLen,
        body: it.body,
      });
    } else {
      active = false;
      parsed.push({ type: "other", line: it.line });
    }
  }

  const labels = parsed.filter((p) => p.type === "label");
  if (labels.length === 0) return block;
  const maxLabelEnd = Math.max(...labels.map((l) => l.labelEnd));
  const target = explicitColumn ?? maxLabelEnd + 2;

  const out = [];
  let changed = false;
  for (const p of parsed) {
    if (p.type === "label") {
      const pad = Math.max(2, target - p.labelEnd);
      const rebuilt = p.prefix + p.label + " ".repeat(pad) + p.desc;
      if (rebuilt !== p.line) changed = true;
      out.push(rebuilt);
    } else if (p.type === "cont") {
      const pad = Math.max(0, target - p.baseLen);
      const rebuilt = p.lead + p.marker + " ".repeat(pad) + p.body.trimStart();
      if (rebuilt !== p.line) changed = true;
      out.push(rebuilt);
    } else {
      out.push(p.line);
    }
  }
  return changed ? out : block;
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