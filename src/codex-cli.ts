import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import type { Config } from './config.js';
import { buildResumeRecoverySummary, withRecoveryContext } from './resume-recovery.js';
import { StateStore } from './state-store.js';

const BRIDGE_INSTRUCTION = [
  'You are replying through a Feishu bridge.',
  'Anything you output as assistant text will be sent back into the current Feishu chat.',
  'Do not claim that you cannot send messages into the chat when the user is asking you to reply in chat.',
].join('\n');

export interface CodexTurnResult {
  threadId: string;
  text: string;
  resumed: boolean;
  messageCount: number;
}

export interface CodexTurnHooks {
  onAssistantMessage?: (text: string) => Promise<void>;
  onFinal?: () => Promise<void>;
}

class NoEventTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoEventTimeoutError';
  }
}

export class CodexCliBridge {
  private readonly config: Config;
  private readonly store: StateStore;
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(config: Config, store: StateStore) {
    this.config = config;
    this.store = store;
  }

  isBusy(chatId: string): boolean {
    return this.chains.has(chatId);
  }

  reset(chatId: string): void {
    this.store.clearSession(chatId);
  }

  getThreadId(chatId: string): string | undefined {
    return this.store.getSessionId(chatId);
  }

  runTurn(chatId: string, prompt: string, hooks: CodexTurnHooks = {}): Promise<CodexTurnResult> {
    return this.enqueue(chatId, async () => {
      const savedThreadId = this.store.getSessionId(chatId) || this.config.defaultThreadId;
      const existingRecoverySummary = this.store.getRecoverySummary(chatId);
      const promptWithContext = this.withFileTransferContext(chatId, prompt);
      const fullPrompt = [
        BRIDGE_INSTRUCTION,
        '',
        savedThreadId ? promptWithContext : withRecoveryContext(promptWithContext, existingRecoverySummary),
      ].join('\n');

      try {
        const result = await this.invoke(fullPrompt, savedThreadId, hooks);
        this.store.setSessionId(chatId, result.threadId);
        return result;
      } catch (error) {
        if (savedThreadId && shouldRetryFresh(error)) {
          console.warn('[bridge] Resume failed, retrying fresh Codex thread for chat', chatId);
          const recoverySummary = this.config.resumeRecoveryEnabled
            ? buildResumeRecoverySummary(savedThreadId, this.config)
            : '';
          if (recoverySummary) {
            this.store.setRecoverySummary(chatId, savedThreadId, recoverySummary);
          }
          this.store.clearSession(chatId);
          const retryPrompt = [
            BRIDGE_INSTRUCTION,
            '',
            withRecoveryContext(promptWithContext, recoverySummary || existingRecoverySummary),
          ].join('\n');
          const result = await this.invoke(retryPrompt, undefined, hooks);
          this.store.setSessionId(chatId, result.threadId);
          return result;
        }
        throw error;
      }
    });
  }

