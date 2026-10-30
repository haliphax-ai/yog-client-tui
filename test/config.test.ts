import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BASE_URL,
  loadConfig,
  persistSessionKey,
  resolveBaseUrl,
  resolveConfigPath,
  type Config,
} from "../src/config.ts";

/**
 * Shared state for the narrow node:fs/promises override (see below).
 *
 * This suite must not register a registry-wide mock: the test pool shares
 * module registries across files, so a hoisted `vi.mock("node:fs/promises")`
 * rides along with this file into other files' module graphs in some thread
 * interleavings and flips unrelated assertions. Instead, `beforeAll` resets
 * the module registry, registers the override with `vi.doMock` (which
 * affects only modules imported after that call), captures an isolated
 * `loadConfig` whose backing module graph sees it, and immediately unregisters
 * the override and resets the registry again — so nothing persists past this
 * suite's setup.
 */
const fsState = { denyBundledRead: false };

/** Package-root `config.json` (the bundled fallback), as loadConfig resolves it. */
const bundledConfigPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "config.json",
);

/**
 * The suite's own copy of `loadConfig`, imported while the override below is
 * registered; its `src/config.ts` holds a direct reference to the overridden
 * `readFile`, so `fsState` still controls it after the override is unregistered.
 */
let loadConfigUnderTest: typeof loadConfig;

beforeAll(async () => {
  vi.resetModules();
  vi.doMock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    return {
      ...actual,
      readFile: (async (file: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => {
        if (fsState.denyBundledRead && String(file) === bundledConfigPath) {
          throw Object.assign(new Error("bundled config denied by test"), {
            code: "ENOENT",
          });
        }
        return (actual.readFile as (...args: unknown[]) => unknown)(file, ...rest);
      }) as typeof actual.readFile,
    };
  });
  try {
    ({ loadConfig: loadConfigUnderTest } = await import("../src/config.ts"));
  } finally {
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
  }
});

/**
 * Temp directories used as fake working directories, cleaned up after the
 * suite. One directory per test body keeps failures isolated.
 */
const tempDirs: string[] = [];

/** Create a fresh temp directory to act as a fake cwd. */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "yog-config-test-"));
  tempDirs.push(dir);
  return dir;
}

/** Write a `config.json` with the given raw contents into `dir`. */
async function writeConfig(dir: string, contents: string): Promise<string> {
  const file = path.join(dir, "config.json");
  await writeFile(file, contents, "utf8");
  return file;
}

