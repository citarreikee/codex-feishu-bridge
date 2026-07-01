import { CodexCliBridge } from './codex-cli.js';
import { CodexSdkBridge } from './codex-sdk.js';
import type { Config } from './config.js';
import type { CodexBridge } from './codex-runner.js';
import { StateStore } from './state-store.js';

export function createCodexBridge(config: Config, store: StateStore): CodexBridge {
  if (config.codexDriver === 'cli') {
    return new CodexCliBridge(config, store);
  }
  return new CodexSdkBridge(config, store);
}
