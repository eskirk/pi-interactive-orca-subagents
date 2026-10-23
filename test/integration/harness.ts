/**
 * Integration test harness for pi-interactive-orca-subagents.
 *
 * Provides utilities to:
 * - Detect whether Orca is available
 * - Create isolated test environments with test agent definitions
 * - Start real pi sessions in Orca terminal panes
 * - Poll for file creation and screen output
 * - Clean up panes and temp files after tests
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  readdirSync,
  rmSync,
  existsSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  isOrcaAvailable,
  createSurface,
  createSurfaceSplit,
  sendCommand,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  shellEscape,
} from "../../pi-extension/subagents/orca.ts";

// Re-export Orca primitives for tests
export {
  createSurface,
  createSurfaceSplit,
  sendCommand,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  shellEscape,
};

// ── Paths ──

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HARNESS_DIR, "../..");
const TEST_AGENTS_SRC = join(HARNESS_DIR, "agents");

/**
 * Absolute path to the extension source in the working tree.
 *
 * Integration tests must exercise the code on the current branch — NOT the
 * version installed as a pi-package under `~/.pi/agent/git/...` or the project
 * mirror under `.pi/git/...`, which stays pinned to the last released tag.
 *
 * We force-load this file via `pi -ne -e <path>` in startPi() below so local
 * edits are always the code under test, regardless of what pi-packages are
 * installed on the host.
 */
const EXTENSION_SOURCE = join(PROJECT_ROOT, "pi-extension", "subagents", "index.ts");

// ── Configuration ──

/** Model used for integration tests. Override with PI_TEST_MODEL env var. */
export const TEST_MODEL = process.env.PI_TEST_MODEL ?? "anthropic/claude-haiku-4-5";

/** Per-test timeout in ms. Override with PI_TEST_TIMEOUT env var. */
export const PI_TIMEOUT = Number(process.env.PI_TEST_TIMEOUT ?? "120000");

// ── Backend detection ──

function orcaCommand(): string {
  return process.env.ORCA_CLI_COMMAND?.trim() || "orca";
}

function runOrca(args: string[]): any {
  const output = execFileSync(orcaCommand(), [...args, "--json"], { encoding: "utf8" });
  return JSON.parse(output);
}

function currentWorktreeSelector(): string {
  return process.env.ORCA_WORKTREE_ID ? `id:${process.env.ORCA_WORKTREE_ID}` : "active";
}

function findActivePane(node: any): string | null {
  if (!node || typeof node !== "object") return null;
  if (node.type === "terminal" && node.active && typeof node.handle === "string") {
    return node.handle;
  }

  for (const child of Object.values(node)) {
    const handle = findActivePane(child);
    if (handle) return handle;
  }
  return null;
}

/** Detect whether the current process is running in an Orca terminal. */
export function getAvailableBackends(): string[] {
  return isOrcaAvailable() ? ["orca"] : [];
}

export function focusSurface(surface: string): void {
  runOrca(["terminal", "switch", "--terminal", surface]);
}

export function getFocusedSurface(): string | null {
  try {
    const payload = runOrca([
      "terminal",
      "list",
      "--worktree",
      currentWorktreeSelector(),
      "--include-visual-layouts",
    ]);
    const layouts = payload?.result?.visualLayouts ?? [];
    for (const layout of layouts) {
      const root = layout?.root;
      const activeTab = root?.tabs?.find((tab: any) => tab.tabId === root.activeTabId);
      const handle = findActivePane(activeTab?.panes);
      if (handle) return handle;
    }
  } catch {}
  return null;
}

export async function waitForFocusedSurface(
  surface: string,
  timeout: number = PI_TIMEOUT,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (getFocusedSurface() === surface) return;
    await sleep(200);
  }

  throw new Error(
    `Timeout (${timeout}ms) waiting for focused Orca pane ${surface}; ` +
      `current focus is ${getFocusedSurface() ?? "unknown"}`,
  );
}

// ── Test environment ──

export interface TestEnv {
  /** Temp directory serving as the test project root */
  dir: string;
  /** Orca terminal panes created during the test (cleaned up automatically) */
  surfaces: string[];
  /** Temp files to clean up */
  tempFiles: string[];
}

/**
 * Create an isolated test environment with test agent definitions.
 * The temp dir has `.pi/agents/` containing copies of all test agents.
 */
export function createTestEnv(): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "pi-integ-"));
  const agentsDir = join(dir, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });

  // Copy test agent definitions into the project-local agents dir
  if (existsSync(TEST_AGENTS_SRC)) {
    for (const file of readdirSync(TEST_AGENTS_SRC)) {
      if (file.endsWith(".md")) {
        cpSync(join(TEST_AGENTS_SRC, file), join(agentsDir, file));
      }
    }
  }

  return { dir, surfaces: [], tempFiles: [] };
}

