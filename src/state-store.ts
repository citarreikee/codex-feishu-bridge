import fs from 'node:fs';
import path from 'node:path';

export interface ChatState {
  sessionId?: string;
  recoveredFromSessionId?: string;
  recoverySummary?: string;
  recoverySummaryUpdatedAt?: string;
  updatedAt: string;
}

interface StoreShape {
  chats: Record<string, ChatState>;
}

export class StateStore {
  private readonly filePath: string;
  private state: StoreShape;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'chats.json');
    this.state = this.load();
  }

  getSessionId(chatId: string): string | undefined {
    return this.state.chats[chatId]?.sessionId;
  }

  setSessionId(chatId: string, sessionId: string): void {
    this.state.chats[chatId] = {
      ...this.state.chats[chatId],
      sessionId,
      updatedAt: new Date().toISOString(),
    };
    this.save();
  }

  setRecoverySummary(chatId: string, sessionId: string, summary: string): void {
    this.state.chats[chatId] = {
      ...this.state.chats[chatId],
      recoveredFromSessionId: sessionId,
      recoverySummary: summary,
      recoverySummaryUpdatedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.save();
  }

  getRecoverySummary(chatId: string): string | undefined {
    return this.state.chats[chatId]?.recoverySummary;
  }

  clearSession(chatId: string): void {
    this.state.chats[chatId] = {
      ...this.state.chats[chatId],
      sessionId: undefined,
      updatedAt: new Date().toISOString(),
    };
    this.save();
  }

  private load(): StoreShape {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as StoreShape;
      if (!parsed?.chats) {
        return { chats: {} };
      }

      for (const chatState of Object.values(parsed.chats)) {
        const legacySessionFile = (chatState as ChatState & { sessionFile?: string })?.sessionFile;
        if (legacySessionFile && !chatState.sessionId) {
          chatState.sessionId = legacySessionFile;
          delete (chatState as ChatState & { sessionFile?: string }).sessionFile;
        }
      }

      return parsed;
    } catch {
      return { chats: {} };
    }
  }

  private save(): void {
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2), 'utf-8');
    fs.renameSync(tmpPath, this.filePath);
  }
}
