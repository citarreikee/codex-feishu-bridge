import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: {
    daemon: 'src/daemon.ts',
    cli: 'src/cli.ts',
  },
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outdir: 'dist',
  external: ['@larksuiteoapi/node-sdk'],
  sourcemap: true,
  entryNames: '[name]',
  outExtension: { '.js': '.mjs' },
});

console.log('Build complete');
