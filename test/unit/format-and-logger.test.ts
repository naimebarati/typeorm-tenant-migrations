import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatPlan, formatRun, formatStatus } from '../../src/cli/format.js';
import { createConsoleLogger, silentLogger } from '../../src/logger/console-logger.js';
import type { TenantMigrationRunReport } from '../../src/runner/report.js';
import { summarize } from '../../src/runner/report.js';

const base = { pendingBeforeRun: [], executed: [], executedKnown: true };

describe('formatRun', () => {
  const tenants: TenantMigrationRunReport['tenants'] = [
    { ...base, tenantId: 'a', schema: 'tenant_a', status: 'success', pendingBeforeRun: ['M1', 'M2'], executed: ['M1', 'M2'], durationMs: 12 },
    { ...base, tenantId: 'b', schema: 'tenant_b', status: 'skipped' },
    { ...base, tenantId: 'c', schema: 'tenant_c', status: 'failed', pendingBeforeRun: ['M1', 'M2', 'M3'], executed: ['M1'], error: { code: 'MIGRATION_FAILED', message: 'boom' } },
    { ...base, tenantId: 'd', schema: 'tenant_d', status: 'locked', error: { code: 'CONCURRENT_MIGRATION', message: 'busy' } },
    { ...base, tenantId: 'e', schema: 'tenant_e', status: 'not-started' },
    { ...base, tenantId: 'f', schema: 'tenant_f', status: 'failed', pendingBeforeRun: ['M1'], executedKnown: false, error: { code: 'MIGRATION_FAILED', message: 'gone' } },
  ];
  const text = formatRun({ runId: 'r1', startedAt: '', finishedAt: '', summary: summarize(tenants), tenants });

  it('labels every status and keeps the labels aligned', () => {
    for (const label of ['OK', 'UPTODATE', 'FAILED', 'LOCKED', 'NOT RUN']) expect(text).toContain(label);
    const starts = text.split('\n').filter((l) => /^(OK|UPTODATE|FAILED|LOCKED|NOT RUN)\s/.test(l)).map((l) => l.indexOf(' ', 8) >= 0 && l.search(/ [a-f] \(/));
    expect(new Set(starts).size).toBe(1);
  });

  it('shows what ran, what did not, the error, and the summary', () => {
    expect(text).toContain('executed 2:');
    expect(text).toContain('not applied: M2, M3');
    expect(text).toContain('MIGRATION_FAILED: boom');
    expect(text).toContain('CONCURRENT_MIGRATION: busy');
    expect(text).toContain('Summary: 6 tenant(s) — 1 migrated, 1 up to date, 2 failed, 1 locked, 1 not started');
  });

  it('says so when the executed list could not be determined', () => {
    expect(text).toContain('could not be determined');
  });
});

describe('formatPlan / formatStatus', () => {
  const entry = { tenantId: 'a', schema: 'tenant_a', status: 'ok' as const, pending: ['M1'], pendingCount: 1 };
  const summary = { total: 2, ok: 1, failed: 1, pendingTotal: 1 };
  const failed = { tenantId: 'z', schema: 'tenant_z', status: 'failed' as const, pending: [], pendingCount: 0, error: { code: 'SCHEMA_NOT_FOUND', message: 'nope' } };

  it('plan lists pending migrations and states that nothing was changed', () => {
    const text = formatPlan({ startedAt: '', finishedAt: '', summary, tenants: [entry, failed] });
    expect(text).toContain('pending: 1');
    expect(text).toContain('- M1');
    expect(text).toContain('SCHEMA_NOT_FOUND: nope');
    expect(text).toContain('Nothing was changed.');
  });

  it('status shows history presence and migrations unknown to this build', () => {
    const text = formatStatus({
      startedAt: '',
      finishedAt: '',
      summary,
      tenants: [
        { ...entry, known: ['M1'], executed: [], unknownExecuted: ['OldOne'], historyTableExists: false },
        { ...failed, known: [], executed: [], unknownExecuted: [], historyTableExists: false },
      ],
    });
    expect(text).toContain('(no history table yet)');
    expect(text).toContain('in history but unknown to this build');
    expect(text).toContain('- OldOne');
  });
});

describe('loggers', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the default logger is silent', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    silentLogger.info('x');
    silentLogger.warn('x');
    silentLogger.error('x');
    expect(write).not.toHaveBeenCalled();
  });

  it('the console logger writes to stderr only, with metadata, and debug only on request', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logger = createConsoleLogger();
    logger.info('hello', { a: 1 });
    logger.warn('careful');
    logger.error('bad');
    expect(logger.debug).toBeUndefined();
    createConsoleLogger({ debug: true }).debug?.('details');
    const lines = err.mock.calls.map((c) => String(c[0]));
    expect(lines[0]).toBe('[typeorm-tenant-migrations] INFO hello {"a":1}\n');
    expect(lines[1]).toContain('WARN careful');
    expect(lines[2]).toContain('ERROR bad');
    expect(lines[3]).toContain('DEBUG details');
    expect(out).not.toHaveBeenCalled();
  });

  it('can write to a caller-supplied stream instead of process.stderr', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const lines: string[] = [];
    createConsoleLogger({ stream: { write: (t) => lines.push(t) } }).warn('redirected');
    expect(lines).toEqual(['[typeorm-tenant-migrations] WARN redirected\n']);
    expect(err).not.toHaveBeenCalled();
  });
});
