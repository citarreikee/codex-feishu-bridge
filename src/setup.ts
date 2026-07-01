import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { BRIDGE_HOME, CONFIG_PATH } from './config.js';

export interface SetupOptions {
  assumeYes?: boolean;
}

export interface SetupResult {
  configPath: string;
  workDir: string;
}

export async function runSetup(options: SetupOptions = {}): Promise<SetupResult> {
  fs.mkdirSync(BRIDGE_HOME, { recursive: true });
  const rl = readline.createInterface({ input, output });
  try {
    console.log('Codex Feishu Bridge setup');
    console.log('This wizard checks local dependencies, configures Codex CLI, and connects your Feishu bot.');
    console.log('');

    await ensureEnvironmentDependencies();
    await ensureCodexCli(options);

    const existing = readEnvFile(CONFIG_PATH);
    const defaultWorkDir = existing.CFB_CODEX_WORKDIR || os.homedir();
    const feishuAppId = await askRequired(rl, 'Feishu App ID', existing.CFB_FEISHU_APP_ID);
    const feishuAppSecret = await askRequiredSecret(rl, 'Feishu App Secret', existing.CFB_FEISHU_APP_SECRET);
    const workDir = await askRequired(rl, 'Codex work directory', defaultWorkDir);

    const config = {
      CFB_FEISHU_APP_ID: feishuAppId,
      CFB_FEISHU_APP_SECRET: feishuAppSecret,
      CFB_FEISHU_DOMAIN: existing.CFB_FEISHU_DOMAIN || 'feishu',
      CFB_FEISHU_ALLOWED_USERS: existing.CFB_FEISHU_ALLOWED_USERS || '',
      CFB_FEISHU_REQUIRE_MENTION: existing.CFB_FEISHU_REQUIRE_MENTION || 'true',
      CFB_FEISHU_USE_CARDS: existing.CFB_FEISHU_USE_CARDS || 'false',
      CFB_CODEX_WORKDIR: workDir,
      CFB_CODEX_EXECUTABLE: existing.CFB_CODEX_EXECUTABLE || 'codex',
      CFB_CODEX_MODEL: existing.CFB_CODEX_MODEL || '',
      CFB_CODEX_SANDBOX: existing.CFB_CODEX_SANDBOX || 'danger-full-access',
      CFB_CODEX_APPROVAL_POLICY: existing.CFB_CODEX_APPROVAL_POLICY || 'never',
      CFB_CODEX_SKIP_GIT_REPO_CHECK: existing.CFB_CODEX_SKIP_GIT_REPO_CHECK || 'true',
      CFB_CODEX_BYPASS_APPROVALS_AND_SANDBOX: existing.CFB_CODEX_BYPASS_APPROVALS_AND_SANDBOX || 'false',
      CFB_CODEX_CONFIG_OVERRIDES: existing.CFB_CODEX_CONFIG_OVERRIDES || '',
      CFB_DEFAULT_THREAD_ID: existing.CFB_DEFAULT_THREAD_ID || '',
      CFB_RESUME_RECOVERY_ENABLED: existing.CFB_RESUME_RECOVERY_ENABLED || 'true',
      CFB_RESUME_RECOVERY_MAX_CHARS: existing.CFB_RESUME_RECOVERY_MAX_CHARS || '12000',
      CFB_RESUME_RECOVERY_MAX_MESSAGES: existing.CFB_RESUME_RECOVERY_MAX_MESSAGES || '24',
      CFB_NO_EVENT_TIMEOUT_MS: existing.CFB_NO_EVENT_TIMEOUT_MS || String(10 * 60 * 1000),
      CFB_HARD_TIMEOUT_MS: existing.CFB_HARD_TIMEOUT_MS || String(90 * 60 * 1000),
      CFB_REPLY_MAX_CHARS: existing.CFB_REPLY_MAX_CHARS || '3500',
      CFB_FILE_TRANSFER_ENABLED: existing.CFB_FILE_TRANSFER_ENABLED || 'true',
      CFB_FILE_MAX_DOWNLOAD_MB: existing.CFB_FILE_MAX_DOWNLOAD_MB || '100',
      CFB_FILE_MAX_UPLOAD_MB: existing.CFB_FILE_MAX_UPLOAD_MB || '30',
      CFB_FILE_DOWNLOAD_DIR: existing.CFB_FILE_DOWNLOAD_DIR || '',
      CFB_FILE_OUTBOX_DIR: existing.CFB_FILE_OUTBOX_DIR || '',
      CFB_FILE_SEND_ROOTS: existing.CFB_FILE_SEND_ROOTS || '',
      CODEX_HOME: existing.CODEX_HOME || '',
      OPENAI_API_KEY: existing.OPENAI_API_KEY || '',
      OPENAI_BASE_URL: existing.OPENAI_BASE_URL || '',
    };

    writeEnvFile(CONFIG_PATH, config);
    console.log('');
    console.log(`Config written to ${CONFIG_PATH}`);
    console.log(`Codex work directory: ${workDir}`);
    console.log('The bridge uses your local Codex CLI auth and config by default.');
    return {
      configPath: CONFIG_PATH,
      workDir,
    };
  } finally {
    rl.close();
  }
}

