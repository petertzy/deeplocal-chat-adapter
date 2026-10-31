const esbuild = require('esbuild');
const { copyFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const context = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode', 'koffi'],
    logLevel: 'info',
    plugins: [{
      name: 'status',
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length === 0) {
            // The bundled import guard uses TypeScript at runtime. Keep its
            // license and third-party notices in the distributed extension.
            const typescriptDirectory = dirname(require.resolve('typescript/package.json'));
            for (const name of ['LICENSE.txt', 'ThirdPartyNoticeText.txt']) {
              copyFileSync(join(typescriptDirectory, name), join(__dirname, 'dist', `typescript-${name}`));
            }
            console.log('[build] finished');
          }
        });
      },
    }],
  });

  if (watch) {
    await context.watch();
    console.log('[build] watching...');
    return;
  }

  await context.rebuild();
  await context.dispose();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
