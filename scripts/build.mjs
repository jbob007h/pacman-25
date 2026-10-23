// Bundles src/main.ts and inlines it into a single self-contained dist/index.html, and
// bundles the game server (server/main.ts) into dist/server.mjs.
// Usage: node scripts/build.mjs [--watch]
import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

async function inline(code) {
  const template = await readFile(path.join(root, 'src/index.html'), 'utf8');
  // Guard against a literal closing script tag inside the bundle.
  const safe = code.replace(/<\/script/gi, '<\\/script');
  const html = template.replace('<!--BUNDLE-->', () => `<script>\n${safe}\n</script>`);
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await writeFile(path.join(root, 'dist/index.html'), html);
  console.log(`dist/index.html written (${(html.length / 1024).toFixed(1)} KB)`);
  // Variant without the document wrapper, for hosts that supply their own <head>/<body>
  // (e.g. publishing as a claude.ai artifact).
  const fragment = html
    .replace(/<!doctype html>\s*/i, '')
    .replace(/<html[^>]*>\s*/i, '').replace(/<\/html>\s*/i, '')
    .replace(/<head>\s*/i, '').replace(/<\/head>\s*/i, '')
    .replace(/<body>\s*/i, '').replace(/<\/body>\s*/i, '')
    .replace(/<meta charset[^>]*>\s*/i, '').replace(/<meta name="viewport"[^>]*>\s*/i, '');
  await writeFile(path.join(root, 'dist/embed.html'), fragment);
}

const options = {
  entryPoints: [path.join(root, 'src/main.ts')],
  bundle: true,
  minify: !watch,
  format: 'iife',
  target: 'es2020',
  write: false,
  logLevel: 'warning',
};

if (watch) {
  const ctx = await esbuild.context({
    ...options,
    plugins: [{
      name: 'inline-html',
      setup(build) {
        build.onEnd(async (result) => {
          if (result.errors.length === 0 && result.outputFiles) await inline(result.outputFiles[0].text);
        });
      },
    }],
  });
  await ctx.watch();
  console.log('Watching src/ — open dist/index.html in a browser and reload after changes.');
} else {
  const result = await esbuild.build(options);
  await inline(result.outputFiles[0].text);
}

// The game server: one ES module for Node, with `ws` left as a runtime dependency.
await esbuild.build({
  entryPoints: [path.join(root, 'server/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['ws'],
  outfile: path.join(root, 'dist/server.mjs'),
  logLevel: 'warning',
});
console.log('dist/server.mjs written');
