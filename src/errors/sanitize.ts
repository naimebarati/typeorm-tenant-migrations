const MIN_SECRET_LENGTH = 3;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a function that scrubs text before it reaches a report, a log line or the CLI output.
 * It removes (1) the exact secret values of the configured connection, (2) anything shaped like
 * a URL (which may embed credentials), (3) `password=...` fragments.
 */
export function createRedactor(secrets: Iterable<string | undefined>): (text: string) => string {
  const exact = [...new Set([...secrets].filter((s): s is string => !!s && s.length >= MIN_SECRET_LENGTH))]
    .sort((a, b) => b.length - a.length)
    .map((s) => new RegExp(escapeRegExp(s), 'g'));

  return (text: string) => {
    let out = text;
    for (const re of exact) out = out.replace(re, '[redacted]');
    out = out.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi, '[redacted-url]');
    out = out.replace(/(password|passwd|pwd|secret|token)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1$2[redacted]');
    return out;
  };
}

export function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}
