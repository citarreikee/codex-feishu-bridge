import { Codex, type ThreadEvent, type ThreadOptions } from '@openai/codex-sdk';

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

export class CodexSdkBridge implements CodexBridge {
  private readonly config: Config;
  private readonly store: StateStore;
  private readonly codex: Codex;
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly activeTurns = new Map<string, {
    controller: AbortController;
    reason?: 'remote-interrupt' | 'no-event-timeout' | 'hard-timeout';
  }>();

  constructor(config: Config, store: StateStore) {
    this.config = config;
    this.store = store;
    this.codex = new Codex({
      codexPathOverride: config.codexExecutableOverride,
      apiKey: config.codexApiKey,
      baseUrl: config.codexBaseUrl,
    });
  }

  isBusy(chatId: string): boolean {
    return this.chains.has(chatId);
  }

  interrupt(chatId: string): boolean {
    const active = this.activeTurns.get(chatId);
    if (!active) return false;
    active.reason = 'remote-interrupt';
    if (!active.controller.signal.aborted) {
      active.controller.abort();
    }
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
          console.warn('[bridge] SDK resume failed, retrying fresh thread for chat', chatId);
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

  private async invoke(chatId: string, prompt: string, sessionId?: string, hooks: CodexTurnHooks = {}): Promise<CodexTurnResult> {
    const resumed = Boolean(sessionId);
    const controller = new AbortController();
    const activeTurn = { controller } as {
      controller: AbortController;
      reason?: 'remote-interrupt' | 'no-event-timeout' | 'hard-timeout';
    };
    this.activeTurns.set(chatId, activeTurn);
    const threadOptions = this.buildThreadOptions();
    const thread = sessionId
      ? this.codex.resumeThread(sessionId, threadOptions)
      : this.codex.startThread(threadOptions);

    let activeSessionId = sessionId;
    let sawCompletion = false;
    const messages: string[] = [];
    let messageCount = 0;
    let noEventTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const clearTimers = (): void => {
      if (noEventTimer) clearTimeout(noEventTimer);
      clearTimeout(hardTimer);
    };

    const fail = (error: Error): never => {
      if (!controller.signal.aborted) {
        controller.abort();
      }
      throw error;
    };

    const resetNoEventTimeout = (): void => {
      if (noEventTimer) clearTimeout(noEventTimer);
      noEventTimer = setTimeout(() => {
        activeTurn.reason = 'no-event-timeout';
        if (!controller.signal.aborted) {
          controller.abort();
        }
      }, this.config.noEventTimeoutMs);
      noEventTimer.unref();
    };

    const hardTimer = setTimeout(() => {
      activeTurn.reason = 'hard-timeout';
      if (!controller.signal.aborted) {
        controller.abort();
      }
    }, this.config.hardTimeoutMs);
    hardTimer.unref();
    resetNoEventTimeout();

    try {
      const { events } = await thread.runStreamed(buildBridgePrompt(prompt), {
        signal: controller.signal,
      });

      for await (const event of events) {
        resetNoEventTimeout();
        await this.handleEvent(event, hooks, {
          setActiveSessionId: (threadId) => {
            activeSessionId = threadId;
          },
          markCompletion: () => {
            sawCompletion = true;
          },
          addMessage: (message) => {
            messages.push(message);
            messageCount += 1;
          },
        });
      }

      settled = true;
      clearTimers();
      activeSessionId = activeSessionId || thread.id || undefined;
      if (!activeSessionId) {
        throw new Error('Codex SDK did not return a thread id.');
      }
      if (!sawCompletion) {
        throw new Error('Codex SDK stream ended without turn.completed.');
      }
      if (hooks.onFinal && messageCount > 0) {
        await hooks.onFinal();
      }
      return {
        sessionId: activeSessionId,
        text: messages.join('\n\n').trim(),
        resumed,
        messageCount,
      };
    } catch (error) {
      clearTimers();
      if (!settled && controller.signal.aborted) {
        if (activeTurn.reason === 'remote-interrupt') {
          fail(new CodexInterruptedError());
        }
        const message = activeTurn.reason === 'hard-timeout'
          ? `Codex SDK exceeded hard timeout of ${this.config.hardTimeoutMs}ms.`
          : `Codex SDK produced no events for ${this.config.noEventTimeoutMs}ms.`;
        fail(new NoEventTimeoutError(message));
      }
      throw error;
    } finally {
      clearTimers();
      if (this.activeTurns.get(chatId) === activeTurn) {
        this.activeTurns.delete(chatId);
      }
    }
  }

  private buildThreadOptions(): ThreadOptions {
    const sandboxMode = this.config.codexFullAccess
      ? 'danger-full-access'
      : this.config.codexSandbox;

    return {
      model: this.config.codexModel,
      modelReasoningEffort: this.config.codexReasoningEffort,
      sandboxMode,
      workingDirectory: this.config.codexWorkDir,
      skipGitRepoCheck: true,
      approvalPolicy: this.config.codexFullAccess ? 'never' : undefined,
    };
  }

  private async handleEvent(
    event: ThreadEvent,
    hooks: CodexTurnHooks,
    state: {
      setActiveSessionId: (threadId: string) => void;
      markCompletion: () => void;
      addMessage: (message: string) => void;
    },
  ): Promise<void> {
    if (event.type === 'thread.started') {
      state.setActiveSessionId(event.thread_id);
      return;
    }

    if (event.type === 'item.completed' && event.item.type === 'agent_message' && event.item.text) {
      state.addMessage(event.item.text);
      if (hooks.onAssistantMessage) {
        await hooks.onAssistantMessage(event.item.text);
      }
      return;
    }

    if (event.type === 'turn.failed') {
      throw new Error(event.error.message || 'Codex SDK turn failed.');
    }

    if (event.type === 'error') {
      console.warn('[bridge] Codex SDK transient error:', event.message);
      return;
    }

    if (event.type === 'turn.completed') {
      state.markCompletion();
    }
  }
}
