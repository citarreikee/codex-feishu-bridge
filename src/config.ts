import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Config {
  homeDir: string;
  dataDir: string;
  runtimeDir: string;
  logsDir: string;
  feishuAppId: string;
  feishuAppSecret: string;
  feishuDomain: 'feishu' | 'lark';
  feishuAllowedUsers: string[];
  feishuRequireMention: boolean;
  codexDriver: 'sdk' | 'cli';
  codexWorkDir: string;
  codexExecutable: string;
  codexExecutableOverride?: string;
  codexFullAccess: boolean;
  codexModel?: string;
  codexApiKey?: string;
  codexBaseUrl?: string;
  codexSandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  defaultSessionId?: string;
  noEventTimeoutMs: number;
  hardTimeoutMs: number;
  replyMaxChars: number;
}

export const BRIDGE_HOME = process.env.CFB_HOME || path.join(os.homedir(), '.codex-feishu-bridge');
export const CONFIG_PATH = path.join(BRIDGE_HOME, 'config.env');

function parseEnvFile(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries.set(key, value);
  }
  return entries;
}

function loadEnvEntries(): Map<string, string> {
  const entries = new Map<string, string>();

  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    for (const [key, value] of parseEnvFile(content)) {
      entries.set(key, value);
    }
  } catch {
    // Allow pure process.env usage during local development.
  }

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      entries.set(key, value);
    }
  }
  return entries;
}

function toBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

function toNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function required(entries: Map<string, string>, key: string): string {
  const value = entries.get(key);
  if (!value) {
    throw new Error(`Missing required config: ${key}`);
  }
  return value;
}

function resolveCodexExecutable(entries: Map<string, string>): string {
  const configured = entries.get('CFB_CODEX_EXECUTABLE');
  if (configured) return configured;

  const candidates = [
    path.join(path.dirname(process.execPath), 'codex'),
    path.join(os.homedir(), '.local', 'bin', 'codex'),
    path.join(os.homedir(), '.npm-global', 'bin', 'codex'),
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return 'codex';
}

export function loadConfig(): Config {
  const entries = loadEnvEntries();
  const homeDir = BRIDGE_HOME;
  const feishuDomain = entries.get('CFB_FEISHU_DOMAIN') === 'lark' ? 'lark' : 'feishu';
  const codexDriver = entries.get('CFB_CODEX_DRIVER') === 'cli' ? 'cli' : 'sdk';
  const codexSandbox = entries.get('CFB_CODEX_SANDBOX');
  const codexExecutableOverride = entries.get('CFB_CODEX_EXECUTABLE') || undefined;

  const config: Config = {
    homeDir,
    dataDir: path.join(homeDir, 'data'),
    runtimeDir: path.join(homeDir, 'runtime'),
    logsDir: path.join(homeDir, 'logs'),
    feishuAppId: required(entries, 'CFB_FEISHU_APP_ID'),
    feishuAppSecret: required(entries, 'CFB_FEISHU_APP_SECRET'),
    feishuDomain,
    feishuAllowedUsers: splitCsv(entries.get('CFB_FEISHU_ALLOWED_USERS')),
    feishuRequireMention: toBoolean(entries.get('CFB_FEISHU_REQUIRE_MENTION'), true),
    codexDriver,
    codexWorkDir: entries.get('CFB_CODEX_WORKDIR') || process.cwd(),
    codexExecutable: resolveCodexExecutable(entries),
    codexExecutableOverride,
    codexFullAccess: toBoolean(entries.get('CFB_CODEX_FULL_ACCESS'), false),
    codexModel: entries.get('CFB_CODEX_MODEL') || undefined,
    codexApiKey: entries.get('CFB_CODEX_API_KEY') || undefined,
    codexBaseUrl: entries.get('CFB_CODEX_BASE_URL') || undefined,
    codexSandbox: codexSandbox === 'read-only' || codexSandbox === 'workspace-write' || codexSandbox === 'danger-full-access'
      ? codexSandbox
      : undefined,
    defaultSessionId: entries.get('CFB_DEFAULT_SESSION_ID') || undefined,
    noEventTimeoutMs: toNumber(entries.get('CFB_NO_EVENT_TIMEOUT_MS'), 10 * 60 * 1000),
    hardTimeoutMs: toNumber(entries.get('CFB_HARD_TIMEOUT_MS'), 90 * 60 * 1000),
    replyMaxChars: toNumber(entries.get('CFB_REPLY_MAX_CHARS'), 3500),
  };

  if (!fs.existsSync(config.codexWorkDir)) {
    throw new Error(`Configured workdir does not exist: ${config.codexWorkDir}`);
  }

  if (config.codexDriver === 'cli' && config.codexExecutable !== 'codex' && !fs.existsSync(config.codexExecutable)) {
    throw new Error(`Configured codex executable does not exist: ${config.codexExecutable}`);
  }

  if (config.codexExecutableOverride && config.codexExecutableOverride !== 'codex' && !fs.existsSync(config.codexExecutableOverride)) {
    throw new Error(`Configured codex executable does not exist: ${config.codexExecutableOverride}`);
  }

  return config;
}

export function ensureBridgeDirs(config: Config): void {
  for (const dir of [config.homeDir, config.dataDir, config.runtimeDir, config.logsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
