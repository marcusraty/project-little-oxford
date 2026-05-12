import { test, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { updateActivity, readActivity } from '../src/diagram/activity';

let tmpDir = '';
afterEach(async () => {
  if (tmpDir) { await fsp.rm(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
});

async function makeTmp(): Promise<string> {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lo-activity-race-'));
  await fsp.mkdir(path.join(tmpDir, '.oxford'), { recursive: true });
  return tmpDir;
}

test('updateActivity: 20 concurrent calls all persist (no lost updates)', async () => {
  const root = await makeTmp();

  // 20 distinct component anchors, one updateActivity call each in parallel.
  const anchorMap = new Map<string, string[]>();
  const componentIds: string[] = [];
  for (let i = 0; i < 20; i++) {
    const id = `comp_${i}`;
    componentIds.push(id);
    anchorMap.set(`src/file_${i}.ts`, [id]);
  }

  await Promise.all(
    componentIds.map((id, i) => updateActivity(
      root,
      anchorMap,
      [`/p/src/file_${i}.ts`],
      `2026-05-11T10:00:${String(i).padStart(2, '0')}.000Z`,
      'sess-' + i,
      'Read',
    )),
  );

  const activity = await readActivity(root);
  for (const id of componentIds) {
    assert.ok(activity[id], `missing ${id} — lost in a race`);
    assert.ok(activity[id].last_read, `${id} has no last_read`);
  }
  assert.equal(Object.keys(activity).length, 20, 'all 20 entries present');
});
