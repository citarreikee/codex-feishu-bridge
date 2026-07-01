import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/daemon.mjs',
  external: [
    '@larksuiteoapi/node-sdk',
    'node:child_process',
    'node:events',
    'node:fs',
    'node:os',
    'node:path',
    'node:readline',
  ],
});

console.log('Built dist/daemon.mjs');
