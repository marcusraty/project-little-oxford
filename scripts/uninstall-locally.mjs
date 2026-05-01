// Uninstalls the extension from VS Code and (defensively) removes any
// leftover symlink from the older install flow.
// Run via `npm run uninstall:local`.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const extId = `${pkg.publisher}.${pkg.name}`;

try {
  execSync(`code --uninstall-extension ${extId}`, { stdio: 'inherit' });
} catch {
  // `code --uninstall-extension` exits non-zero when the extension
  // isn't installed. That's fine — keep going to clear any leftover
  // symlink below.
}

const oldLink = path.join(os.homedir(), '.vscode', 'extensions', `${pkg.name}-${pkg.version}`);
const stat = fs.lstatSync(oldLink, { throwIfNoEntry: false });
if (stat) {
  fs.rmSync(oldLink, { recursive: true, force: true });
  console.log(`Also removed legacy entry at ${oldLink}`);
}

console.log('Reload VS Code to deactivate.');
