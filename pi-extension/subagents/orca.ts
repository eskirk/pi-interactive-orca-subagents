/**
 * Orca surface layer for interactive subagents.
 *
 * Everything the extension does to a terminal pane goes through this small
 * interface: create/split a pane, send input, read its screen, close it, and
 * poll for exit. Orca owns the terminal layout; this module owns the CLI
 * protocol and keeps index.ts independent of Orca details.
 *
 * Panes are identified by Orca runtime terminal handles. The parent Pi process
 * receives its handle through ORCA_TERMINAL_HANDLE when Orca launches it.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);
const ORCA_JSON_BUFFER = 10 * 1024 * 1024;
const commandAvailability = new Map<string, boolean>();

type JsonRecord = Record<string, any>;

function getOrcaCommand(): string {
  return process.env.ORCA_CLI_COMMAND?.trim() || "orca";
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null ? (value as JsonRecord) : undefined;
}

function parseJson(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

function getErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  const record = asRecord(value);
  const message = record?.message ?? record?.errorMessage ?? record?.detail;
  return typeof message === "string" && message.trim() ? message.trim() : undefined;
}

function formatCommandError(error: any): string {
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";
  return stderr || stdout || error?.message || "unknown error";
}

function hasCommand(command: string): boolean {
  const cached = commandAvailability.get(command);
  if (cached !== undefined) return cached;

  try {
    execFileSync(command, ["--help"], {
      encoding: "utf8",
      stdio: "ignore",
      timeout: 5_000,
    });
    commandAvailability.set(command, true);
    return true;
  } catch {
    commandAvailability.set(command, false);
    return false;
  }
}

/** True when the current Pi process was launched in an Orca terminal. */
export function isOrcaAvailable(): boolean {
  return Boolean(process.env.ORCA_TERMINAL_HANDLE) && hasCommand(getOrcaCommand());
}

export function orcaSetupHint(): string {
  return "Start pi from an Orca-managed terminal with the Orca CLI available on PATH.";
}

function requireOrca(): void {
  if (!process.env.ORCA_TERMINAL_HANDLE) {
    throw new Error(`Orca is required for subagents. ${orcaSetupHint()}`);
  }
  if (!hasCommand(getOrcaCommand())) {
    throw new Error(`The Orca CLI was not found. ${orcaSetupHint()}`);
  }
}

function parseOrcaResponse(output: string): unknown {
  const payload = parseJson(output);
  const root = asRecord(payload);
  if (!root) {
    throw new Error(`Orca returned invalid JSON: ${output.trim() || "empty output"}`);
  }

  if (root.ok === false) {
    throw new Error(getErrorMessage(root.error) ?? getErrorMessage(root.message) ?? "Orca command failed");
  }

  return payload;
}

async function runOrca(args: string[]): Promise<unknown> {
  requireOrca();

  try {
    const { stdout } = await execFileAsync(getOrcaCommand(), [...args, "--json"], {
      encoding: "utf8",
      maxBuffer: ORCA_JSON_BUFFER,
    });
    return parseOrcaResponse(stdout as string);
  } catch (error: any) {
    throw new Error(`Orca command failed: ${formatCommandError(error)}`);
  }
}

function getResult(payload: unknown): JsonRecord {
  const root = asRecord(payload);
  const result = asRecord(root?.result);
  return result ?? root ?? {};
}

function getTerminalHandle(payload: unknown): string {
  const result = getResult(payload);
  const terminal = asRecord(result.terminal);
  const split = asRecord(result.split);
  const handle = terminal?.handle ?? split?.handle ?? result.handle;
  if (typeof handle !== "string" || !handle) {
    throw new Error("Orca did not return a terminal handle");
  }
  return handle;
}

function findActivePane(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  const record = node as JsonRecord;
  if (record.type === "terminal" && record.active && typeof record.handle === "string") {
    return record.handle;
  }

  for (const child of Object.values(record)) {
    const handle = findActivePane(child);
    if (handle) return handle;
  }
  return null;
}

