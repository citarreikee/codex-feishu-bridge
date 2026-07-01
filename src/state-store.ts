import fs from 'node:fs';
import path from 'node:path';

export interface ChatState {
  sessionId?: string;
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
      sessionId,
      updatedAt: new Date().toISOString(),
    };
    this.save();
  }

  clearSession(chatId: string): void {
    this.state.chats[chatId] = {
      updatedAt: new Date().toISOString(),
    };
    this.save();
  }

  getChatState(chatId: string): ChatState | undefined {
    return this.state.chats[chatId];
  }

  private load(): StoreShape {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as StoreShape;
      return parsed?.chats ? parsed : { chats: {} };
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
