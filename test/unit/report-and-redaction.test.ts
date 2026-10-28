import { describe, expect, it } from 'vitest';
import { createRedactor } from '../../src/errors/sanitize.js';
import type { TenantMigrationResult } from '../../src/runner/report.js';
import { isCleanReport, summarize } from '../../src/runner/report.js';

const result = (status: TenantMigrationResult['status']): TenantMigrationResult => ({
  tenantId: 't',
  schema: 's',
  status,
  pendingBeforeRun: [],
  executed: [],
  executedKnown: true,
});

describe('summarize', () => {
  it('counts every status', () => {
    const s = summarize(['success', 'success', 'failed', 'locked', 'skipped', 'not-started', 'not-started'].map((x) => result(x as never)));
    expect(s).toEqual({ total: 7, success: 2, failed: 1, locked: 1, skipped: 1, notStarted: 2 });
  });

  it('treats up-to-date (skipped) tenants as clean, anything unfinished as not clean', () => {
    expect(isCleanReport({ summary: summarize([result('success'), result('skipped')]) })).toBe(true);
    for (const bad of ['failed', 'locked', 'not-started'] as const) {
      expect(isCleanReport({ summary: summarize([result('success'), result(bad)]) })).toBe(false);
    }
  });
});

describe('createRedactor', () => {
  const redact = createRedactor(['s3cr3t-Pass!', 'p@ss.word(1)']);

  it('removes configured secret values, including regex metacharacters', () => {
    expect(redact('auth failed with s3cr3t-Pass! and p@ss.word(1)')).toBe('auth failed with [redacted] and [redacted]');
  });

  it('removes URLs with credentials', () => {
    expect(redact('could not connect to postgres://admin:hunter2@db.internal:5432/app?sslmode=require now')).toBe(
      'could not connect to [redacted-url] now',
    );
    expect(redact('postgresql://u:p@h/db')).toBe('[redacted-url]');
  });

  it('removes password-looking assignments', () => {
    expect(redact('password=abc123 failed')).toBe('password=[redacted] failed');
    expect(redact('Password: "my secret"')).toBe('Password: [redacted]');
  });

  it('ignores empty/undefined/very short secrets rather than mangling every message', () => {
    const r = createRedactor([undefined, '', 'a']);
    expect(r('a normal message')).toBe('a normal message');
  });

  it('leaves ordinary messages untouched', () => {
    expect(redact('relation "orders" does not exist')).toBe('relation "orders" does not exist');
  });
});
