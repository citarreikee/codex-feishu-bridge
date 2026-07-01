import * as lark from '@larksuiteoapi/node-sdk';

import type { Config } from './config.js';
import {
  appendAttachmentContext,
  downloadAttachments,
  parseDirectAttachment,
  parsePostAttachments,
  sendOutboxFiles,
  type PendingAttachment,
  type SavedAttachment,
} from './file-transfer.js';

export interface InboundMessage {
  messageId: string;
  chatId: string;
  userId: string;
  chatType: 'p2p' | 'group';
  text: string;
  attachments: SavedAttachment[];
}

type FeishuMessageEventData = {
  sender: {
    sender_id?: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
    sender_type: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: 'p2p' | 'group';
    message_type: string;
    content: string;
    mentions?: Array<{
      key?: string;
      name?: string;
      id: {
        open_id?: string;
        union_id?: string;
        user_id?: string;
      };
    }>;
  };
};

const DEDUP_MAX = 1000;
const TYPING_EMOJI = 'Typing';
type CardTone = 'info' | 'success' | 'warning' | 'danger';

export class FeishuBot {
  private readonly config: Config;
  private readonly restClient: lark.Client;
  private wsClient: lark.WSClient | null = null;
  private running = false;
  private readonly queue: InboundMessage[] = [];
  private readonly waiters: Array<(message: InboundMessage | null) => void> = [];
  private readonly seenMessageIds = new Map<string, true>();
  private readonly botIds = new Set<string>();
  private readonly lastIncomingMessageId = new Map<string, string>();
  private readonly typingReactions = new Map<string, string>();
  private tenantAccessToken: { value: string; expiresAt: number } | null = null;

  constructor(config: Config) {
    this.config = config;
    this.restClient = new lark.Client({
      appId: config.feishuAppId,
      appSecret: config.feishuAppSecret,
      domain: config.feishuDomain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.resolveBotIdentity();

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        await this.handleIncomingEvent(data as FeishuMessageEventData);
      },
    });

