import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

import type { Config } from './config.js';
import {
  buildBridgePrompt,
  type CodexBridge,
  CodexInterruptedError,
  type CodexTurnHooks,
  type CodexTurnResult,
  NoEventTimeoutError,
  shouldRetryFresh,
} from './codex-runner.js';
import { StateStore } from './state-store.js';

interface CodexEvent {
  type: string;
  thread_id?: string;
  message?: string;
  item?: {
    type?: string;
    text?: string;
  };
}

export class CodexCliBridge implements CodexBridge {
  private readonly config: Config;
  private readonly store: StateStore;
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly activeTurns = new Map<string, {
    child: ChildProcessWithoutNullStreams;
    interrupted: boolean;
  }>();

  constructor(config: Config, store: StateStore) {
    this.config = config;
    this.store = store;
  }

  isBusy(chatId: string): boolean {
    return this.chains.has(chatId);
  }

  interrupt(chatId: string): boolean {
    const active = this.activeTurns.get(chatId);
    if (!active) return false;
    active.interrupted = true;
    active.child.kill('SIGTERM');
    setTimeout(() => {
      if (!active.child.killed) {
        active.child.kill('SIGKILL');
      }
    }, 5_000).unref();
    return true;
  }

  reset(chatId: string): void {
    this.store.clearSession(chatId);
  }

  getSessionId(chatId: string): string | undefined {
    return this.store.getSessionId(chatId);
  }

  runTurn(chatId: string, prompt: string, hooks: CodexTurnHooks = {}): Promise<CodexTurnResult> {
    return this.enqueue(chatId, async () => {
      const savedSessionId = this.store.getSessionId(chatId) || this.config.defaultSessionId;
      try {
        const result = await this.invoke(chatId, prompt, savedSessionId, hooks);
        this.store.setSessionId(chatId, result.sessionId);
        return result;
      } catch (error) {
        if (savedSessionId && shouldRetryFresh(error)) {
          console.warn('[bridge] Resume failed, retrying fresh session for chat', chatId);
          this.store.clearSession(chatId);
          const result = await this.invoke(chatId, prompt, undefined, hooks);
          this.store.setSessionId(chatId, result.sessionId);
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

  private invoke(chatId: string, prompt: string, sessionId?: string, hooks: CodexTurnHooks = {}): Promise<CodexTurnResult> {
    const resumed = Boolean(sessionId);
    const args = sessionId
      ? ['exec', 'resume', '--json', '--skip-git-repo-check']
      : ['exec', '--json', '--skip-git-repo-check'];

    if (this.config.codexModel) {
      args.push('-m', this.config.codexModel);
    }
    if (this.config.codexReasoningEffort) {
      args.push('--config', `model_reasoning_effort="${this.config.codexReasoningEffort}"`);
    }
    if (this.config.codexFullAccess) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else if (!sessionId && this.config.codexSandbox) {
      args.push('-s', this.config.codexSandbox);
    }
    if (sessionId) {
      args.push(sessionId);
    }
    args.push('-');

    return new Promise((resolve, reject) => {
      const child = spawn(this.config.codexExecutable, args, {
        cwd: this.config.codexWorkDir,
        env: process.env,
        shell: process.platform === 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const activeTurn = { child, interrupted: false };
      this.activeTurns.set(chatId, activeTurn);

      let activeSessionId = sessionId;
      let sawCompletion = false;
      const messages: string[] = [];
      const stderrLines: string[] = [];
      let messageCount = 0;
      let settled = false;

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(noEventTimer);
        clearTimeout(hardTimer);
        if (this.activeTurns.get(chatId) === activeTurn) {
          this.activeTurns.delete(chatId);
        }
        reject(error);
      };

      const finish = async (): Promise<void> => {
        if (settled) return;
        settled = true;
        clearTimeout(noEventTimer);
        clearTimeout(hardTimer);
        if (this.activeTurns.get(chatId) === activeTurn) {
          this.activeTurns.delete(chatId);
        }
        if (!activeSessionId) {
          reject(new Error('Codex did not return a session id.'));
          return;
        }
        try {
          if (hooks.onFinal && messageCount > 0) {
            await hooks.onFinal();
          }
          resolve({
            sessionId: activeSessionId,
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

        let event: CodexEvent;
        try {
          event = JSON.parse(line) as CodexEvent;
        } catch {
          return;
        }

        if (event.type === 'thread.started' && event.thread_id) {
          activeSessionId = event.thread_id;
          return;
        }

        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
          messages.push(event.item.text);
          messageCount += 1;
          if (hooks.onAssistantMessage) {
            stdoutReader.pause();
            Promise.resolve(hooks.onAssistantMessage(event.item.text))
              .then(() => {
                stdoutReader.resume();
              })
              .catch((error) => {
                fail(error instanceof Error ? error : new Error(String(error)));
              });
          }
          return;
        }

        if (event.type === 'turn.failed') {
          fail(new Error(event.message || 'Codex turn failed.'));
          return;
        }

        if (event.type === 'error') {
          // Codex emits transient error events for recoverable issues (e.g., "Reconnecting... 1/5").
          // Do not fail the turn; Codex will retry and continue on its own.
          console.warn('[bridge] Codex transient error:', event.message);
          return;
        }

        if (event.type === 'turn.completed') {
          sawCompletion = true;
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
        if (activeTurn.interrupted) {
          fail(new CodexInterruptedError());
          return;
        }
        if (code !== 0) {
          fail(new Error(stderrLines.join('\n') || `Codex exited with code ${code}`));
          return;
        }
        if (!sawCompletion) {
          fail(new Error(stderrLines.join('\n') || 'Codex exited without turn.completed.'));
          return;
        }
        void finish();
      });

      child.stdin.write(buildBridgePrompt(prompt));
      child.stdin.end();
    });
  }
}
