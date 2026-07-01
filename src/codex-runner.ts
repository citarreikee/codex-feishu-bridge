export const BRIDGE_INSTRUCTION = [
  'You are replying through a Feishu bridge.',
  'Anything you output as assistant text will be sent back into the current Feishu chat.',
  'Do not claim that you cannot send messages into the chat when the user is asking you to reply in chat.',
].join('\n');

export interface CodexTurnResult {
  sessionId: string;
  text: string;
  resumed: boolean;
  messageCount: number;
}

export interface CodexTurnHooks {
  onAssistantMessage?: (text: string) => Promise<void>;
  onFinal?: () => Promise<void>;
}

export interface CodexBridge {
  isBusy(chatId: string): boolean;
  interrupt(chatId: string): boolean;
  reset(chatId: string): void;
  getSessionId(chatId: string): string | undefined;
  runTurn(chatId: string, prompt: string, hooks?: CodexTurnHooks): Promise<CodexTurnResult>;
}

export class CodexInterruptedError extends Error {
  constructor(message = 'Codex turn was interrupted by remote command.') {
    super(message);
    this.name = 'CodexInterruptedError';
  }
}

export class NoEventTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoEventTimeoutError';
  }
}

export function buildBridgePrompt(prompt: string): string {
  return `${BRIDGE_INSTRUCTION}\n\nUser message:\n${prompt}`;
}

export function isCodexInterruptedError(error: unknown): boolean {
  return error instanceof CodexInterruptedError;
}

export function shouldRetryFresh(error: unknown): boolean {
  if (error instanceof NoEventTimeoutError) return true;
  if (error instanceof CodexInterruptedError) return false;
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes('resume') ||
    message.includes('session') ||
    message.includes('thread') ||
    message.includes('exited without turn.completed')
  );
}
