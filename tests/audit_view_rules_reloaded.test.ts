import { test } from 'node:test';
import assert from 'node:assert/strict';

// Models AuditViewProvider behavior around rules-reload status.
//
// Requirements:
// 1. notifyRulesReloaded(count, timestamp) records the last reload.
// 2. The current latest reload state is reachable via a getter.
// 3. When the webview re-attaches (panel closed + reopened), the
//    rules-reloaded message must be re-posted so the UI shows the
//    status again. pendingMessages alone won't do it because the
//    buffer was drained on first attach.

interface RulesReloadInfo { timestamp: number; count: number }

class FakeAuditView {
  private viewAttached = false;
  private lastReload: RulesReloadInfo | undefined;
  public posted: Array<{ type: string; payload?: RulesReloadInfo }> = [];

  notifyRulesReloaded(count: number, timestamp: number): void {
    this.lastReload = { count, timestamp };
    this.post({ type: 'rules-reloaded', payload: this.lastReload });
  }

  getLastReload(): RulesReloadInfo | undefined {
    return this.lastReload ? { ...this.lastReload } : undefined;
  }

  attachView(): void {
    this.viewAttached = true;
    if (this.lastReload) this.post({ type: 'rules-reloaded', payload: this.lastReload });
  }

  detachView(): void { this.viewAttached = false; }

  private post(msg: { type: string; payload?: RulesReloadInfo }): void {
    if (this.viewAttached) this.posted.push(msg);
  }
}

test('notifyRulesReloaded records the latest reload', () => {
  const v = new FakeAuditView();
  v.notifyRulesReloaded(8, 1_700_000_000_000);
  assert.deepEqual(v.getLastReload(), { timestamp: 1_700_000_000_000, count: 8 });
});

test('subsequent notify overwrites previous', () => {
  const v = new FakeAuditView();
  v.notifyRulesReloaded(8, 1_700_000_000_000);
  v.notifyRulesReloaded(12, 1_700_000_001_000);
  assert.deepEqual(v.getLastReload(), { timestamp: 1_700_000_001_000, count: 12 });
});

test('notify before view attached: state stored, no post yet', () => {
  const v = new FakeAuditView();
  v.notifyRulesReloaded(8, 1_700_000_000_000);
  assert.equal(v.posted.length, 0);
  assert.ok(v.getLastReload(), 'state recorded');
});

test('attachView after notify replays the rules-reloaded message', () => {
  const v = new FakeAuditView();
  v.notifyRulesReloaded(8, 1_700_000_000_000);
  v.attachView();
  assert.equal(v.posted.length, 1);
  assert.equal(v.posted[0].type, 'rules-reloaded');
  assert.deepEqual(v.posted[0].payload, { timestamp: 1_700_000_000_000, count: 8 });
});

test('detach + reattach: rules-reloaded re-posts on the second attach', () => {
  const v = new FakeAuditView();
  v.attachView();
  v.notifyRulesReloaded(8, 1_700_000_000_000);
  assert.equal(v.posted.length, 1, 'first post on notify');
  v.detachView();
  v.attachView();
  assert.equal(v.posted.length, 2, 're-posts on second attach');
  assert.deepEqual(v.posted[1].payload, { timestamp: 1_700_000_000_000, count: 8 });
});

test('attach with no prior notify: no rules-reloaded message', () => {
  const v = new FakeAuditView();
  v.attachView();
  assert.equal(v.posted.length, 0);
});
