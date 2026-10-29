import type { TenantInspectionReport, TenantPlanEntry, TenantStatusEntry } from '../runner/tenant-migration-runner.js';
import type { TenantMigrationRunReport } from '../runner/report.js';

const LABEL: Record<string, string> = Object.fromEntries(
  Object.entries({ success: 'OK', ok: 'OK', skipped: 'UPTODATE', failed: 'FAILED', locked: 'LOCKED', 'not-started': 'NOT RUN' }).map(([k, v]) => [k, v.padEnd(8)]),
);

const list = (items: readonly string[], indent = '      ') => items.map((i) => `${indent}- ${i}`);

export function formatRun(report: TenantMigrationRunReport): string {
  const lines: string[] = [`Run ${report.runId}`];
  for (const t of report.tenants) {
    lines.push(`${LABEL[t.status]} ${t.tenantId} (${t.schema})${t.durationMs !== undefined ? `  ${t.durationMs} ms` : ''}`);
    if (t.executed.length) lines.push(`    executed ${t.executed.length}:`, ...list(t.executed));
    if (!t.executedKnown) lines.push('    executed migrations could not be determined; check the tenant history table.');
    if (t.status === 'failed' && t.pendingBeforeRun.length && t.executed.length < t.pendingBeforeRun.length) {
      lines.push(`    not applied: ${t.pendingBeforeRun.filter((n) => !t.executed.includes(n)).join(', ')}`);
    }
    if (t.error) lines.push(`    ${t.error.code}: ${t.error.message}`);
  }
  if (report.interrupted) lines.push('Interrupted: tenants that had not started were left untouched (NOT RUN).');
  const s = report.summary;
  lines.push(`Summary: ${s.total} tenant(s) — ${s.success} migrated, ${s.skipped} up to date, ${s.failed} failed, ${s.locked} locked, ${s.notStarted} not started`);
  return lines.join('\n');
}

export function formatPlan(report: TenantInspectionReport<TenantPlanEntry>): string {
  const lines: string[] = [];
  for (const t of report.tenants) {
    lines.push(`${LABEL[t.status]} ${t.tenantId} (${t.schema})  pending: ${t.pendingCount}`);
    if (t.pending.length) lines.push(...list(t.pending));
    if (t.error) lines.push(`    ${t.error.code}: ${t.error.message}`);
  }
  const s = report.summary;
  lines.push(`Summary: ${s.total} tenant(s) — ${s.pendingTotal} pending migration(s) in total, ${s.failed} tenant(s) could not be inspected. Nothing was changed.`);
  return lines.join('\n');
}

export function formatStatus(report: TenantInspectionReport<TenantStatusEntry>): string {
  const lines: string[] = [];
  for (const t of report.tenants) {
    lines.push(`${LABEL[t.status]} ${t.tenantId} (${t.schema})  executed: ${t.executed.length}  pending: ${t.pendingCount}${t.historyTableExists ? '' : '  (no history table yet)'}`);
    if (t.pending.length) lines.push('    pending:', ...list(t.pending));
    if (t.unknownExecuted.length) lines.push('    in history but unknown to this build:', ...list(t.unknownExecuted));
    if (t.error) lines.push(`    ${t.error.code}: ${t.error.message}`);
  }
  const s = report.summary;
  lines.push(`Summary: ${s.total} tenant(s) — ${s.pendingTotal} pending migration(s) in total, ${s.failed} tenant(s) could not be inspected. Nothing was changed.`);
  return lines.join('\n');
}