async function getFocusedSurface(): Promise<string | null> {
  try {
    const worktree = process.env.ORCA_WORKTREE_ID
      ? `id:${process.env.ORCA_WORKTREE_ID}`
      : "active";
    const payload = await runOrca([
      "terminal",
      "list",
      "--worktree",
      worktree,
      "--include-visual-layouts",
    ]);
    const result = getResult(payload);
    const layouts = Array.isArray(result.visualLayouts) ? result.visualLayouts : [];
    for (const layout of layouts) {
      const root = asRecord(layout?.root);
      const activeTab = Array.isArray(root?.tabs)
        ? root.tabs.find((tab: any) => tab?.tabId === root?.activeTabId)
        : undefined;
      const handle = findActivePane(activeTab?.panes);
      if (handle) return handle;
    }
  } catch {}
  return null;
}

function getTerminalLines(payload: unknown): string {
  const result = getResult(payload);
  const terminal = asRecord(result.terminal) ?? result;
  const tail = terminal.tail ?? terminal.lines ?? terminal.screen;
  if (Array.isArray(tail)) return tail.filter((line) => typeof line === "string").join("\n");
  if (typeof tail === "string") return tail;
  throw new Error("Orca did not return terminal screen output");
}

// ── Shell helpers ──

export function shellEscape(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

// ── Surface primitives ──

/**
 * Create a new pane for a subagent by splitting the parent Pi terminal.
 * Returns the new Orca terminal handle.
 */
export async function createSurface(name?: string): Promise<string> {
  return createSurfaceSplit(name, "right");
}

/**
 * Create a new pane from an optional source terminal.
 * Orca currently accepts horizontal or vertical split directions, so left/right
 * map to horizontal and up/down map to vertical.
 */
export async function createSurfaceSplit(
  name: string | undefined,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): Promise<string> {
  const parent = fromSurface ?? process.env.ORCA_TERMINAL_HANDLE;
  if (!parent) throw new Error(`No parent Orca terminal handle. ${orcaSetupHint()}`);

  const orientation = direction === "left" || direction === "right" ? "horizontal" : "vertical";
  const focusedSurface = await getFocusedSurface();
  const surface = getTerminalHandle(
    await runOrca([
      "terminal",
      "split",
      "--terminal",
      parent,
      "--direction",
      orientation,
    ]),
  );

  // Pane titles are cosmetic. A title failure must not prevent the child from launching.
  if (name) {
    try {
      await runOrca(["terminal", "set-pane-title", "--terminal", surface, "--title", name]);
    } catch {}
  }

  // Orca focuses a freshly split pane; return focus to the original pane so
  // spawning does not interrupt the user.
  try {
    await runOrca(["terminal", "switch", "--terminal", focusedSurface ?? parent]);
  } catch {}

  return surface;
}

/** Send a command string to a terminal and submit it. */
export async function sendCommand(surface: string, command: string): Promise<void> {
  await runOrca(["terminal", "send", "--terminal", surface, "--text", command, "--enter"]);
}

/**
 * Send a long command by writing it to a script first. This avoids terminal
 * line-wrapping issues and preserves the exact invocation for debugging.
 */
export async function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): Promise<string> {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) scriptParts.push(options.scriptPreamble.trimEnd());
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", { mode: 0o755 });
  await sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/** Read the rendered screen contents of a terminal. */
export async function readScreen(surface: string, lines = 50): Promise<string> {
  return getTerminalLines(
    await runOrca([
      "terminal",
      "read",
      "--terminal",
      surface,
      "--screen",
      "--limit",
      String(Math.max(1, lines)),
    ]),
  );
}

/** Read the rendered screen contents without blocking the event loop. */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  return readScreen(surface, lines);
}

/** Close one terminal pane. */
export async function closeSurface(surface: string): Promise<void> {
  await runOrca(["terminal", "close", "--terminal", surface]);
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload written by the error path in
 * subagent-done.ts. Clean completions are detected through the terminal
 * sentinel, while ask_question uses a separate `.ask` file.
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Sidecars and sentinels remain authoritative;
 * Orca screen reads provide crash detection without changing child lifecycle.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) throw new Error("Aborted while waiting for subagent to finish");

    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) return { reason: "sentinel", exitCode: 0 };
      } catch {}
    }

    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
    } catch {
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