    this.wsClient = new lark.WSClient({
      appId: this.config.feishuAppId,
      appSecret: this.config.feishuAppSecret,
      domain: this.config.feishuDomain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
    });
    this.wsClient.start({ eventDispatcher: dispatcher });
    this.running = true;
    console.log('[bridge] Feishu bot started');
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.wsClient) {
      try {
        this.wsClient.close({ force: true });
      } catch {
        // Ignore SDK shutdown noise.
      }
      this.wsClient = null;
    }
    for (const waiter of this.waiters.splice(0)) {
      waiter(null);
    }
  }

  consumeOne(): Promise<InboundMessage | null> {
    const next = this.queue.shift();
    if (next) return Promise.resolve(next);
    if (!this.running) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const chunks = splitMessage(text, this.config.replyMaxChars);
    for (const chunk of chunks) {
      await this.restClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: chunk }),
        },
      });
    }
  }

  async sendAssistantCard(chatId: string, text: string): Promise<void> {
    if (!this.config.feishuUseCards) {
      await this.sendText(chatId, text);
      return;
    }

    const chunks = splitMessage(text, this.config.replyMaxChars);
    for (const chunk of chunks) {
      await this.sendCardWithFallback(chatId, makeMessageCard('Codex', chunk, 'info'));
    }
  }

  async sendStatusCard(chatId: string, title: string, text: string, tone: CardTone = 'info'): Promise<void> {
    if (!this.config.feishuUseCards) {
      await this.sendText(chatId, `${title}\n${text}`);
      return;
    }
    await this.sendCardWithFallback(chatId, makeMessageCard(title, text, tone));
  }

  async sendRunningStatus(chatId: string): Promise<void> {
    if (!this.config.feishuUseCards) return;
    await this.sendStatusCard(chatId, 'Codex Running', 'Request received. Codex is working on it.', 'warning');
  }

  async sendFinalMarker(chatId: string, marker: string): Promise<void> {
    if (!this.config.feishuUseCards) {
      await this.sendText(chatId, marker);
      return;
    }
    await this.sendStatusCard(chatId, 'Final Answer', marker, 'success');
  }

  async sendPendingOutboxFiles(chatId: string): Promise<void> {
    const result = await sendOutboxFiles(this.restClient, this.config, chatId);
    if (result.sent > 0) {
      console.log(`[bridge] Sent ${result.sent} outbox file(s) to chat ${chatId}`);
    }
    if (result.errors.length > 0) {
      await this.sendStatusCard(
        chatId,
        'Outbox Send Failed',
        result.errors.join('\n'),
        'danger',
      );
    }
  }

  private async sendCardWithFallback(chatId: string, card: Record<string, unknown>): Promise<void> {
    try {
      await this.restClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
    } catch (error) {
      console.warn('[bridge] Failed to send card, falling back to text:', error instanceof Error ? error.message : error);
      await this.sendText(chatId, cardToPlainText(card));
    }
  }

  async onMessageStart(chatId: string): Promise<void> {
    const messageId = this.lastIncomingMessageId.get(chatId);
    if (!messageId) return;

    try {
      const response = await this.restClient.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: TYPING_EMOJI } },
      });
      const reactionId = (response as { data?: { reaction_id?: string } })?.data?.reaction_id;
      if (reactionId) {
        this.typingReactions.set(chatId, reactionId);
      }
    } catch (error) {
      const code = (error as { code?: number })?.code;
      if (code !== 99991400 && code !== 99991403) {
        console.warn('[bridge] Failed to create typing reaction:', error instanceof Error ? error.message : error);
      }
    }
  }

  async onMessageEnd(chatId: string): Promise<void> {
    const reactionId = this.typingReactions.get(chatId);
    const messageId = this.lastIncomingMessageId.get(chatId);
    if (!reactionId || !messageId) return;

    this.typingReactions.delete(chatId);
    try {
      await this.restClient.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    } catch {
      // Best effort.
    }
  }

  private enqueue(message: InboundMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(message);
      return;
    }
    this.queue.push(message);
  }

  private async handleIncomingEvent(data: FeishuMessageEventData): Promise<void> {
    try {
      await this.processIncomingEvent(data);
    } catch (error) {
      console.error('[bridge] Feishu event error:', error instanceof Error ? error.stack || error.message : error);
    }
  }

  private async processIncomingEvent(data: FeishuMessageEventData): Promise<void> {
    const sender = data.sender;
    const message = data.message;
    if (sender.sender_type === 'bot' || sender.sender_type === 'app') return;
    if (this.seenMessageIds.has(message.message_id)) return;
    this.addDedup(message.message_id);

    const userId = sender.sender_id?.open_id
      || sender.sender_id?.user_id
      || sender.sender_id?.union_id
      || '';
    const chatId = message.chat_id;
    const mentionedMe = this.isBotMentioned(message.mentions);

    this.lastIncomingMessageId.set(chatId, message.message_id);

    if (!this.isAuthorized(userId, chatId)) {
      console.log('[bridge] Ignored unauthorized message', { userId, chatId });
      return;
    }

    if (message.chat_type === 'group' && this.config.feishuRequireMention && !mentionedMe) {
      return;
    }

    let text = '';
    let attachments: PendingAttachment[] = [];
    if (message.message_type === 'text') {
      text = this.parseTextContent(message.content, message.mentions);
    } else if (message.message_type === 'post') {
      text = this.parsePostContent(message.content);
      attachments = parsePostAttachments(message.content);
    } else if (['image', 'file', 'audio', 'media', 'video', 'sticker'].includes(message.message_type)) {
      attachments = parseDirectAttachment(message.message_type, message.content);
      text = attachmentFallbackText(message.message_type);
    } else {
      await this.sendText(chatId, 'This bridge currently supports text, image, file, audio, and video messages.');
      return;
    }

    text = text.trim();
    const downloadResult = await downloadAttachments(
      this.restClient,
      this.config,
      message.message_id,
      chatId,
      attachments,
    );
    text = appendAttachmentContext(text, downloadResult.saved, downloadResult.errors).trim();
    if (!text) return;

    this.enqueue({
      messageId: message.message_id,
      chatId,
      userId,
      chatType: message.chat_type,
      text,
      attachments: downloadResult.saved,
    });
  }

  private addDedup(messageId: string): void {
    this.seenMessageIds.set(messageId, true);
    if (this.seenMessageIds.size <= DEDUP_MAX) return;
    const oldest = this.seenMessageIds.keys().next().value;
    if (oldest) {
      this.seenMessageIds.delete(oldest);
    }
  }

  private isAuthorized(userId: string, chatId: string): boolean {
    if (this.config.feishuAllowedUsers.length === 0) return true;
    return this.config.feishuAllowedUsers.includes(userId) || this.config.feishuAllowedUsers.includes(chatId);
  }

  private isBotMentioned(mentions: FeishuMessageEventData['message']['mentions']): boolean {
    if (!mentions || this.botIds.size === 0) return false;
    return mentions.some((mention) => {
      const ids = [mention.id.open_id, mention.id.user_id, mention.id.union_id].filter(Boolean) as string[];
      return ids.some((id) => this.botIds.has(id));
    });
  }

  private parseTextContent(
    content: string,
    mentions?: FeishuMessageEventData['message']['mentions'],
  ): string {
    try {
      const parsed = JSON.parse(content) as { text?: string };
      return normalizeTextMentions(parsed.text || '', mentions);
    } catch {
      return '';
    }
  }

  private parsePostContent(content: string): string {
    try {
      const parsed = JSON.parse(content) as Record<string, {
        content?: Array<Array<{
          tag?: string;
          text?: string;
          user_id?: string;
          user_name?: string;
        }>>;
      }>;
      const localePayload = parsed.zh_cn
        || parsed.en_us
        || parsed.ja_jp
        || Object.values(parsed).find((value) => Array.isArray(value?.content));
      const blocks = localePayload?.content || [];
      const lines = blocks.map((block) => block
        .map((item) => {
          if (item.tag === 'at') {
            const label = item.user_name || item.text || item.user_id || 'mention';
            const userId = item.user_id || label;
            return `<at user_id="${userId}">${label}</at>`;
          }
          return item.text || '';
        })
        .join(''))
        .filter(Boolean);
      return lines.join('\n');
    } catch {
      return '';
    }
  }

  private async resolveBotIdentity(): Promise<void> {
    try {
      const token = await this.getTenantAccessToken();
      const baseUrl = this.getBaseUrl();
      const botResponse = await fetch(`${baseUrl}/open-apis/bot/v3/info/`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const botPayload = await botResponse.json() as {
        bot?: {
          open_id?: string;
          bot_id?: string;
        };
      };

      if (botPayload.bot?.open_id) {
        this.botIds.add(botPayload.bot.open_id);
      }
      if (botPayload.bot?.bot_id) {
        this.botIds.add(botPayload.bot.bot_id);
      }
    } catch (error) {
      console.warn('[bridge] Failed to resolve bot identity:', error instanceof Error ? error.message : error);
    }
  }

  private getBaseUrl(): string {
    return this.config.feishuDomain === 'lark'
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';
  }

  private async getTenantAccessToken(): Promise<string> {
    const cached = this.tenantAccessToken;
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const tokenResponse = await fetch(`${this.getBaseUrl()}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: this.config.feishuAppId,
        app_secret: this.config.feishuAppSecret,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const tokenPayload = await tokenResponse.json() as {
      tenant_access_token?: string;
      expire?: number;
      msg?: string;
    };

    if (!tokenResponse.ok || !tokenPayload.tenant_access_token) {
      throw new Error(tokenPayload.msg || `Failed to obtain tenant token (${tokenResponse.status})`);
    }

    const ttlMs = Math.max(((tokenPayload.expire ?? 7200) - 60), 60) * 1000;
    this.tenantAccessToken = {
      value: tokenPayload.tenant_access_token,
      expiresAt: Date.now() + ttlMs,
    };
    return tokenPayload.tenant_access_token;
  }
}

function attachmentFallbackText(messageType: string): string {
  if (messageType === 'image') return 'User sent an image attachment.';
  if (messageType === 'audio') return 'User sent an audio attachment.';
  if (messageType === 'media' || messageType === 'video') return 'User sent a video/media attachment.';
  if (messageType === 'sticker') return 'User sent a sticker attachment.';
  return 'User sent a file attachment.';
}

function makeMessageCard(title: string, text: string, tone: CardTone): Record<string, unknown> {
  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template: cardTemplate(tone),
      title: {
        tag: 'plain_text',
        content: title,
      },
    },
    elements: [
      {
        tag: 'markdown',
        content: toFeishuMarkdown(text),
      },
    ],
  };
}

function cardTemplate(tone: CardTone): string {
  if (tone === 'success') return 'green';
  if (tone === 'warning') return 'yellow';
  if (tone === 'danger') return 'red';
  return 'blue';
}

function toFeishuMarkdown(text: string): string {
  return text.replace(/\r\n/g, '\n').trim() || '(empty)';
}

function cardToPlainText(card: Record<string, unknown>): string {
  const header = card.header as { title?: { content?: string } } | undefined;
  const elements = card.elements as Array<{ content?: string }> | undefined;
  const title = header?.title?.content || 'Message';
  const content = elements?.map((element) => element.content || '').filter(Boolean).join('\n\n') || '';
  return `${title}\n${content}`.trim();
}

function splitMessage(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    const slice = remaining.slice(0, maxChars);
    const breakAt = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
    const index = breakAt > Math.floor(maxChars * 0.6) ? breakAt : maxChars;
    chunks.push(remaining.slice(0, index).trimEnd());
    remaining = remaining.slice(index).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function normalizeTextMentions(
  text: string,
  mentions?: Array<{
    key?: string;
    name?: string;
    id: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
  }>,
): string {
  if (!text.includes('@_user_') || !mentions?.length) {
    return text;
  }

  let index = 0;
  return text.replace(/@_user_\d+/g, () => {
    const mention = mentions[index];
    index += 1;
    if (!mention) return '@mention';

    const userId = mention.id.open_id || mention.id.user_id || mention.id.union_id || 'mention';
    const label = mention.name || mention.key || userId;
    return `<at user_id="${userId}">${label}</at>`;
  });
}
