/**
 * Runs every scripts/test-*.mjs file as a child process and fails if any of
 * them exits non-zero. Each file already prints its own pass/fail lines.
 */
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(scriptsDir)
  .filter((f) => f.startsWith('test-') && f.endsWith('.mjs'))
  .sort();

if (files.length === 0) {
  console.error('No scripts/test-*.mjs files found.');
  process.exit(1);
}

function run(file) {
  return new Promise((resolve) => {
    console.log(`\n=== ${file} ===`);
    const child = spawn(process.execPath, [path.join(scriptsDir, file)], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

let failed = 0;
for (const file of files) {
  const code = await run(file);
  if (code !== 0) failed++;
}

console.log(`\n${files.length - failed}/${files.length} test files passed`);
process.exit(failed > 0 ? 1 : 0);
