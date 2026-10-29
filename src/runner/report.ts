export type TenantRunStatus = 'success' | 'failed' | 'locked' | 'skipped' | 'not-started';

export interface TenantMigrationResult {
  tenantId: string;
  schema: string;
  status: TenantRunStatus;
  /** Migrations that were pending when the run took the tenant's lock. */
  pendingBeforeRun: string[];
  /** Migrations whose history row appeared during this run (history after minus history before). */
  executed: string[];
  /** False when the history could not be read back after a failure; `executed` is then not trustworthy. */
  executedKnown: boolean;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  error?: {
    code: string;
    /** Sanitized: connection strings, passwords and URLs are removed. */
    message: string;
  };
}

export interface TenantMigrationRunSummary {
  total: number;
  success: number;
  failed: number;
  locked: number;
  skipped: number;
  notStarted: number;
}

export interface TenantMigrationRunReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  summary: TenantMigrationRunSummary;
  /** Present (true) only when the run was stopped through its AbortSignal: tenants not yet started are `not-started`. */
  interrupted?: true;
  tenants: TenantMigrationResult[];
}

export function summarize(results: readonly TenantMigrationResult[]): TenantMigrationRunSummary {
  const summary: TenantMigrationRunSummary = { total: results.length, success: 0, failed: 0, locked: 0, skipped: 0, notStarted: 0 };
  for (const r of results) {
    switch (r.status) {
      case 'success': summary.success++; break;
      case 'failed': summary.failed++; break;
      case 'locked': summary.locked++; break;
      case 'skipped': summary.skipped++; break;
      case 'not-started': summary.notStarted++; break;
    }
  }
  return summary;
}

/** A run is clean when nothing failed, was locked out, or was left unstarted. 'skipped' = already up to date. */
export function isCleanReport(report: Pick<TenantMigrationRunReport, 'summary' | 'interrupted'>): boolean {
  const s = report.summary;
  return !report.interrupted && s.failed === 0 && s.locked === 0 && s.notStarted === 0;
}
