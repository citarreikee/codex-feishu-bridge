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
  feishuUseCards: boolean;
  codexWorkDir: string;
  codexExecutable: string;
  codexModel: string;
  codexSandbox: 'read-only' | 'workspace-write' | 'danger-full-access' | '';
  codexApprovalPolicy: 'untrusted' | 'on-failure' | 'on-request' | 'never' | '';
  codexSkipGitRepoCheck: boolean;
  codexBypassApprovalsAndSandbox: boolean;
  codexConfigOverrides: string[];
  codexEnv: Record<string, string>;
  defaultThreadId?: string;
  resumeRecoveryEnabled: boolean;
  resumeRecoveryMaxChars: number;
  resumeRecoveryMaxMessages: number;
  noEventTimeoutMs: number;
  hardTimeoutMs: number;
  replyMaxChars: number;
  fileTransferEnabled: boolean;
  fileDownloadDir: string;
  fileOutboxDir: string;
  fileSendRoots: string[];
  fileMaxDownloadBytes: number;
  fileMaxUploadBytes: number;
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

function toBytesFromMb(value: string | undefined, fallbackMb: number): number {
  return toNumber(value, fallbackMb) * 1024 * 1024;
}

function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function collectCodexEnv(entries: Map<string, string>): Record<string, string> {
  const keys = [
    'CODEX_HOME',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
  ];

  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = entries.get(key);
    if (value) {
      env[key] = value;
    }
  }
  return env;
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
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'codex.ps1'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'codex.cmd'),
    path.join(path.dirname(process.execPath), 'codex'),
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
  const codexWorkDir = entries.get('CFB_CODEX_WORKDIR') || process.cwd();
  const fileDownloadDir = entries.get('CFB_FILE_DOWNLOAD_DIR') || path.join(homeDir, 'data', 'attachments');
  const fileOutboxDir = entries.get('CFB_FILE_OUTBOX_DIR') || path.join(homeDir, 'outbox');

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
    feishuUseCards: toBoolean(entries.get('CFB_FEISHU_USE_CARDS'), false),
    codexWorkDir,
    codexExecutable: resolveCodexExecutable(entries),
    codexModel: entries.get('CFB_CODEX_MODEL') || '',
    codexSandbox: parseSandbox(entries.get('CFB_CODEX_SANDBOX')),
    codexApprovalPolicy: parseApprovalPolicy(entries.get('CFB_CODEX_APPROVAL_POLICY')),
    codexSkipGitRepoCheck: toBoolean(entries.get('CFB_CODEX_SKIP_GIT_REPO_CHECK'), true),
    codexBypassApprovalsAndSandbox: toBoolean(entries.get('CFB_CODEX_BYPASS_APPROVALS_AND_SANDBOX'), false),
    codexConfigOverrides: splitCsv(entries.get('CFB_CODEX_CONFIG_OVERRIDES')),
    codexEnv: collectCodexEnv(entries),
    defaultThreadId: entries.get('CFB_DEFAULT_THREAD_ID') || undefined,
    resumeRecoveryEnabled: toBoolean(entries.get('CFB_RESUME_RECOVERY_ENABLED'), true),
    resumeRecoveryMaxChars: toNumber(entries.get('CFB_RESUME_RECOVERY_MAX_CHARS'), 12_000),
    resumeRecoveryMaxMessages: toNumber(entries.get('CFB_RESUME_RECOVERY_MAX_MESSAGES'), 24),
    noEventTimeoutMs: toNumber(entries.get('CFB_NO_EVENT_TIMEOUT_MS'), 10 * 60 * 1000),
    hardTimeoutMs: toNumber(entries.get('CFB_HARD_TIMEOUT_MS'), 90 * 60 * 1000),
    replyMaxChars: toNumber(entries.get('CFB_REPLY_MAX_CHARS'), 3500),
    fileTransferEnabled: toBoolean(entries.get('CFB_FILE_TRANSFER_ENABLED'), true),
    fileDownloadDir,
    fileOutboxDir,
    fileSendRoots: splitCsv(entries.get('CFB_FILE_SEND_ROOTS')),
    fileMaxDownloadBytes: toBytesFromMb(entries.get('CFB_FILE_MAX_DOWNLOAD_MB'), 100),
    fileMaxUploadBytes: toBytesFromMb(entries.get('CFB_FILE_MAX_UPLOAD_MB'), 30),
  };

  if (config.fileSendRoots.length === 0) {
    config.fileSendRoots = [config.codexWorkDir, config.fileOutboxDir];
  }

  if (!fs.existsSync(config.codexWorkDir)) {
    throw new Error(`Configured workdir does not exist: ${config.codexWorkDir}`);
  }

  if (config.codexExecutable !== 'codex' && !fs.existsSync(config.codexExecutable)) {
    throw new Error(`Configured codex executable does not exist: ${config.codexExecutable}`);
  }

  return config;
}

function parseSandbox(value: string | undefined): Config['codexSandbox'] {
  if (value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access') return value;
  return '';
}

function parseApprovalPolicy(value: string | undefined): Config['codexApprovalPolicy'] {
  if (value === 'untrusted' || value === 'on-failure' || value === 'on-request' || value === 'never') return value;
  return '';
}

export function ensureBridgeDirs(config: Config): void {
  for (const dir of [config.homeDir, config.dataDir, config.runtimeDir, config.logsDir, config.fileDownloadDir, config.fileOutboxDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
