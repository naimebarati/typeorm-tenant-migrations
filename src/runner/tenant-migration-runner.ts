import { randomUUID } from 'node:crypto';
import { validateOptions, validateTableName } from '../config/validate-config.js';
import type { ResolvedOptions, TenantMigrationRunnerConfig, TenantMigrationTarget, TenantProvider, TenantSelection } from '../config/types.js';
import { TenantMigrationError } from '../errors/index.js';
import { createRedactor } from '../errors/sanitize.js';
import { warnIfConnectionBudgetIsTight } from '../postgres/connection-budget.js';
import { buildTenantDataSourceOptions, collectSecrets, resolveBaseOptions } from '../postgres/create-tenant-data-source.js';
import { resolveTenants } from '../tenants/tenant-provider.js';
import { selectTargets } from '../tenants/select-targets.js';
import type { TenantMigrationResult, TenantMigrationRunReport } from './report.js';
import { summarize } from './report.js';
import type { RunnerContext, TenantInspection } from './tenant-worker.js';
import { executeTenant, inspectTenant } from './tenant-worker.js';
import { runPool } from './worker-pool.js';

export interface TargetParams {
  target: TenantSelection;
}

export interface RunParams extends TargetParams {
  /**
   * Graceful stop. When aborted, no further tenant is started (they are reported `not-started`),
   * a tenant waiting for its lock gives up, and tenants already migrating run to completion:
   * a migration is never cancelled midway. The report carries `interrupted: true`.
   */
  signal?: AbortSignal;
}

export interface TenantPlanEntry {
  tenantId: string;
  schema: string;
  status: 'ok' | 'failed';
  pending: string[];
  pendingCount: number;
  error?: { code: string; message: string };
}

export interface TenantStatusEntry extends TenantPlanEntry {
  /** Migrations known to this build of the app, in execution order. */
  known: string[];
  executed: string[];
  /** Recorded in the tenant's history but unknown to this build (e.g. after rolling the app back). */
  unknownExecuted: string[];
  historyTableExists: boolean;
}

export interface TenantInspectionReport<T> {
  startedAt: string;
  finishedAt: string;
  summary: { total: number; ok: number; failed: number; pendingTotal: number };
  tenants: T[];
}

export class TenantMigrationRunner {
  private readonly tenants: TenantProvider;
  private readonly ctx: RunnerContext;

  /**
   * Validates everything that can be validated without touching the database, so that a bad
   * configuration fails here, loudly, before any connection is opened.
   */
  constructor(config: TenantMigrationRunnerConfig) {
    if (!config || typeof config !== 'object') {
      throw new TenantMigrationError('INVALID_CONFIGURATION', 'A runner config object is required.');
    }
    if (config.tenants === undefined || (typeof config.tenants !== 'function' && !Array.isArray(config.tenants))) {
      throw new TenantMigrationError('INVALID_CONFIGURATION', '"tenants" must be an array or a function returning one.');
    }
    const { options, logger } = validateOptions(config.options);
    const base = resolveBaseOptions(config.dataSource);
    const historyTable = validateTableName('migrationsTableName', options.migrationsTableName ?? base.migrationsTableName ?? 'migrations');

    // Dry build: surfaces search_path conflicts now and warns once about overridden base flags.
    buildTenantDataSourceOptions(base, { schema: 'validation_probe', searchPath: ['validation_probe'] }, logger);

    this.tenants = config.tenants;
    this.ctx = { base, options, logger, redact: createRedactor(collectSecrets(base)), historyTable };
  }

  get resolvedOptions(): Readonly<ResolvedOptions> {
    return this.ctx.options;
  }

  /** What `run` would execute, per tenant. Read-only: never creates a table or schema. */
  async plan(params: TargetParams): Promise<TenantInspectionReport<TenantPlanEntry>> {
    const report = await this.status(params);
    return {
      ...report,
      tenants: report.tenants.map(({ tenantId, schema, status, pending, pendingCount, error }) => ({
        tenantId, schema, status, pending, pendingCount, ...(error ? { error } : {}),
      })),
    };
  }

