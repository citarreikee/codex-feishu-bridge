import fs from 'node:fs';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { CONFIG_PATH } from './config.js';
import { runBridge } from './main.js';
import { currentStatus, readLogs, startDaemon, stopDaemon } from './process-manager.js';
import { runSetup } from './setup.js';

const command = process.argv[2] || 'wizard';

async function main(): Promise<void> {
  switch (command) {
    case 'wizard':
      await runSetup({ assumeYes: process.argv.includes('--yes') || process.argv.includes('-y') });
      startAndReport();
      await waitBeforeExit();
      return;
    case 'setup':
      await runSetup({ assumeYes: process.argv.includes('--yes') || process.argv.includes('-y') });
      if (process.argv.includes('--start')) {
        startAndReport();
      }
      return;
    case 'start': {
      startAndReport();
      return;
    }
    case 'stop':
      console.log(stopDaemon());
      return;
    case 'restart': {
      console.log(stopDaemon());
      const result = startDaemon(...resolveRunCommand());
      console.log(result.message);
      return;
    }
    case 'status': {
      const status = currentStatus();
      console.log(status.running ? `Bridge running (PID: ${status.pid})` : 'Bridge not running');
      console.log(`Config: ${CONFIG_PATH}`);
      return;
    }
    case 'logs': {
      const lines = Number(process.argv[3] || '80');
      console.log(readLogs(Number.isFinite(lines) ? lines : 80));
      return;
    }
    case 'run':
      await runBridge();
      return;
    case 'help':
    default:
      printHelp();
  }
}

async function waitBeforeExit(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  const rl = readline.createInterface({ input, output });
  try {
    await rl.question('Press Enter to close this window...');
  } finally {
    rl.close();
  }
}

function startAndReport(): void {
  const result = startDaemon(...resolveRunCommand());
  console.log(result.message);
  if (result.pid) {
    console.log('Bridge connected. You can now talk to your Feishu bot.');
  }
}

function resolveRunCommand(): [string, string[]] {
  const current = process.argv[1] || '';
  if (fs.existsSync(current) && /\.(mjs|js)$/i.test(current)) {
    return [process.execPath, [current, 'run']];
  }
  return [process.execPath, ['run']];
}

function printHelp(): void {
  console.log([
    'Codex Feishu Bridge',
    '',
    'Commands:',
    '  wizard      Default. Run setup, write config, and start the bridge.',
    '  setup       Interactive setup. Installs Codex CLI if needed and writes bridge config.',
    '  start       Start the Feishu bridge in the background.',
    '  stop        Stop the background bridge.',
    '  restart     Restart the background bridge.',
    '  status      Show bridge status and config path.',
    '  logs [N]    Show recent bridge logs.',
    '  run         Run the bridge in the foreground.',
    '',
    'Typical first run:',
    '  codex-feishu-bridge',
  ].join('\n'));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