/** Run loadConfig and capture the rejection, failing the test if it resolves. */
async function loadError(cwd: string): Promise<Error> {
  try {
    await loadConfigUnderTest(cwd);
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    return err as Error;
  }
  throw new Error("expected loadConfig to reject, but it resolved");
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadConfig", () => {
  it("loads a valid config from the given cwd", async () => {
    const dir = await tempDir();
    await writeConfig(dir, '{"model":"m-1","baseUrl":"http://example.test"}');
    const config = await loadConfigUnderTest(dir);
    expect(config).toEqual({ model: "m-1", baseUrl: "http://example.test" });
    // no surprise keys: only model and optional baseUrl
    expect(Object.keys(config).sort()).toEqual(["baseUrl", "model"]);
  });

  it("omits baseUrl from the result when it is absent", async () => {
    const dir = await tempDir();
    await writeConfig(dir, '{"model":"m-1"}');
    const config = await loadConfigUnderTest(dir);
    expect(config).toEqual({ model: "m-1" });
    expect("baseUrl" in config).toBe(false);
  });

  it("trims whitespace around model and baseUrl", async () => {
    const dir = await tempDir();
    await writeConfig(dir, '{"model":"  m-1  ","baseUrl":"  http://example.test  "}');
    const config = await loadConfigUnderTest(dir);
    expect(config).toEqual({ model: "m-1", baseUrl: "http://example.test" });
  });

  it("ignores unknown extra keys", async () => {
    const dir = await tempDir();
    await writeConfig(dir, '{"model":"m-1","other":123,"nested":{"a":true}}');
    const config = await loadConfigUnderTest(dir);
    expect(config).toEqual({ model: "m-1" });
  });

  it("local config in cwd wins over the bundled package-root copy", async () => {
    const dir = await tempDir();
    await writeConfig(dir, '{"model":"local-model"}');
    const config = await loadConfigUnderTest(dir);
    expect(config.model).toBe("local-model");
  });

  it("falls back to the bundled package-root config when the cwd copy is missing", async () => {
    const dir = await tempDir(); // no config.json written
    const config = await loadConfigUnderTest(dir);
    // whatever the bundled file holds, that is what comes back
    const raw = await readFile(bundledConfigPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(config.model).toBe(String(parsed["model"]).trim());
    expect(config.baseUrl).toBe(
      typeof parsed["baseUrl"] === "string" ? parsed["baseUrl"].trim() : undefined,
    );
  });

  it("throws the exact not-found message when neither copy exists", async () => {
    const dir = await tempDir(); // local missing; bundled read denied by the mock
    fsState.denyBundledRead = true;
    let err: Error | undefined;
    try {
      err = await loadError(dir);
    } finally {
      fsState.denyBundledRead = false;
    }
    expect(err).toBeDefined();
    const local = path.join(dir, "config.json");
    expect(err?.message).toBe(
      `config.json not found (looked in ${local} and ${bundledConfigPath}); ` +
        "copy it into place with `cp config.example.json config.json` and edit it " +
        '— set "model" to the model id you want to use (and optionally "baseUrl") — ' +
        "or drop a config.json in the current directory",
    );
    // the local (cwd) path is mentioned first, the bundled path second
    expect(err?.message.indexOf(local)).toBeLessThan(err?.message.indexOf(bundledConfigPath) ?? -1);
  });

  it("throws for invalid JSON, naming the file that was read", async () => {
    const dir = await tempDir();
    const file = await writeConfig(dir, "{oops");
    const err = await loadError(dir);
    // detail is the raw JSON.parse message (no error name prefix)
    expect(err.message).toBe(
      `invalid configuration (${file}): not valid JSON (Expected property name or '}' in JSON at position 1 (line 1 column 2))`,
    );
  });

  it("rejects non-object JSON: null", async () => {
    const dir = await tempDir();
    const file = await writeConfig(dir, "null");
    const err = await loadError(dir);
    expect(err.message).toBe(`invalid configuration (${file}): expected a JSON object`);
  });

  it("rejects non-object JSON: array", async () => {
    const dir = await tempDir();
    const file = await writeConfig(dir, "[1,2]");
    const err = await loadError(dir);
    expect(err.message).toBe(`invalid configuration (${file}): expected a JSON object`);
  });

  it("rejects non-object JSON: string", async () => {
    const dir = await tempDir();
    const file = await writeConfig(dir, '"hello"');
    const err = await loadError(dir);
    expect(err.message).toBe(`invalid configuration (${file}): expected a JSON object`);
  });

  it("rejects non-object JSON: number", async () => {
    const dir = await tempDir();
    const file = await writeConfig(dir, "42");
    const err = await loadError(dir);
    expect(err.message).toBe(`invalid configuration (${file}): expected a JSON object`);
  });

  it("rejects a missing model", async () => {
    const dir = await tempDir();
    const file = await writeConfig(dir, '{"baseUrl":"http://example.test"}');
    const err = await loadError(dir);
    expect(err.message).toBe(`invalid configuration (${file}): "model" must be a non-empty string`);
  });

  it("rejects an empty model", async () => {
    const dir = await tempDir();
    const file = await writeConfig(dir, '{"model":""}');
    const err = await loadError(dir);
    expect(err.message).toBe(`invalid configuration (${file}): "model" must be a non-empty string`);
  });

  it("rejects a whitespace-only model", async () => {
    const dir = await tempDir();
    const file = await writeConfig(dir, '{"model":"   "}');
    const err = await loadError(dir);
    expect(err.message).toBe(`invalid configuration (${file}): "model" must be a non-empty string`);
  });

  it("rejects a non-string model", async () => {
    const dir = await tempDir();
    const file = await writeConfig(dir, '{"model":42}');
    const err = await loadError(dir);
    expect(err.message).toBe(`invalid configuration (${file}): "model" must be a non-empty string`);
  });

  it("rejects an empty baseUrl", async () => {
    const dir = await tempDir();
    const file = await writeConfig(dir, '{"model":"m-1","baseUrl":""}');
    const err = await loadError(dir);
    expect(err.message).toBe(
      `invalid configuration (${file}): "baseUrl" must be a non-empty string when present`,
    );
  });

  it("rejects a whitespace-only baseUrl", async () => {
    const dir = await tempDir();
    const file = await writeConfig(dir, '{"model":"m-1","baseUrl":"  "}');
    const err = await loadError(dir);
    expect(err.message).toBe(
      `invalid configuration (${file}): "baseUrl" must be a non-empty string when present`,
    );
  });

  it("rejects a non-string baseUrl", async () => {
    const dir = await tempDir();
    const file = await writeConfig(dir, '{"model":"m-1","baseUrl":8111}');
    const err = await loadError(dir);
    expect(err.message).toBe(
      `invalid configuration (${file}): "baseUrl" must be a non-empty string when present`,
    );
  });
});

