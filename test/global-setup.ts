import { execFileSync } from 'node:child_process';
import path from 'node:path';

// CLI tests spawn the real built binary, so make sure dist/ matches src/ before any test runs.
export default function setup() {
  execFileSync('npm', ['run', 'build', '--silent'], { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' });
}