  private enqueue<T>(chatId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(chatId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    this.chains.set(chatId, current);
    current.finally(() => {
      if (this.chains.get(chatId) === current) {
        this.chains.delete(chatId);
      }
    });
    return current;
  }

  private withFileTransferContext(chatId: string, prompt: string): string {
    if (!this.config.fileTransferEnabled) return prompt;
    const outboxDir = path.join(this.config.fileOutboxDir, sanitizePathSegment(chatId));
    fs.mkdirSync(outboxDir, { recursive: true });
    const manifestPath = path.join(outboxDir, 'send.json');
    const instruction = [
      'Bridge file transfer is enabled.',
      'If you need to send local files back to the Feishu chat, write a JSON manifest at this exact path:',
      manifestPath,
      'Use this shape: {"files":[{"path":"absolute/local/file/path","caption":"optional text before the file"}]}',
      'Only include files that the user asked you to send or that are clearly needed as deliverables.',
    ].join('\n');
    return [prompt, instruction].filter((part) => part.trim()).join('\n\n');
  }

  private invoke(prompt: string, threadId?: string, hooks: CodexTurnHooks = {}): Promise<CodexTurnResult> {
    const resumed = Boolean(threadId);
    const codexArgs = buildCodexArgs(this.config, prompt, threadId);
    const spawnSpec = resolveCodexSpawn(this.config.codexExecutable, codexArgs);

    return new Promise((resolve, reject) => {
      const child = spawn(spawnSpec.command, spawnSpec.args, {
        cwd: this.config.codexWorkDir,
        env: {
          ...process.env,
          ...this.config.codexEnv,
        },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let activeThreadId = threadId ?? '';
      const messages: string[] = [];
      const stderrLines: string[] = [];
      let messageCount = 0;
      let turnCompleted = false;
      let settled = false;

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(noEventTimer);
        clearTimeout(hardTimer);
        reject(error);
      };

      const finish = async (): Promise<void> => {
        if (settled) return;
        settled = true;
        clearTimeout(noEventTimer);
        clearTimeout(hardTimer);
        if (!activeThreadId) {
          reject(new Error('Codex did not return a thread id.'));
          return;
        }
        try {
          if (hooks.onFinal && messageCount > 0) {
            await hooks.onFinal();
          }
          resolve({
            threadId: activeThreadId,
            text: messages.join('\n\n').trim(),
            resumed,
            messageCount,
          });
        } catch (error) {
          reject(error);
        }
      };

      const resetNoEventTimeout = (): void => {
        clearTimeout(noEventTimer);
        noEventTimer = setTimeout(() => {
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
          fail(new NoEventTimeoutError(`Codex produced no events for ${this.config.noEventTimeoutMs}ms.`));
        }, this.config.noEventTimeoutMs);
        noEventTimer.unref();
      };

      let noEventTimer = setTimeout(() => undefined, this.config.noEventTimeoutMs);
      const hardTimer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
        fail(new Error(`Codex exceeded hard timeout of ${this.config.hardTimeoutMs}ms.`));
      }, this.config.hardTimeoutMs);
      hardTimer.unref();
      resetNoEventTimeout();

      child.on('error', (error) => {
        fail(error);
      });

      const stdoutReader = readline.createInterface({ input: child.stdout });
      stdoutReader.on('line', (line) => {
        resetNoEventTimeout();
        if (!line.trim()) return;

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }

        if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
          activeThreadId = event.thread_id;
          return;
        }

        if (event.type === 'item.completed') {
          const item = event.item as Record<string, unknown> | undefined;
          if (item?.type !== 'agent_message' || typeof item.text !== 'string') return;
          const text = item.text.trim();
          if (!text) return;
          messages.push(text);
          messageCount += 1;
          if (hooks.onAssistantMessage) {
            stdoutReader.pause();
            Promise.resolve(hooks.onAssistantMessage(text))
              .then(() => {
                stdoutReader.resume();
              })
              .catch((error) => {
                fail(error instanceof Error ? error : new Error(String(error)));
              });
          }
          return;
        }

        if (event.type === 'turn.completed') {
          turnCompleted = true;
          void finish();
          return;
        }

        if (event.type === 'error') {
          fail(new Error(typeof event.message === 'string' ? event.message : JSON.stringify(event)));
        }
      });

      const stderrReader = readline.createInterface({ input: child.stderr });
      stderrReader.on('line', (line) => {
        resetNoEventTimeout();
        if (!line.trim()) return;
        stderrLines.push(line);
      });

      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          fail(new Error(stderrLines.join('\n') || `Codex exited with code ${code}`));
          return;
        }
        if (!turnCompleted) {
          fail(new Error(stderrLines.join('\n') || 'Codex exited without a turn.completed event.'));
          return;
        }
        void finish();
      });
    });
  }
}

function buildCodexArgs(config: Config, prompt: string, threadId?: string): string[] {
  if (threadId) {
    const resumeArgs = ['exec', 'resume', threadId, '--json'];
    if (config.codexModel) {
      resumeArgs.push('--model', config.codexModel);
    }
    if (config.codexSkipGitRepoCheck) {
      resumeArgs.push('--skip-git-repo-check');
    }
    if (config.codexBypassApprovalsAndSandbox) {
      resumeArgs.push('--dangerously-bypass-approvals-and-sandbox');
    }
    for (const override of config.codexConfigOverrides) {
      resumeArgs.push('-c', override);
    }
    resumeArgs.push(prompt);
    return resumeArgs;
  }

  const args: string[] = ['exec'];
  args.push('--json');
  args.push('--color', 'never');
  args.push('-C', config.codexWorkDir);

  if (config.codexModel) {
    args.push('--model', config.codexModel);
  }

  if (config.codexSandbox) {
    args.push('--sandbox', config.codexSandbox);
  }

  if (config.codexApprovalPolicy) {
    args.push('--ask-for-approval', config.codexApprovalPolicy);
  }

  if (config.codexSkipGitRepoCheck) {
    args.push('--skip-git-repo-check');
  }

  if (config.codexBypassApprovalsAndSandbox) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }

  for (const override of config.codexConfigOverrides) {
    args.push('-c', override);
  }

  args.push(prompt);
  return args;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'unknown';
}

function shouldRetryFresh(error: unknown): boolean {
  if (error instanceof NoEventTimeoutError) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes('resume') ||
    message.includes('session') ||
    message.includes('thread') ||
    message.includes('turn.completed') ||
    message.includes('not found')
  );
}

function resolveCodexSpawn(
  executable: string,
  args: string[],
): { command: string; args: string[] } {
  if (process.platform !== 'win32') {
    return { command: executable, args };
  }

  const lowered = executable.toLowerCase();
  if (lowered.endsWith('.ps1')) {
    return {
      command: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', executable, ...args],
    };
  }

  if (lowered === 'codex') {
    const ps1Path = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'codex.ps1');
    return {
      command: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1Path, ...args],
    };
  }

  return { command: executable, args };
}
