import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TenantMigrationRunnerConfig } from '../config/types.js';
import { TenantMigrationError } from '../errors/index.js';

const SUPPORTED = new Set(['.js', '.cjs', '.mjs', '.ts', '.mts', '.cts']);
const TS_EXTENSIONS = new Set(['.ts', '.mts', '.cts']);

function configError(message: string, cause?: unknown): never {
  throw new TenantMigrationError('INVALID_CONFIGURATION', message, cause === undefined ? undefined : { cause });
}

/** Registers the optional `tsx` loader if the project has it. Returns whether it did. */
async function tryRegisterTsx(cwd: string): Promise<boolean> {
  try {
    const resolved = createRequire(path.join(cwd, 'noop.js')).resolve('tsx/esm/api');
    const api = (await import(pathToFileURL(resolved).href)) as { register?: () => unknown };
    api.register?.();
    return typeof api.register === 'function';
  } catch {
    return false;
  }
}

/**
 * Loads a runner config from a JS (ESM or CommonJS) or TypeScript file. The module may export the
 * config object, or a (possibly async) function returning it, as `default` or as `module.exports`.
 */
export async function loadConfig(configPath: string, cwd: string): Promise<TenantMigrationRunnerConfig> {
  if (!configPath) configError('--config <path> is required.');
  const absolute = path.resolve(cwd, configPath);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) configError(`Config file not found: ${absolute}`);

  const ext = path.extname(absolute).toLowerCase();
  if (!SUPPORTED.has(ext)) configError(`Unsupported config file type "${ext}". Use .js, .cjs, .mjs or (with tsx installed) .ts.`);

  const isTs = TS_EXTENSIONS.has(ext);
  const tsxRegistered = isTs ? await tryRegisterTsx(cwd) : false;

  let mod: unknown;
  try {
    mod = await import(pathToFileURL(absolute).href);
  } catch (cause) {
    if (isTs && !tsxRegistered) {
      configError(
        `Could not load the TypeScript config ${absolute}. Install "tsx" in your project (npm i -D tsx), or point --config at a compiled .js file.`,
        cause,
      );
    }
    // The loaded file's own error message is deliberately not included: it may contain secrets.
    configError(`Could not load the config file ${absolute}. Fix the error it throws when imported.`, cause);
  }

  let exported: unknown = mod;
  // import() of CommonJS yields { default: module.exports }; TS-compiled ESM->CJS may nest another `default`.
  for (let i = 0; i < 2; i++) {
    const next = (exported as { default?: unknown } | null)?.default;
    if (next !== undefined && !('tenants' in (exported as object))) exported = next;
  }
  if (typeof exported === 'function') {
    try {
      exported = await (exported as () => unknown)();
    } catch (cause) {
      configError('The config function threw an error.', cause);
    }
  }

  if (!exported || typeof exported !== 'object' || !('dataSource' in exported) || !('tenants' in exported)) {
    configError(
      `The config file must export { dataSource, tenants, options? } (as default / module.exports, or a function returning it).`,
    );
  }
  return exported as TenantMigrationRunnerConfig;
}
