// tsc does not set the executable bit; npm does on install for "bin" entries, but keep dist/ directly runnable too.
import { chmodSync } from 'node:fs';

chmodSync(new URL('../dist/cli/bin.js', import.meta.url), 0o755);
