import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { BRIDGE_HOME } from './config.js';

export const RUNTIME_DIR = path.join(BRIDGE_HOME, 'runtime');
export const LOGS_DIR = path.join(BRIDGE_HOME, 'logs');
export const PID_FILE = path.join(RUNTIME_DIR, 'bridge.pid');
export const LOG_FILE = path.join(LOGS_DIR, 'bridge.log');
export const ERR_FILE = path.join(LOGS_DIR, 'bridge.err.log');

export function ensureRuntimeDirs(): void {
  for (const dir of [BRIDGE_HOME, RUNTIME_DIR, LOGS_DIR, path.join(BRIDGE_HOME, 'data')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function readPid(): number | undefined {
  try {
    const raw = fs.readFileSync(PID_FILE, 'utf-8').trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function currentStatus(): { running: boolean; pid?: number } {
  const pid = readPid();
  if (!pid) return { running: false };
  if (isProcessRunning(pid)) return { running: true, pid };
  try {
    fs.rmSync(PID_FILE, { force: true });
  } catch {
    // Best effort cleanup.
  }
  return { running: false };
}

export function startDaemon(command: string, args: string[] = []): { started: boolean; pid?: number; message: string } {
  ensureRuntimeDirs();
  const status = currentStatus();
  if (status.running) {
    return { started: false, pid: status.pid, message: `Bridge already running (PID: ${status.pid})` };
  }

  const out = fs.openSync(LOG_FILE, 'a');
  const err = fs.openSync(ERR_FILE, 'a');
  const child = spawn(command, args, {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', out, err],
    windowsHide: true,
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  return { started: true, pid: child.pid, message: `Bridge started (PID: ${child.pid})` };
}

export function stopDaemon(): string {
  const status = currentStatus();
  if (!status.running || !status.pid) return 'Bridge is not running';
  try {
    process.kill(status.pid, process.platform === 'win32' ? undefined : 'SIGTERM');
  } catch {
    // Process may have exited between status check and kill.
  }
  try {
    fs.rmSync(PID_FILE, { force: true });
  } catch {
    // Best effort cleanup.
  }
  return 'Bridge stopped';
}

export function readLogs(lines = 80): string {
  const chunks: string[] = [];
  if (fs.existsSync(LOG_FILE)) {
    chunks.push('== stdout ==');
    chunks.push(tail(LOG_FILE, lines));
  }
  if (fs.existsSync(ERR_FILE)) {
    chunks.push('== stderr ==');
    chunks.push(tail(ERR_FILE, lines));
  }
  return chunks.join('\n').trim() || 'No logs yet.';
}

function tail(filePath: string, lines: number): string {
  const content = fs.readFileSync(filePath, 'utf-8');
  return content.split(/\r?\n/).slice(-lines).join('\n');
}
