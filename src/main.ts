import { createCodexBridge } from './codex.js';
import { ensureBridgeDirs, loadConfig } from './config.js';
import type { CodexBridge } from './codex-runner.js';
import { FeishuBot } from './feishu-bot.js';
import { StateStore } from './state-store.js';

const FINAL_REPLY_MARKER = '━━ Final Answer ━━';

async function main(): Promise<void> {
  const config = loadConfig();
  ensureBridgeDirs(config);

  const store = new StateStore(config.dataDir);
  const feishu = new FeishuBot(config);
  const codex = createCodexBridge(config, store);

  await feishu.start();

  let shuttingDown = false;
  const shutdown = async (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[bridge] Shutting down${signal ? ` (${signal})` : ''}`);
    await feishu.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGHUP', () => void shutdown('SIGHUP'));
  process.on('unhandledRejection', (error) => {
    console.error('[bridge] unhandledRejection:', error);
  });
  process.on('uncaughtException', (error) => {
    console.error('[bridge] uncaughtException:', error.stack || error.message);
  });
  process.on('beforeExit', (code) => {
    console.log(`[bridge] beforeExit code=${code}`);
  });
  process.on('exit', (code) => {
    console.log(`[bridge] exit code=${code}`);
  });

  // Keep the daemon alive even if the SDK's long-connection internals temporarily
  // leave the event loop idle between callbacks.
  setInterval(() => undefined, 45_000);

  while (!shuttingDown) {
    const inbound = await feishu.consumeOne();
    if (!inbound) break;

    void handleInbound(inbound, feishu, codex).catch(async (error) => {
      console.error('[bridge] Failed to handle inbound message:', error instanceof Error ? error.stack || error.message : error);
      try {
        await feishu.sendText(inbound.chatId, `桥接执行失败：${toUserError(error)}`);
      } catch (sendError) {
        console.error('[bridge] Failed to send error reply:', sendError);
      }
    });
  }
}

async function handleInbound(
  inbound: { chatId: string; text: string },
  feishu: FeishuBot,
  codex: CodexBridge,
): Promise<void> {
  const { chatId, text } = inbound;
  const trimmed = text.trim();

  if (trimmed === '/new' || trimmed === '/reset') {
    codex.reset(chatId);
    await feishu.sendText(chatId, '已清空当前 chat 绑定的 Codex 会话，下条消息会新开会话。');
    return;
  }

  if (trimmed === '/status') {
    const sessionId = codex.getSessionId(chatId);
    await feishu.sendText(
      chatId,
      sessionId
        ? `当前已绑定 Codex 会话：${sessionId}${codex.isBusy(chatId) ? '\n状态：处理中' : ''}`
        : '当前 chat 还没有绑定 Codex 会话。',
    );
    return;
  }

  if (trimmed === '/help') {
    await feishu.sendText(
      chatId,
      [
        '这是一个轻量 Feishu <-> Codex 桥接。',
        '/new 或 /reset: 清空当前 chat 的 Codex 会话',
        '/status: 查看当前 chat 绑定的会话 id',
      ].join('\n'),
    );
    return;
  }

  await feishu.onMessageStart(chatId);
  try {
    const result = await codex.runTurn(chatId, trimmed, {
      onAssistantMessage: async (message) => {
        await feishu.sendText(chatId, message);
      },
      onFinal: async () => {
        await feishu.sendText(chatId, FINAL_REPLY_MARKER);
      },
    });
    if (result.messageCount === 0) {
      await feishu.sendText(chatId, '(Codex 本轮没有返回文本输出)');
      await feishu.sendText(chatId, FINAL_REPLY_MARKER);
    }
  } finally {
    await feishu.onMessageEnd(chatId);
  }
}

function toUserError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

main().catch((error) => {
  console.error('[bridge] Fatal startup error:', error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