/**
 * Clean up all resources created during the test.
 */
export async function cleanupTestEnv(env: TestEnv): Promise<void> {
  for (const surface of env.surfaces) {
    try {
      await closeSurface(surface);
    } catch {}
  }
  for (const file of env.tempFiles) {
    try {
      unlinkSync(file);
    } catch {}
  }
  try {
    rmSync(env.dir, { recursive: true, force: true });
  } catch {}
}

/**
 * Create a surface and register it for automatic cleanup.
 */
export async function createTrackedSurface(env: TestEnv, name: string): Promise<string> {
  const surface = await createSurface(name);
  env.surfaces.push(surface);
  return surface;
}

export async function createTrackedSurfaceSplit(
  env: TestEnv,
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): Promise<string> {
  const surface = await createSurfaceSplit(name, direction, fromSurface);
  env.surfaces.push(surface);
  return surface;
}

/**
 * Remove a surface from tracking (after manual close).
 */
export function untrackSurface(env: TestEnv, surface: string): void {
  env.surfaces = env.surfaces.filter((s) => s !== surface);
}

// ── Pi session management ──

/**
 * Start a pi session in an Orca terminal pane with the subagents extension loaded.
 * Returns immediately — the pi process runs asynchronously in the surface.
 *
 * The command ends with a sentinel so we can detect when pi exits:
 *   `pi ...; echo '__TEST_DONE_'$?'__'`
 */
export async function startPi(
  surface: string,
  testDir: string,
  task: string,
  opts?: { model?: string; extraArgs?: string },
): Promise<void> {
  const model = opts?.model ?? TEST_MODEL;
  const extra = opts?.extraArgs ?? "";

  // Force pi to load the working-tree extension (not an installed pi-package
  // snapshot). `-ne` disables extension auto-discovery, `-e <path>` loads the
  // current branch's source directly. Without this, the tests silently run
  // against whatever version is checked out under `~/.pi/agent/git/...`.
  const cmd = [
    `cd ${shellEscape(testDir)} &&`,
    `pi`,
    `-ne`,
    `-e ${shellEscape(EXTENSION_SOURCE)}`,
    `--model ${shellEscape(model)}`,
    extra,
    shellEscape(task),
  ]
    .filter(Boolean)
    .join(" ");

  await sendLongCommand(surface, `${cmd}; echo '__TEST_DONE_'$?'__'`, {
    scriptPath: join(testDir, `test-launch-${Date.now()}.sh`),
  });
}

// ── Polling helpers ──

/**
 * Poll until a regex pattern appears in the surface's screen output.
 * Throws on timeout with the last screen contents for debugging.
 */
export async function waitForScreen(
  surface: string,
  pattern: RegExp,
  timeout: number = PI_TIMEOUT,
  lines: number = 200,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const screen = await readScreenAsync(surface, lines);
      if (pattern.test(screen)) return screen;
    } catch {}
    await sleep(2000);
  }

  let finalScreen = "";
  try {
    finalScreen = await readScreen(surface, lines);
  } catch {}
  throw new Error(
    `Timeout (${timeout}ms) waiting for pattern ${pattern}.\nLast screen:\n${finalScreen.slice(-1000)}`,
  );
}

/**
 * Poll until a file exists and optionally matches a content pattern.
 * Returns the file content on success.
 */
export async function waitForFile(
  path: string,
  timeout: number = PI_TIMEOUT,
  contentPattern?: RegExp,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (existsSync(path)) {
      const content = readFileSync(path, "utf8");
      if (!contentPattern || contentPattern.test(content)) return content;
    }
    await sleep(2000);
  }
  throw new Error(
    `Timeout (${timeout}ms) waiting for file: ${path}` +
      (contentPattern ? ` matching ${contentPattern}` : ""),
  );
}

/**
 * Wait for the pi process in a surface to exit (sentinel detection).
 * Returns the exit code.
 */
export async function waitForPiExit(
  surface: string,
  timeout: number = PI_TIMEOUT,
): Promise<number> {
  const screen = await waitForScreen(surface, /__TEST_DONE_(\d+)__/, timeout);
  const match = screen.match(/__TEST_DONE_(\d+)__/);
  return match ? parseInt(match[1], 10) : -1;
}

// ── Utilities ──

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function uniqueId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * Register a temp file for cleanup.
 */
export function trackTempFile(env: TestEnv, path: string): void {
  env.tempFiles.push(path);
}