describe("resolveConfigPath", () => {
  it("resolves config.json against the given cwd", () => {
    expect(resolveConfigPath("/tmp/somewhere")).toBe(path.resolve("/tmp/somewhere", "config.json"));
  });

  it("uses the current working directory when no argument is given", () => {
    expect(resolveConfigPath()).toBe(path.resolve(process.cwd(), "config.json"));
  });

  it("normalizes relative cwds against the process cwd", () => {
    expect(resolveConfigPath("sub/dir")).toBe(
      path.resolve(process.cwd(), "sub/dir", "config.json"),
    );
  });

  it("resolves '..' segments away", () => {
    expect(resolveConfigPath("/tmp/one/../two")).toBe(path.resolve("/tmp/two", "config.json"));
  });

  it("returns an absolute path even for the root cwd", () => {
    const resolved = resolveConfigPath("/");
    expect(resolved).toBe(path.resolve("/", "config.json"));
    expect(path.isAbsolute(resolved)).toBe(true);
  });
});

describe("resolveBaseUrl", () => {
  it("prefers config baseUrl over the environment", () => {
    const config: Config = { model: "m", baseUrl: "http://config.test" };
    expect(resolveBaseUrl(config, { YOG_SERVER_URL: "http://env.test" })).toBe(
      "http://config.test",
    );
  });

  it("falls back to YOG_SERVER_URL when config has no baseUrl", () => {
    const config: Config = { model: "m" };
    expect(resolveBaseUrl(config, { YOG_SERVER_URL: "http://env.test" })).toBe("http://env.test");
  });

  it("falls back to the default when neither config nor env specifies one", () => {
    expect(resolveBaseUrl({ model: "m" }, {})).toBe(DEFAULT_BASE_URL);
    expect(DEFAULT_BASE_URL).toBe("http://127.0.0.1:8111");
  });

  it("uses an empty-string env value as-is (only null/undefined fall through)", () => {
    // characterization: `??` skips only null/undefined, so an empty env value
    // short-circuits the default and yields an empty string
    expect(resolveBaseUrl({ model: "m" }, { YOG_SERVER_URL: "" })).toBe("");
  });

  it("ignores an undefined env value", () => {
    expect(resolveBaseUrl({ model: "m" }, { YOG_SERVER_URL: undefined })).toBe(DEFAULT_BASE_URL);
  });

  it("strips all trailing slashes from the config value", () => {
    expect(resolveBaseUrl({ model: "m", baseUrl: "http://x.test///" }, {})).toBe("http://x.test");
    expect(resolveBaseUrl({ model: "m", baseUrl: "http://x.test/" }, {})).toBe("http://x.test");
  });

  it("strips all trailing slashes from the env value", () => {
    expect(resolveBaseUrl({ model: "m" }, { YOG_SERVER_URL: "http://env.test///" })).toBe(
      "http://env.test",
    );
  });

  it("leaves the slashless default untouched", () => {
    expect(resolveBaseUrl({ model: "m" }, {})).toBe(DEFAULT_BASE_URL);
    expect(DEFAULT_BASE_URL.endsWith("/")).toBe(false);
  });

  it("keeps interior and non-trailing slashes (path segments survive)", () => {
    expect(resolveBaseUrl({ model: "m", baseUrl: "http://x.test/api/v1/" }, {})).toBe(
      "http://x.test/api/v1",
    );
    expect(resolveBaseUrl({ model: "m" }, { YOG_SERVER_URL: "http://env.test/a/b" })).toBe(
      "http://env.test/a/b",
    );
  });

  it("uses process.env when no env argument is given", () => {
    const previous = process.env["YOG_SERVER_URL"];
    try {
      process.env["YOG_SERVER_URL"] = "http://from-process-env.test";
      expect(resolveBaseUrl({ model: "m" })).toBe("http://from-process-env.test");
      // config still wins over the real process environment
      expect(resolveBaseUrl({ model: "m", baseUrl: "http://config.test" })).toBe(
        "http://config.test",
      );
      delete process.env["YOG_SERVER_URL"];
      expect(resolveBaseUrl({ model: "m" })).toBe(DEFAULT_BASE_URL);
    } finally {
      if (previous === undefined) delete process.env["YOG_SERVER_URL"];
      else process.env["YOG_SERVER_URL"] = previous;
    }
  });
});

