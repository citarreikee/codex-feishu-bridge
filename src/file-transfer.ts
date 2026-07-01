import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import * as lark from '@larksuiteoapi/node-sdk';

import type { Config } from './config.js';

export type AttachmentKind = 'image' | 'file' | 'audio' | 'media' | 'video' | 'sticker';

export interface PendingAttachment {
  kind: AttachmentKind;
  fileKey: string;
  fileName?: string;
  resourceType: 'image' | 'file' | 'media';
  placeholder: string;
}

export interface SavedAttachment {
  kind: AttachmentKind;
  path: string;
  fileName: string;
  sizeBytes: number;
  contentType?: string;
  placeholder: string;
}

export interface AttachmentDownloadResult {
  saved: SavedAttachment[];
  errors: string[];
}

export interface OutboxSendResult {
  sent: number;
  errors: string[];
}

type FeishuDownloadResponse = {
  writeFile?: (filePath: string) => Promise<unknown>;
  getReadableStream?: () => NodeJS.ReadableStream;
  headers?: Record<string, unknown>;
};

type OutboxManifest = {
  files?: Array<{
    path?: string;
    caption?: string;
  }>;
};

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.ico', '.tiff']);

export function parseDirectAttachment(messageType: string, content: string): PendingAttachment[] {
  const parsed = parseJsonRecord(content);
  if (!parsed) return [];

  const imageKey = normalizeExternalKey(readString(parsed.image_key));
  const fileKey = normalizeExternalKey(readString(parsed.file_key));
  const fileName = readString(parsed.file_name) || readString(parsed.name);

  if (messageType === 'image' && imageKey) {
    return [{
      kind: 'image',
      fileKey: imageKey,
      fileName,
      resourceType: 'image',
      placeholder: '<media:image>',
    }];
  }

  if (['file', 'audio', 'sticker'].includes(messageType) && fileKey) {
    return [{
      kind: messageType as AttachmentKind,
      fileKey,
      fileName,
      resourceType: 'file',
      placeholder: inferPlaceholder(messageType),
    }];
  }

  if (['media', 'video'].includes(messageType)) {
    const key = fileKey || imageKey;
    if (!key) return [];
    return [{
      kind: messageType as AttachmentKind,
      fileKey: key,
      fileName,
      resourceType: fileKey ? 'file' : 'image',
      placeholder: '<media:video>',
    }];
  }

  return [];
}

export function parsePostAttachments(content: string): PendingAttachment[] {
  const parsed = parseJsonRecord(content);
  const payload = resolvePostPayload(parsed);
  if (!payload) return [];

  const attachments: PendingAttachment[] = [];
  for (const paragraph of payload.content) {
    if (!Array.isArray(paragraph)) continue;
    for (const raw of paragraph) {
      const element = isRecord(raw) ? raw : undefined;
      const tag = readString(element?.tag).toLowerCase();
      if (tag === 'img') {
        const imageKey = normalizeExternalKey(readString(element?.image_key));
        if (imageKey) {
          attachments.push({
            kind: 'image',
            fileKey: imageKey,
            fileName: readString(element?.file_name),
            resourceType: 'image',
            placeholder: '<media:image>',
          });
        }
      }
      if (tag === 'media') {
        const fileKey = normalizeExternalKey(readString(element?.file_key));
        if (fileKey) {
          attachments.push({
            kind: 'media',
            fileKey,
            fileName: readString(element?.file_name),
            resourceType: 'file',
            placeholder: '<media:video>',
          });
        }
      }
    }
  }
  return attachments;
}

export async function downloadAttachments(
  client: lark.Client,
  config: Config,
  messageId: string,
  chatId: string,
  attachments: PendingAttachment[],
): Promise<AttachmentDownloadResult> {
  if (!config.fileTransferEnabled || attachments.length === 0) {
    return { saved: [], errors: [] };
  }

  const saved: SavedAttachment[] = [];
  const errors: string[] = [];

  for (const attachment of attachments) {
    try {
      saved.push(await downloadOneAttachment(client, config, messageId, chatId, attachment));
    } catch (error) {
      errors.push(`${attachment.fileName || attachment.fileKey}: ${formatError(error)}`);
    }
  }

  return { saved, errors };
}

export function formatAttachmentsForPrompt(attachments: SavedAttachment[], errors: string[]): string {
  const lines: string[] = [];
  if (attachments.length > 0) {
    lines.push('Attachments saved locally for this Feishu message:');
    for (const attachment of attachments) {
      const meta = [
        `${attachment.sizeBytes} bytes`,
        attachment.contentType,
        attachment.kind,
      ].filter(Boolean).join(', ');
      lines.push(`- ${attachment.fileName}: ${attachment.path}${meta ? ` (${meta})` : ''}`);
    }
  }
  if (errors.length > 0) {
    lines.push('Attachment download errors:');
    for (const error of errors) {
      lines.push(`- ${error}`);
    }
  }
  return lines.join('\n');
}

