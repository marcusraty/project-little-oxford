import Mocha from 'mocha';
import * as path from 'node:path';
import * as fs from 'node:fs';

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', timeout: 30000 });
  const testsRoot = __dirname;

  const files = fs.readdirSync(testsRoot).filter((f) => f.endsWith('.test.js'));
  for (const f of files) {
    mocha.addFile(path.resolve(testsRoot, f));
  }

  return new Promise<void>((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) reject(new Error(`${failures} test(s) failed`));
      else resolve();
    });
  });
}