async function ensureEnvironmentDependencies(): Promise<void> {
  console.log('Checking local dependencies...');
  const nodeVersion = process.versions.node;
  const major = Number(nodeVersion.split('.')[0]);
  if (!Number.isFinite(major) || major < 20) {
    throw new Error(`Node.js 20+ is required. Current Node.js version: ${nodeVersion}`);
  }
  console.log(`Node.js found: ${nodeVersion}`);

  const npmCheck = spawnSync('npm', ['--version'], { encoding: 'utf-8', shell: process.platform === 'win32' });
  if (npmCheck.status !== 0) {
    throw new Error('npm was not found. Please install Node.js 20+ from https://nodejs.org, then run this file again.');
  }
  console.log(`npm found: ${(npmCheck.stdout || npmCheck.stderr).trim()}`);
}

async function ensureCodexCli(options: SetupOptions): Promise<void> {
  const existing = spawnSync('codex', ['--version'], { encoding: 'utf-8', shell: process.platform === 'win32' });
  if (existing.status === 0) {
    console.log(`Codex CLI found: ${(existing.stdout || existing.stderr).trim()}`);
    return;
  }

  if (!options.assumeYes) {
    console.log('Codex CLI was not found. Installing @openai/codex globally with npm...');
  }
  const install = spawnSync('npm', ['install', '-g', '@openai/codex'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (install.status !== 0) {
    throw new Error('Failed to install Codex CLI with npm.');
  }
}

async function askRequired(rl: readline.Interface, label: string, fallback = ''): Promise<string> {
  while (true) {
    const value = await ask(rl, label, fallback);
    if (value) return value;
    console.log(`${label} is required.`);
  }
}

async function askRequiredSecret(rl: readline.Interface, label: string, fallback = ''): Promise<string> {
  return askRequired(rl, label, fallback);
}

async function ask(rl: readline.Interface, label: string, fallback = ''): Promise<string> {
  const suffix = fallback ? ` [${maskIfSecret(label, fallback)}]` : '';
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  return answer || fallback;
}

function maskIfSecret(label: string, value: string): string {
  if (!/secret|key|token/i.test(label)) return value;
  if (value.length <= 8) return '********';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function readEnvFile(filePath: string): Record<string, string> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const result: Record<string, string> = {};
    for (const raw of content.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const index = line.indexOf('=');
      if (index === -1) continue;
      result[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
    return result;
  } catch {
    return {};
  }
}

function writeEnvFile(filePath: string, values: Record<string, string>): void {
  const lines = [
    '# Generated by codex-feishu-bridge setup.',
    '# Do not commit this file. It contains secrets.',
    '',
    ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
    '',
  ];
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
}