export function appendAttachmentContext(text: string, attachments: SavedAttachment[], errors: string[]): string {
  const context = formatAttachmentsForPrompt(attachments, errors);
  if (!context) return text;
  return [text, context].filter((part) => part.trim()).join('\n\n');
}

export async function sendOutboxFiles(
  client: lark.Client,
  config: Config,
  chatId: string,
): Promise<OutboxSendResult> {
  if (!config.fileTransferEnabled) return { sent: 0, errors: [] };

  const manifestPath = path.join(config.fileOutboxDir, sanitizePathSegment(chatId), 'send.json');
  if (!fs.existsSync(manifestPath)) return { sent: 0, errors: [] };

  const errors: string[] = [];
  let sent = 0;
  let manifest: OutboxManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as OutboxManifest;
  } catch (error) {
    return { sent: 0, errors: [`Invalid outbox manifest: ${formatError(error)}`] };
  }

  const files = Array.isArray(manifest.files) ? manifest.files : [];
  for (const entry of files) {
    const filePath = entry?.path?.trim();
    if (!filePath) continue;
    try {
      await sendLocalFile(client, config, chatId, filePath, entry.caption);
      sent += 1;
    } catch (error) {
      errors.push(`${filePath}: ${formatError(error)}`);
    }
  }

  const processedPath = `${manifestPath}.${Date.now()}.sent`;
  try {
    fs.renameSync(manifestPath, processedPath);
  } catch (error) {
    errors.push(`Failed to archive outbox manifest: ${formatError(error)}`);
  }

  return { sent, errors };
}

async function downloadOneAttachment(
  client: lark.Client,
  config: Config,
  messageId: string,
  chatId: string,
  attachment: PendingAttachment,
): Promise<SavedAttachment> {
  const safeChatId = sanitizePathSegment(chatId);
  const safeMessageId = sanitizePathSegment(messageId);
  const dir = path.join(config.fileDownloadDir, safeChatId, safeMessageId);
  fs.mkdirSync(dir, { recursive: true });

  const fileName = sanitizeFileName(attachment.fileName || defaultAttachmentName(attachment));
  const targetPath = uniqueFilePath(path.join(dir, fileName));
  const response = await downloadResource(client, messageId, attachment);
  await writeDownloadResponse(response, targetPath);

  const stat = fs.statSync(targetPath);
  if (stat.size > config.fileMaxDownloadBytes) {
    fs.unlinkSync(targetPath);
    throw new Error(`file exceeds download limit (${Math.round(config.fileMaxDownloadBytes / 1024 / 1024)}MB)`);
  }

  return {
    kind: attachment.kind,
    path: targetPath,
    fileName: path.basename(targetPath),
    sizeBytes: stat.size,
    contentType: readHeader(response.headers, 'content-type'),
    placeholder: attachment.placeholder,
  };
}

async function downloadResource(
  client: lark.Client,
  messageId: string,
  attachment: PendingAttachment,
): Promise<FeishuDownloadResponse> {
  const api = client.im.messageResource as unknown as {
    get(payload: {
      path: { message_id: string; file_key: string };
      params: { type: string };
    }): Promise<FeishuDownloadResponse>;
  };

  try {
    return await api.get({
      path: {
        message_id: messageId,
        file_key: attachment.fileKey,
      },
      params: { type: attachment.resourceType === 'image' ? 'image' : 'file' },
    });
  } catch (error) {
    if (attachment.resourceType !== 'file') throw error;
    return api.get({
      path: {
        message_id: messageId,
        file_key: attachment.fileKey,
      },
      params: { type: 'media' },
    });
  }
}

async function writeDownloadResponse(response: FeishuDownloadResponse, targetPath: string): Promise<void> {
  if (typeof response.writeFile === 'function') {
    await response.writeFile(targetPath);
    return;
  }
  if (typeof response.getReadableStream === 'function') {
    await pipeline(response.getReadableStream(), fs.createWriteStream(targetPath));
    return;
  }
  throw new Error('unexpected Feishu download response');
}

