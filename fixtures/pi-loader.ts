// Test-only loader: resolve host-provided public packages from the installed Pi.
// No npm install or modification of the active agent's extension runtime.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
const cli = realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
const requirePi = createRequire(cli);
const { createJiti } = requirePi('jiti');
const packages = ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai', '@earendil-works/pi-tui', 'typebox'];
const alias = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
  `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(packages)}.map(p=>[p,import.meta.resolve(p)]))))`],
  { cwd: resolve(dirname(cli), '../..'), encoding: 'utf8' }));
export const load = createJiti(import.meta.url, { alias });
