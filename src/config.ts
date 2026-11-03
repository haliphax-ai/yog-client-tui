import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

export type AppConfig = {
  baseUrl: string;
  model: string;
};

export type PersistedState = {
  lastSessionId: string | null;
};

const CONFIG_DIR_NAME = "yog-client-tui";
const CONFIG_FILE_NAME = "config.json";
const STATE_FILE_NAME = "state.json";

export function resolveConfigDir(env = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg !== "") {
    return join(xdg, CONFIG_DIR_NAME);
  }

  const home = env.HOME;
  if (home !== undefined && home !== "") {
    return join(home, ".yog-client-tui");
  }

  return join(".", CONFIG_DIR_NAME);
}

export function configFilePath(env = process.env): string {
  return join(resolveConfigDir(env), CONFIG_FILE_NAME);
}

export function stateFilePath(env = process.env): string {
  return join(resolveConfigDir(env), STATE_FILE_NAME);
}

export function parseConfig(raw: string): AppConfig {
  const value = JSON.parse(raw) as {
    baseUrl?: string;
    model?: string;
    session?: string;
  };
  if (value.baseUrl === undefined || value.baseUrl === "") {
    throw new Error(`Missing baseUrl in ${CONFIG_FILE_NAME}`);
  }
  if (value.model === undefined || value.model === "") {
    throw new Error(`Missing model in ${CONFIG_FILE_NAME}`);
  }
  return { baseUrl: value.baseUrl, model: value.model };
}

export function parseState(raw: string): PersistedState {
  const value = JSON.parse(raw) as { lastSessionId?: string | null };
  return { lastSessionId: value.lastSessionId ?? null };
}

export async function loadConfig(filePath: string): Promise<AppConfig> {
  const raw = await readFile(filePath, "utf8");
  return parseConfig(raw);
}

export async function loadState(filePath: string): Promise<PersistedState> {
  if (!existsSync(filePath)) {
    return { lastSessionId: null };
  }
  const raw = await readFile(filePath, "utf8");
  return parseState(raw);
}

export async function saveState(
  filePath: string,
  state: PersistedState,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
