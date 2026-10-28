import type { TenantMigrationTarget, TenantSelection } from '../config/types.js';
import { TenantMigrationError } from '../errors/index.js';

export function selectTargets(
  all: readonly TenantMigrationTarget[],
  selection: TenantSelection | undefined,
): TenantMigrationTarget[] {
  const sel = selection as { all?: unknown; tenants?: unknown } | undefined;
  const hasAll = sel?.all !== undefined;
  const hasTenants = sel?.tenants !== undefined;

  if (hasAll === hasTenants) {
    throw new TenantMigrationError(
      'INVALID_TENANT_TARGET',
      'Select tenants explicitly: pass exactly one of { all: true } or { tenants: [ids] }.',
    );
  }

  if (hasAll) {
    if (sel!.all !== true) throw new TenantMigrationError('INVALID_TENANT_TARGET', '"all" must be true.');
    if (all.length === 0) {
      throw new TenantMigrationError('INVALID_TENANT_TARGET', 'The tenant provider returned no tenants; refusing to run on an empty registry.');
    }
    return [...all];
  }

  const ids = sel!.tenants;
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string')) {
    throw new TenantMigrationError('INVALID_TENANT_TARGET', '"tenants" must be a non-empty array of tenant ids.');
  }
  const byId = new Map(all.map((t) => [t.id, t]));
  const selected: TenantMigrationTarget[] = [];
  const seen = new Set<string>();
  for (const id of ids as string[]) {
    if (seen.has(id)) continue;
    seen.add(id);
    const target = byId.get(id);
    if (!target) {
      throw new TenantMigrationError('INVALID_TENANT_TARGET', `Unknown tenant id ${JSON.stringify(id.slice(0, 80))}.`);
    }
    selected.push(target);
  }
  return selected;
}
