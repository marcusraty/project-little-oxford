// Builds, packages, and installs the extension as a real .vsix into the
// user's VS Code. This replaces the previous symlink approach: a vsix
// install is what real users hit, gets a clean version snapshot, and
// avoids platform-specific symlink quirks (Windows dev mode, etc).
//
// Iteration loop after this is set up:
//   1. edit source
//   2. npm run install:local   ← rebuilds, repackages, reinstalls
//   3. Ctrl/Cmd+Shift+P → "Developer: Reload Window"
//
// Requires: `code` on PATH (VS Code's "Install code in PATH" command).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const vsixPath = path.join(root, 'little-oxford.vsix');
const debug = process.argv.includes('--debug');

// Clean up any leftover symlink from the previous install method —
// otherwise VS Code would load TWO copies of the extension (the symlink
// and the new vsix install) and one would shadow the other unpredictably.
const oldLink = path.join(os.homedir(), '.vscode', 'extensions', `${pkg.name}-${pkg.version}`);
const stat = fs.lstatSync(oldLink, { throwIfNoEntry: false });
if (stat?.isSymbolicLink()) {
  fs.rmSync(oldLink, { recursive: true, force: true });
  console.log(`Removed legacy symlink at ${oldLink}`);
}

const buildCmd = debug ? 'npm run build:debug' : 'npm run build';
console.log(`1/3 building${debug ? ' (debug)' : ''}…`);
execSync(buildCmd, { stdio: 'inherit', cwd: root });

console.log('2/3 packaging vsix…');
if (debug) {
  const pkgPath = path.join(root, 'package.json');
  const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const savedPrepublish = pkgJson.scripts['vscode:prepublish'];
  delete pkgJson.scripts['vscode:prepublish'];
  fs.writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2) + '\n', 'utf8');
  try {
    execSync(`npx vsce package --out ${JSON.stringify(vsixPath)}`, { stdio: 'inherit', cwd: root });
  } finally {
    pkgJson.scripts['vscode:prepublish'] = savedPrepublish;
    fs.writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2) + '\n', 'utf8');
  }
} else {
  execSync(`npx vsce package --out ${JSON.stringify(vsixPath)}`, { stdio: 'inherit', cwd: root });
}

console.log('3/3 installing into VS Code…');
execSync(`code --install-extension ${JSON.stringify(vsixPath)} --force`, { stdio: 'inherit', cwd: root });

console.log('\nInstalled. Reload VS Code: Ctrl/Cmd+Shift+P → "Developer: Reload Window"');
