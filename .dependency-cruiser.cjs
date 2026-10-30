/**
 * Dependency rules for the src/ tree.
 *
 * Dependency-cruiser has no native "match file contents" rule type (its rule
 * conditions only match module paths, dependency attributes and reachability),
 * so the two content-based rules (6 and 9) are enforced here by scanning the
 * TypeScript sources under src/ when this config is loaded and failing the run
 * when a violation is found. Everything else is expressed as regular
 * forbidden rules.
 *
 * (No tsConfig option here: this project's typescript major is newer than the
 * versions dependency-cruiser can drive, and pointing at tsconfig.json makes
 * it silently cruise zero modules. All imports are relative, so tsconfig
 * path resolution is not needed.)
 */
const fs = require("node:fs");
const path = require("node:path");

/** Content rules: file path -> violation message. */
function scanContentRules() {
  const violations = [];
  const root = "src";
  if (!fs.existsSync(root)) return violations;

  const files = fs
    .readdirSync(root, { recursive: true })
    .map((f) => String(f).split(path.sep).join("/"))
    .filter((f) => f.endsWith(".ts"));

  // Rule 6 - raw color literals (ANSI 256/truecolor fg escapes, hex colors)
  // are allowed only in ui/theme.ts.
  const colorLiteral = /\\x1b\[38;|\\u001b\[38;|\\e\[38;|\x1b\[38;|#[0-9a-f]{6}\b/i;

  // Rule 9 - no default-server-URL constant (127.0.0.1:8111, localhost:8111,
  // or the default port) anywhere outside config/.
  const defaultServerUrl =
    /(?:127\.0\.0\.1|localhost):8111|\b(?:const|let|var)\b[^\n]*=[^\n]*\b8111\b|\b\w+\s*:\s*["'`][^"'`]*\b8111\b["'`]/;

  for (const rel of files) {
    const file = path.join(root, rel);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (rel !== "ui/theme.ts" && colorLiteral.test(line)) {
        violations.push(
          `no-color-literals-outside-theme: ${file}:${i + 1} contains a raw color literal`,
        );
      }
      if (rel !== "config.ts" && defaultServerUrl.test(line)) {
        violations.push(
          `no-default-server-url-outside-config: ${file}:${i + 1} defines a default server URL/port constant`,
        );
      }
    });
  }
  return violations;
}

const contentViolations = scanContentRules();
if (contentViolations.length > 0) {
  throw new Error(`dependency rules violated:\n  ${contentViolations.join("\n  ")}`);
}

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // 1. No circular dependencies anywhere in src/.
    {
      name: "no-circular",
      severity: "error",
      comment: "circular dependencies make refactoring unpredictable",
      from: { path: "^src/" },
      to: { circular: true },
    },

    // 2. Every src/ file must be reachable from the composition root.
    {
      name: "everything-reachable-from-main",
      severity: "error",
      comment: "every src module must be reachable from src/main.ts",
      from: { path: "^src/main\\.ts$" },
      to: { path: "^src/", pathNot: "^src/main\\.ts$", reachable: false },
    },

    // 3. The transport client must stay free of ui, config and node:fs.
    {
      name: "client-no-ui-config-fs",
      severity: "error",
      comment: "the yog client deals in plain data only",
      from: { path: ["^src/yogClient\\.ts$", "^src/client/"] },
      to: {
        path: ["^src/ui/", "^src/config(\\.ts$|/)", "^(node:)?fs(/|$)"],
      },
    },

    // 4. util/ is a leaf domain: no imports from any other domain.
    {
      name: "util-no-domain-imports",
      severity: "error",
      comment: "ansi helpers must not depend on ui, client, config or core",
      from: { path: "^src/util/" },
      to: {
        path: ["^src/ui/", "^src/(yogClient\\.ts$|client/)", "^src/config(\\.ts$|/)", "^src/core/"],
      },
    },

    // 5. ui/ must not talk to the transport or the filesystem.
    {
      name: "ui-no-client-fs",
      severity: "error",
      comment: "the presenter talks to the store, not the transport",
      from: { path: "^src/ui/" },
      to: { path: ["^src/(yogClient\\.ts$|client/)", "^(node:)?fs(/|$)"] },
    },

    // 7. Only the composition root may import config/.
    {
      name: "config-only-from-main",
      severity: "error",
      comment: "config is resolved once at the composition root",
      from: { path: "^src/", pathNot: "^src/main\\.ts$" },
      to: { path: "^src/config(\\.ts$|/)" },
    },

    // 8a. glamour is an implementation detail of entry rendering.
    // (to.path matches the resolved path, hence the unanchored package name.)
    {
      name: "glamour-only-in-render",
      severity: "error",
      comment: "markdown rendering belongs to ui/render",
      from: { pathNot: "^src/ui/render/" },
      to: { path: "@oakoliver/glamour" },
    },

    // 8b. lipgloss (styles + width primitives) stays inside the ui domain and
    // the ansi helper layer that wraps its measurement functions.
    {
      name: "lipgloss-only-in-ui-and-util",
      severity: "error",
      comment: "styling primitives stay in ui/ (and the util wrappers around them)",
      from: { pathNot: "^(src/ui/|src/util/)" },
      to: { path: "@oakoliver/lipgloss" },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
      extensions: [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"],
    },
  },
};
