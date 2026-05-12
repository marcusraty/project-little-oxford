// Patches vscode-test-playwright to work with @playwright/test >= 1.57
// The library uses playwright._toImpl() which was moved to connection.toImpl()
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const target = 'node_modules/vscode-test-playwright/dist/index.js';
if (!existsSync(target)) process.exit(0);

let code = readFileSync(target, 'utf8');
if (code.includes('_connection')) { process.exit(0); } // already patched

code = code.replace(
  /playwright\._toImpl\(([^)]*)\)/g,
  '((playwright._toImpl) ? playwright._toImpl($1) : ($1._connection || playwright._connection)?.toImpl($1))',
);
writeFileSync(target, code, 'utf8');
console.log('Patched vscode-test-playwright for Playwright >= 1.57');
