import { existsSync, readFileSync, statSync } from 'node:fs';
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

/**
 * Finds tsx's ESM API next to the user's project, using the `import` condition of its public
 * `exports` map. (`require.resolve('tsx/esm/api')` picks the CommonJS build, whose `register()`
 * computes a wrong loader path.) Returns undefined when tsx is not installed.
 */
function findTsxEsmApi(cwd: string): string | undefined {
  try {
    const pkgPath = createRequire(path.join(cwd, 'noop.js')).resolve('tsx/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { exports?: Record<string, unknown> };
    const entry = (pkg.exports?.['./esm/api'] as { import?: string | { default?: string } } | undefined)?.import;
    const relative = typeof entry === 'string' ? entry : entry?.default;
    return relative ? path.join(path.dirname(pkgPath), relative) : undefined;
  } catch {
    return undefined;
  }
}

type TsxApi = { tsImport: (specifier: string, parentURL: string) => Promise<unknown> };

/**
 * tsx's `tsImport` imports TypeScript on every Node version; globally registering tsx's loader does
 * not, because Node's own type stripping (22.18+/24) handles `.ts` first and rejects syntax it
 * cannot strip, such as `enum`. Returns undefined when tsx is not installed.
 */
async function loadTsx(cwd: string): Promise<TsxApi | undefined> {
  const apiFile = findTsxEsmApi(cwd);
  if (!apiFile) return undefined;
  try {
    const api = (await import(pathToFileURL(apiFile).href)) as Partial<TsxApi>;
    return typeof api.tsImport === 'function' ? (api as TsxApi) : undefined;
  } catch {
    return undefined;
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

  const tsx = isTs ? await loadTsx(cwd) : undefined;
  let mod: unknown;
  try {
    // A file URL, not the bare path: on Windows "D:\\..." would be read as a URL with scheme "d:".
    const fileUrl = pathToFileURL(absolute).href;
    mod = tsx ? await tsx.tsImport(fileUrl, fileUrl) : await import(fileUrl);
  } catch (cause) {
    if (isTs && !tsx) {
      // Without tsx, Node can only load TypeScript that its own type stripping understands (22.18+/24+, no enums etc.).
      configError(
        `Could not load the TypeScript config ${absolute}. Install "tsx" in your project (npm i -D tsx), or point --config at a compiled .js file.`,
        cause,
      );
    }
    // The loaded file's own error message is deliberately not included: it may contain secrets.
    configError(`Could not load the config file ${absolute}${tsx ? ' (with tsx)' : ''}. Fix the error it throws when imported.`, cause);
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