  /** Executed / pending / unknown migrations per tenant. Read-only. */
  async status(params: TargetParams): Promise<TenantInspectionReport<TenantStatusEntry>> {
    const startedAt = new Date().toISOString();
    const targets = await this.selectTargets(params);
    const inspections = await this.inspectAll(targets, () => false);
    const tenants = inspections.map((i) => toStatusEntry(i!));
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      summary: {
        total: tenants.length,
        ok: tenants.filter((t) => t.status === 'ok').length,
        failed: tenants.filter((t) => t.status === 'failed').length,
        pendingTotal: tenants.reduce((n, t) => n + t.pendingCount, 0),
      },
      tenants,
    };
  }

  /**
   * Migrates the selected tenants. Configuration and selection errors throw; everything that
   * happens per tenant is reported, never thrown.
   */
  async run(params: RunParams): Promise<TenantMigrationRunReport> {
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const { continueOnError, concurrency } = this.ctx.options;
    const signal = params?.signal;
    const aborted = () => signal?.aborted === true;
    const targets = await this.selectTargets(params);
    const results = new Array<TenantMigrationResult | undefined>(targets.length).fill(undefined);
    const log = this.ctx.logger;
    log.info(`Run ${runId}: ${targets.length} tenant(s), concurrency ${concurrency}, transaction '${this.ctx.options.transaction}'.`);

    await warnIfConnectionBudgetIsTight(this.ctx.base, concurrency, log, this.ctx.redact);

    // 1. Preflight, read-only, for the whole batch: a missing schema or a broken migration list
    //    stops everything before the first change (unless continueOnError was explicitly chosen).
    let preflightFailed = false;
    const inspections = await this.inspectAll(targets, () => aborted() || (!continueOnError && preflightFailed), (i) => {
      if (i.status === 'failed') preflightFailed = true;
    });
    const runnable: number[] = [];
    inspections.forEach((inspection, index) => {
      if (!inspection) return; // not started
      if (inspection.status === 'failed') {
        results[index] = fromFailedPreflight(targets[index]!, inspection);
      } else if (inspection.pending.length === 0) {
        results[index] = { ...baseResult(targets[index]!), status: 'skipped' };
      } else {
        runnable.push(index);
      }
    });

    // 2. Execute, unless preflight failed and the caller hasn't asked to continue past failures.
    if (!(preflightFailed && !continueOnError) && !aborted()) {
      let failure = false;
      await runPool(
        runnable,
        concurrency,
        async (index) => {
          const result = await executeTenant(this.ctx, targets[index]!, signal);
          results[index] = result;
          if (result.status === 'failed' || result.status === 'locked') failure = true;
        },
        () => aborted() || (!continueOnError && failure),
      );
    }

    const tenants = targets.map((t, i) => results[i] ?? { ...baseResult(t), status: 'not-started' as const });
    const report: TenantMigrationRunReport = {
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      summary: summarize(tenants),
      ...(aborted() ? { interrupted: true as const } : {}),
      tenants,
    };
    log.info(`Run ${runId} finished: ${JSON.stringify(report.summary)}`);
    return report;
  }

  private async selectTargets(params: TargetParams): Promise<TenantMigrationTarget[]> {
    const all = await resolveTenants(this.tenants);
    return selectTargets(all, params?.target);
  }

  private inspectAll(
    targets: readonly TenantMigrationTarget[],
    shouldStop: () => boolean,
    onResult?: (inspection: TenantInspection) => void,
  ): Promise<Array<TenantInspection | undefined>> {
    return runPool(
      targets,
      this.ctx.options.concurrency,
      async (target) => {
        const inspection = await inspectTenant(this.ctx, target);
        onResult?.(inspection);
        return inspection;
      },
      shouldStop,
    );
  }
}

function baseResult(target: TenantMigrationTarget): TenantMigrationResult {
  return { tenantId: target.id, schema: target.schema, status: 'not-started', pendingBeforeRun: [], executed: [], executedKnown: true };
}

function fromFailedPreflight(target: TenantMigrationTarget, inspection: TenantInspection): TenantMigrationResult {
  return { ...baseResult(target), status: 'failed', error: inspection.error };
}

function toStatusEntry(i: TenantInspection): TenantStatusEntry {
  return {
    tenantId: i.tenantId,
    schema: i.schema,
    status: i.status,
    pending: i.pending,
    pendingCount: i.pending.length,
    known: i.known,
    executed: i.executed,
    unknownExecuted: i.unknownExecuted,
    historyTableExists: i.historyTableExists,
    ...(i.error ? { error: i.error } : {}),
  };
}