async function sendLocalFile(
  client: lark.Client,
  config: Config,
  chatId: string,
  filePath: string,
  caption?: string,
): Promise<void> {
  const resolvedPath = resolveAllowedSendPath(filePath, config.fileSendRoots);
  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) throw new Error('path is not a regular file');
  if (stat.size <= 0) throw new Error('file is empty');
  if (stat.size > config.fileMaxUploadBytes) {
    throw new Error(`file exceeds upload limit (${Math.round(config.fileMaxUploadBytes / 1024 / 1024)}MB)`);
  }

  if (caption?.trim()) {
    await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: caption.trim() }),
      },
    });
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  if (IMAGE_EXTS.has(ext)) {
    const uploaded = await client.im.image.create({
      data: {
        image_type: 'message',
        image: fs.createReadStream(resolvedPath),
      },
    });
    if (!uploaded?.image_key) throw new Error('Feishu image upload returned no image_key');
    await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'image',
        content: JSON.stringify({ image_key: uploaded.image_key }),
      },
    });
    return;
  }

  const uploaded = await client.im.file.create({
    data: {
      file_type: detectFeishuFileType(resolvedPath),
      file_name: sanitizeFileName(path.basename(resolvedPath)),
      file: fs.createReadStream(resolvedPath),
    },
  });
  if (!uploaded?.file_key) throw new Error('Feishu file upload returned no file_key');
  await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'file',
      content: JSON.stringify({ file_key: uploaded.file_key }),
    },
  });
}

function detectFeishuFileType(filePath: string): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
  switch (path.extname(filePath).toLowerCase()) {
    case '.opus':
    case '.ogg':
      return 'opus';
    case '.mp4':
    case '.mov':
    case '.avi':
      return 'mp4';
    case '.pdf':
      return 'pdf';
    case '.doc':
    case '.docx':
      return 'doc';
    case '.xls':
    case '.xlsx':
      return 'xls';
    case '.ppt':
    case '.pptx':
      return 'ppt';
    default:
      return 'stream';
  }
}

function resolveAllowedSendPath(filePath: string, roots: string[]): string {
  const resolved = path.resolve(filePath);
  const allowed = roots.some((root) => {
    const resolvedRoot = path.resolve(root);
    const relative = path.relative(resolvedRoot, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
  if (!allowed) {
    throw new Error('file is outside CFB_FILE_SEND_ROOTS');
  }
  return resolved;
}

function uniqueFilePath(basePath: string): string {
  if (!fs.existsSync(basePath)) return basePath;
  const parsed = path.parse(basePath);
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('failed to allocate unique attachment path');
}

function sanitizeFileName(value: string): string {
  const withoutControls = value.replace(/[\p{Cc}"\\/:*?<>|]/gu, '_').trim();
  const cleaned = path.basename(withoutControls).replace(/^\.+$/, '').trim();
  return cleaned || 'attachment.bin';
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'unknown';
}

function defaultAttachmentName(attachment: PendingAttachment): string {
  if (attachment.kind === 'image') return 'image';
  if (attachment.kind === 'audio') return 'audio';
  if (attachment.kind === 'media' || attachment.kind === 'video') return 'media';
  return 'attachment.bin';
}

function inferPlaceholder(messageType: string): string {
  if (messageType === 'image') return '<media:image>';
  if (messageType === 'audio') return '<media:audio>';
  if (messageType === 'media' || messageType === 'video') return '<media:video>';
  if (messageType === 'sticker') return '<media:sticker>';
  return '<media:document>';
}

function parseJsonRecord(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeExternalKey(value: string): string | undefined {
  if (!value || value.length > 512) return undefined;
  if (/[\p{Cc}]/u.test(value)) return undefined;
  if (value.includes('/') || value.includes('\\') || value.includes('..')) return undefined;
  return value;
}

function resolvePostPayload(candidate: Record<string, unknown> | null): { content: unknown[]; title?: string } | null {
  if (!candidate) return null;
  const direct = toPostPayload(candidate);
  if (direct) return direct;
  const wrapped = isRecord(candidate.post) ? resolveLocalePayload(candidate.post) : null;
  if (wrapped) return wrapped;
  return resolveLocalePayload(candidate);
}

function resolveLocalePayload(candidate: Record<string, unknown>): { content: unknown[]; title?: string } | null {
  const direct = toPostPayload(candidate);
  if (direct) return direct;
  for (const value of Object.values(candidate)) {
    if (!isRecord(value)) continue;
    const payload = toPostPayload(value);
    if (payload) return payload;
  }
  return null;
}

function toPostPayload(candidate: Record<string, unknown>): { content: unknown[]; title?: string } | null {
  if (!Array.isArray(candidate.content)) return null;
  return {
    content: candidate.content,
    title: readString(candidate.title),
  };
}

function readHeader(headers: Record<string, unknown> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      const first = value.find((entry) => typeof entry === 'string');
      if (typeof first === 'string') return first;
    }
  }
  return undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
