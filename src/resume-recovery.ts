import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Config } from './config.js';

interface TranscriptMessage {
  role: string;
  text: string;
  timestamp?: string;
}

export function buildResumeRecoverySummary(sessionId: string, config: Config): string {
  const transcriptPath = findCodexTranscript(sessionId, config.codexWorkDir);
  if (!transcriptPath) {
    return [
      `Previous Codex thread ${sessionId} could not be resumed.`,
      'No local Codex transcript file for that thread was found on this machine.',
      'Continue from the user\'s current message. If prior context is needed, ask the user for a short recap.',
    ].join('\n');
  }

  const messages = readRecentMessages(transcriptPath, config.resumeRecoveryMaxMessages);
  if (messages.length === 0) {
    return [
      `Previous Codex thread ${sessionId} could not be resumed.`,
      `A local transcript was found at ${transcriptPath}, but no recoverable user/assistant text was extracted.`,
      'Continue from the user\'s current message. If prior context is needed, ask the user for a short recap.',
    ].join('\n');
  }

  const lines = [
    `Previous Codex thread ${sessionId} could not be resumed.`,
    `Recovered partial context from local transcript: ${transcriptPath}`,
    'Use this as continuity context, but treat the user\'s latest message as authoritative.',
    '',
    'Recent recovered messages:',
    ...messages.map((message) => {
      const stamp = message.timestamp ? ` ${message.timestamp}` : '';
      return `- ${message.role}${stamp}: ${message.text}`;
    }),
  ];

  return trimToMaxChars(lines.join('\n'), config.resumeRecoveryMaxChars);
}

export function withRecoveryContext(prompt: string, recoverySummary?: string): string {
  if (!recoverySummary?.trim()) return prompt;
  return [
    '<bridge_resume_recovery>',
    recoverySummary.trim(),
    '</bridge_resume_recovery>',
    '',
    prompt,
  ].join('\n');
}

function findCodexTranscript(sessionId: string, workDir: string): string | undefined {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const sessionsDir = path.join(codexHome, 'sessions');
  const directCandidates = [
    path.join(sessionsDir, projectKey(workDir), `${sessionId}.jsonl`),
    path.join(sessionsDir, projectKey(process.cwd()), `${sessionId}.jsonl`),
    path.join(sessionsDir, `${sessionId}.jsonl`),
  ];

  for (const candidate of directCandidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return findFileByName(sessionsDir, `${sessionId}.jsonl`);
}

function projectKey(dir: string): string {
  return path.resolve(dir).replace(/[:\\/]+/g, '-');
}

function findFileByName(root: string, fileName: string): string | undefined {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isFile() && entry.name === fileName) return fullPath;
      if (entry.isDirectory()) stack.push(fullPath);
    }
  }
  return undefined;
}

function readRecentMessages(filePath: string, maxMessages: number): TranscriptMessage[] {
  let lines: string[];
  try {
    lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }

  const messages: TranscriptMessage[] = [];
  for (let i = lines.length - 1; i >= 0 && messages.length < maxMessages; i -= 1) {
    const message = parseTranscriptLine(lines[i]);
    if (message) messages.push(message);
  }

  return messages.reverse();
}

function parseTranscriptLine(line: string): TranscriptMessage | undefined {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const message = event.message as { role?: string; content?: unknown } | undefined;
  const role = message?.role;
  const item = event.item as Record<string, unknown> | undefined;
  const itemType = typeof item?.type === 'string' ? item.type : '';

  if (itemType === 'agent_message' && typeof item?.text === 'string') {
    return {
      role: 'assistant',
      text: trimToMaxChars(oneLine(item.text), 800),
      timestamp: typeof event.timestamp === 'string' ? event.timestamp : undefined,
    };
  }

  if (role !== 'user' && role !== 'assistant') return undefined;

  const text = extractContentText(message?.content);
  if (!text) return undefined;

  return {
    role,
    text: trimToMaxChars(oneLine(text), 800),
    timestamp: typeof event.timestamp === 'string' ? event.timestamp : undefined,
  };
}

function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const block = item as Record<string, unknown>;
      if (typeof block.text === 'string') return block.text;
      if (typeof block.content === 'string') return block.content;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function trimToMaxChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 18)).trimEnd()}\n...[truncated]`;
}
