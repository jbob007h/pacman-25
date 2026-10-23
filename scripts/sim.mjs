// Runs bot-only matches headlessly and prints a summary of each.
// Usage: node scripts/sim.mjs [matches=3] [firstSeed=1] [--verbose]
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const verbose = process.argv.includes('--verbose');
const matches = Number(args[0] ?? 3);
const firstSeed = Number(args[1] ?? 1);

const out = await esbuild.build({
  entryPoints: [path.join(root, 'src/headless.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  logLevel: 'warning',
});
const mod = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));

for (let i = 0; i < matches; i++) {
  const r = mod.runMatch(firstSeed + i);
  const mins = `${Math.floor(r.seconds / 60)}m${String(r.seconds % 60).padStart(2, '0')}s`;
  console.log(
    `seed ${r.seed}: ${mins} winner=${r.winner} collapsed=${r.collapsed} ghosts=${r.ghostsEaten} ` +
    `raiders=${r.raidersSent} fruits=${r.fruits} powerups=${r.powerUps} maxLv=${r.maxLevel} (${r.ms} ms)`,
  );
  if (verbose) for (const line of r.timeline) console.log('   ' + line);
}
