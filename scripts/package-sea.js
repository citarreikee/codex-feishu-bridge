import { spawnSync } from 'node:child_process';
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');
const releases = path.join(root, 'releases');
fs.mkdirSync(releases, { recursive: true });

run('npm', ['run', 'build'], { shell: process.platform === 'win32' });

const seaEntry = path.join(dist, 'sea-cli.cjs');
await esbuild.build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: seaEntry,
});

const seaConfigPath = path.join(dist, 'sea-config.json');
const blobPath = path.join(dist, 'codex-feishu-bridge.blob');
const exeName = process.platform === 'win32' ? 'codex-feishu-bridge.exe' : 'codex-feishu-bridge';
const targetPath = path.join(releases, `${platformName()}-${exeName}`);
const postjectTarget = process.platform === 'win32' ? 'NODE_SEA_BLOB' : 'NODE_SEA_BLOB';

fs.writeFileSync(seaConfigPath, JSON.stringify({
  main: seaEntry,
  output: blobPath,
  disableExperimentalSEAWarning: true,
}, null, 2));

run(process.execPath, ['--experimental-sea-config', seaConfigPath]);
fs.copyFileSync(process.execPath, targetPath);

if (process.platform !== 'win32') {
  fs.chmodSync(targetPath, 0o755);
}

const args = [
  targetPath,
  postjectTarget,
  blobPath,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
];

if (process.platform === 'darwin') {
  args.push('--macho-segment-name', 'NODE_SEA');
}

run(path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'postject.cmd' : 'postject'), args, {
  shell: process.platform === 'win32',
});

console.log(`Release binary written: ${targetPath}`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, ...options });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function platformName() {
  const arch = os.arch();
  if (process.platform === 'win32') return `windows-${arch}`;
  if (process.platform === 'darwin') return `macos-${arch}`;
  return `${process.platform}-${arch}`;
}
