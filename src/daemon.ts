import { runBridge } from './main.js';

runBridge().catch((error) => {
  console.error('[bridge] Fatal startup error:', error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