describe("loadConfig: session key", () => {
  it("accepts and trims a non-empty session id", async () => {
    const dir = await tempDir();
    await writeConfig(dir, '{"model":"m-1","session":" sess-7 "}');
    const config = await loadConfigUnderTest(dir);
    expect(config.session).toBe("sess-7");
  });

  it("omits session from the result when it is absent", async () => {
    const dir = await tempDir();
    await writeConfig(dir, '{"model":"m-1"}');
    const config = await loadConfigUnderTest(dir);
    expect("session" in config).toBe(false);
  });

  it("rejects a non-string session", async () => {
    const dir = await tempDir();
    const file = await writeConfig(dir, '{"model":"m-1","session":123}');
    const err = await loadError(dir);
    expect(err.message).toBe(
      `invalid configuration (${file}): "session" must be a non-empty string when present`,
    );
  });

  it("rejects a whitespace-only session", async () => {
    const dir = await tempDir();
    const file = await writeConfig(dir, '{"model":"m-1","session":"   "}');
    const err = await loadError(dir);
    expect(err.message).toBe(
      `invalid configuration (${file}): "session" must be a non-empty string when present`,
    );
  });
});

describe("persistSessionKey", () => {
  it("rewrites the local copy in place, preserving unknown keys and style", async () => {
    const dir = await tempDir();
    await writeConfig(dir, '{\n  "model": "m-1",\n  "custom": {"a": 1}\n}\n');
    await persistSessionKey("sess-9", dir);
    const raw = await readFile(path.join(dir, "config.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed["session"]).toBe("sess-9");
    expect(parsed["model"]).toBe("m-1");
    expect(parsed["custom"]).toEqual({ a: 1 });
    expect(raw).toBe(
      '{\n  "model": "m-1",\n  "custom": {\n    "a": 1\n  },\n  "session": "sess-9"\n}\n',
    );
  });

  it("falls back to the bundled-dir copy when the cwd has none", async () => {
    const dir = await tempDir(); // empty cwd
    const bundled = await tempDir();
    await writeConfig(bundled, '{"model":"bundled-model"}');
    await persistSessionKey("sess-b", dir, bundled);
    const raw = await readFile(path.join(bundled, "config.json"), "utf8");
    expect((JSON.parse(raw) as Record<string, unknown>)["session"]).toBe("sess-b");
  });

  it("swallows write failures instead of failing the session", async () => {
    const dir = await tempDir();
    const missing = path.join(dir, "no-such-dir");
    // Neither location exists/readable: resolve without throwing.
    await expect(persistSessionKey("sess-x", missing)).resolves.toBeUndefined();
  });

  it("does not invent a config when no copy exists", async () => {
    const dir = await tempDir();
    const bundled = await tempDir();
    await persistSessionKey("sess-y", dir, bundled);
    // Neither directory gained a config.json.
    expect(existsSync(path.join(dir, "config.json"))).toBe(false);
    expect(existsSync(path.join(bundled, "config.json"))).toBe(false);
  });
});
