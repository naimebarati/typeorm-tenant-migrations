// Reads the JSON report of `vitest run --reporter=json` and prints what a person needs from a long CI log: one RESULT line with
// the counts, then every failed test with the first line of its message. Used by the manual workflow old-postgres-probe.yml.
//
//   node scripts/summarize-test-run.mjs probe.json
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/summarize-test-run.mjs <vitest-report.json>');
  process.exit(2);
}
const report = JSON.parse(readFileSync(file, 'utf8'));
const failed = [];
for (const suite of report.testResults ?? []) {
  const where = String(suite.name ?? '').replace(/^.*[\\/]test[\\/]/, 'test/');
  if (suite.status === 'failed' && (suite.assertionResults ?? []).length === 0) {
    failed.push(`${where} (the file itself failed: ${String(suite.message ?? '').split('\n')[0].slice(0, 200)})`);
  }
  for (const test of suite.assertionResults ?? []) {
    if (test.status === 'failed') {
      failed.push(`${where} > ${test.fullName ?? test.title}: ${String((test.failureMessages ?? [''])[0]).split('\n')[0].slice(0, 200)}`);
    }
  }
}
console.log(`RESULT passed=${report.numPassedTests} failed=${report.numFailedTests} skipped=${(report.numPendingTests ?? 0) + (report.numTodoTests ?? 0)} total=${report.numTotalTests} files_failed=${report.numFailedTestSuites}`);
for (const line of failed) console.log(`FAILED ${line}`);
process.exit(0);
