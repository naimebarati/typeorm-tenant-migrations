// Fails when an installed dependency is not the version a CI matrix entry asked for.
// Usage: node scripts/assert-versions.mjs typeorm 0.3 pg 8.5.1
// A wanted value is either an exact version ("0.3.20") or a line ("0.3", "1", "8") meaning any version in it.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.length === 0 || args.length % 2 !== 0) {
  console.error('usage: assert-versions.mjs <package> <wanted> [<package> <wanted> ...]');
  process.exit(2);
}

let failed = false;
for (let i = 0; i < args.length; i += 2) {
  const [name, wanted] = [args[i], args[i + 1]];
  const installed = JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version;
  const ok = installed === wanted || installed.startsWith(`${wanted}.`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: wanted ${wanted}, installed ${installed}`);
  if (!ok) failed = true;
}
process.exit(failed ? 1 : 0);
