#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';

const COV_DIR = 'coverage';

rmSync(COV_DIR, { recursive: true, force: true });
mkdirSync(COV_DIR, { recursive: true });

console.log('=== Building tests with source maps ===');
execSync('npx esbuild --bundle --platform=node --target=node18 --format=cjs --define:__DEBUG__=false --sourcemap --outfile=dist/tests.js tests/index.ts', { stdio: 'inherit' });

console.log('\n=== Running unit tests with coverage ===');
try {
  execSync(
    `npx c8 --reporter=text --reporter=html --reporter=lcov --reports-dir=${COV_DIR} --temp-directory=${COV_DIR}/tmp node --test --enable-source-maps dist/tests.js`,
    { stdio: 'inherit' },
  );
} catch {
  console.log('(some tests may have failed — coverage still collected)');
}

console.log(`\nHTML report: ${COV_DIR}/index.html`);
