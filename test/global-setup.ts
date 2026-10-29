import { execSync } from 'node:child_process';
import path from 'node:path';

// CLI tests spawn the real built binary, so make sure dist/ matches src/ before any test runs.
// (execSync goes through the shell, which also resolves npm.cmd on Windows.)
export default function setup() {
  execSync('npm run build --silent', { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' });
}
