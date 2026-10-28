import type { TenantMigrationTarget, TenantProvider } from '../config/types.js';
import { TenantMigrationError } from '../errors/index.js';
import { validateTargets } from './validate-target.js';

export async function resolveTenants(provider: TenantProvider): Promise<readonly TenantMigrationTarget[]> {
  let raw: unknown;
  if (typeof provider === 'function') {
    try {
      raw = await provider();
    } catch (cause) {
      // The provider is user code; its message is kept on `cause` only.
      throw new TenantMigrationError('INVALID_CONFIGURATION', 'The tenant provider threw an error.', { cause });
    }
  } else {
    raw = provider;
  }
  return validateTargets(raw);
}
