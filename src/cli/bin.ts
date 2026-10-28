#!/usr/bin/env node
import { runCli } from './main.js';

runCli(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, cwd: process.cwd() }).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.stderr.write('error [INTERNAL_ERROR]: Unexpected internal error.\n');
    process.exitCode = 70;
  },
);
