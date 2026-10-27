/**
 * Configuration loading for the yog TUI client.
 *
 * `config.json` holds local server/model settings and is gitignored; a
 * `config.example.json` template is committed at the package root. Loading
 * checks the current working directory first (a local copy wins, so you can
 * run the client from anywhere against different servers), then falls back
 * to the copy at the package root (resolved from this file's own URL).
 * Validation is strict: `model` is required because it is sent with every
 * turn, `baseUrl` is optional.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Parsed `config.json` contents. */
export interface Config {
  /** Model id sent with every turn (required, non-empty). */
  model: string;
  /** Optional server origin; overrides the `YOG_SERVER_URL` environment. */
  baseUrl?: string;
}

/** Default daemon origin when neither config nor environment specifies one. */
export const DEFAULT_BASE_URL = "http://127.0.0.1:8111";

/** Config file name looked up in the working directory and package root. */
const CONFIG_FILE = "config.json";

/** Committed template the user copies into place. */
const CONFIG_EXAMPLE = "config.example.json";

/** Absolute path of the package root (the directory holding `config.json`). */
function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Locate `config.json`: a copy in the current working directory takes
 * precedence over the one at the package root.
 */
export function resolveConfigPath(cwd: string = process.cwd()): string {
  return path.resolve(cwd, CONFIG_FILE);
}

/** Build a human-readable configuration error. */
function configError(detail: string, file: string): Error {
  return new Error(`invalid configuration (${file}): ${detail}`);
}

/**
 * Load and validate `config.json`.
 *
 * Throws a descriptive error when the file is missing, is not valid JSON, or
 * does not contain a usable `model`.
 */
export async function loadConfig(cwd: string = process.cwd()): Promise<Config> {
  const local = resolveConfigPath(cwd);
  const bundled = path.join(packageRoot(), CONFIG_FILE);

  let file = local;
  let raw: string;
  try {
    raw = await readFile(local, "utf8");
  } catch {
    file = bundled;
    try {
      raw = await readFile(bundled, "utf8");
    } catch {
      throw new Error(
        `config.json not found (looked in ${local} and ${bundled}); ` +
          `copy it into place with \`cp ${CONFIG_EXAMPLE} ${CONFIG_FILE}\` and edit it ` +
          '— set "model" to the model id you want to use (and optionally "baseUrl") — ' +
          "or drop a config.json in the current directory",
      );
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw configError(`not valid JSON (${detail})`, file);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw configError("expected a JSON object", file);
  }

  const obj = parsed as Record<string, unknown>;
  const model = obj["model"];
  if (typeof model !== "string" || model.trim() === "") {
    throw configError('"model" must be a non-empty string', file);
  }
  const baseUrl = obj["baseUrl"];
  if (baseUrl !== undefined && (typeof baseUrl !== "string" || baseUrl.trim() === "")) {
    throw configError('"baseUrl" must be a non-empty string when present', file);
  }

  return {
    model: model.trim(),
    ...(typeof baseUrl === "string" ? { baseUrl: baseUrl.trim() } : {}),
  };
}

/**
 * Resolve the server origin: config `baseUrl`, else `YOG_SERVER_URL`, else the
 * loopback default. Trailing slashes are stripped so path joins are stable.
 */
export function resolveBaseUrl(config: Config, env: NodeJS.ProcessEnv = process.env): string {
  const raw = config.baseUrl ?? env["YOG_SERVER_URL"] ?? DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}