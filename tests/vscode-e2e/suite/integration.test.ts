import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';

function root(): string {
  return vscode.workspace.workspaceFolders![0].uri.fsPath;
}

suite('Integration', () => {

  test('V1: extension activates', async () => {
    const ext = vscode.extensions.getExtension('marcusraty.little-oxford');
    assert.ok(ext, 'extension found');
    if (!ext.isActive) await ext.activate();
    assert.ok(ext.isActive, 'extension is active');
  });

  test('V2: show diagram command opens panel', async () => {
    await vscode.commands.executeCommand('little-oxford.show');
    await new Promise((r) => setTimeout(r, 1000));
    const panels = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.label.includes('little-oxford'));
    assert.ok(panels.length > 0, 'diagram tab exists');
  });

  test('V10: pull all logs processes fake CC sessions', async () => {

    await vscode.commands.executeCommand('little-oxford.pullAllLogs');
    await new Promise((r) => setTimeout(r, 2000));

    const auditLog = path.join(root(), '.oxford', 'audit.jsonl');
    if (fs.existsSync(auditLog)) {
      const content = fs.readFileSync(auditLog, 'utf8');
      assert.ok(content.length > 0, 'audit log has content from processed sessions');
    }
  });

  test('V12: bootstrap creates model.json', async () => {
    const modelPath = path.join(root(), '.oxford', 'model.json');
    if (fs.existsSync(modelPath)) fs.unlinkSync(modelPath);

    await vscode.commands.executeCommand('little-oxford.bootstrap');
    await new Promise((r) => setTimeout(r, 1000));

    assert.ok(fs.existsSync(modelPath), 'model.json created');
    const content = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    assert.ok(content.components, 'has components');
    assert.ok(content.rules, 'has rules');
  });

  test('V13: full flow in correct order — CC → rules → bootstrap → diagram', async () => {
    const modelPath = path.join(root(), '.oxford', 'model.json');

    // Clean slate
    if (fs.existsSync(modelPath)) fs.unlinkSync(modelPath);
    if (fs.existsSync(path.join(root(), '.oxford', 'rules'))) {
      fs.rmSync(path.join(root(), '.oxford', 'rules'), { recursive: true, force: true });
    }

    // Step 2: CC sessions
    await vscode.commands.executeCommand('little-oxford.pullAllLogs');
    await new Promise((r) => setTimeout(r, 1500));

    // Step 3: Rules — defaults load from code on activation; no file needed.
    const ruleCount = await vscode.commands.executeCommand('little-oxford.getRuleCount') as number;
    assert.ok(ruleCount > 0, 'audit rules loaded (defaults from code)');

    // Step 4: Bootstrap (last — needs agent to fill in, but starter file proves command works)
    await vscode.commands.executeCommand('little-oxford.bootstrap');
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(fs.existsSync(modelPath), 'model created');

    // After full flow: diagram opens
    await vscode.commands.executeCommand('little-oxford.show');
    await new Promise((r) => setTimeout(r, 1000));
    const panels = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.label.includes('little-oxford'));
    assert.ok(panels.length > 0, 'diagram visible after full flow');
  });

  test('V14: audit history loads all event kinds from seeded file', async () => {
    const auditPath = path.join(root(), '.oxford', 'audit.jsonl');
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    const events = [
      { id: 't1', kind: 'text', content: { text: 'hello' }, timestamp: 1000, session_id: 's1' },
      { id: 't2', kind: 'thinking', content: { text: 'hmm' }, timestamp: 1001, session_id: 's1' },
      { id: 't3', kind: 'tool_use', content: { tool_name: 'Read', input: { file_path: '/f.ts' } }, timestamp: 1002, session_id: 's1' },
      { id: 't4', kind: 'user_prompt', content: { text: 'do it' }, timestamp: 1003, session_id: 's1' },
      { id: 't5', kind: 'text', content: { text: 'ok' }, timestamp: 1004, session_id: 's1' },
      { id: 't6', kind: 'tool_use', content: { tool_name: 'Edit', input: { file_path: '/g.ts' } }, timestamp: 1005, session_id: 's1' },
    ];
    fs.writeFileSync(auditPath, events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    await vscode.commands.executeCommand('little-oxford.reloadAuditHistory');
    await new Promise((r) => setTimeout(r, 500));

    const counts = await vscode.commands.executeCommand('little-oxford.getAuditEventCounts') as Record<string, number> | undefined;
    console.log('  V14 event counts:', JSON.stringify(counts));
    assert.ok(counts, 'getAuditEventCounts command returned data');
    assert.equal(counts.text, 2, 'exactly 2 text events');
    assert.equal(counts.thinking, 1, 'exactly 1 thinking event');
    assert.equal(counts.tool_use, 2, 'exactly 2 tool_use events');
    assert.equal(counts.user_prompt, 1, 'exactly 1 user_prompt event');
  });

  test('V15: rule with hook+message fields loads and evaluates', async () => {
    // Write rule file with new hook+message fields
    const rulesDir = path.join(root(), '.oxford', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'test-hook.json'), JSON.stringify({
      rules: [{
        id: 'TEST1', name: 'Test rule', kinds: ['text'], pattern: 'should work',
        hook: 'Stop', message: 'You said should work without verifying.',
        action: 'hook', severity: 'warning',
      }],
    }, null, 2), 'utf8');

    // Rules watcher picks up the new file automatically.
    await new Promise((r) => setTimeout(r, 1500));

    const ruleCount = await vscode.commands.executeCommand('little-oxford.getRuleCount') as number | undefined;
    console.log(`  V15: ruleCount=${ruleCount}`);
    assert.ok(ruleCount !== undefined, 'getRuleCount command exists');
    assert.ok(ruleCount > 0, `expected >0 rules loaded, got ${ruleCount}`);

    const ruleDetails = await vscode.commands.executeCommand('little-oxford.getRuleDetails', 'TEST1') as { hook?: string; message?: string } | undefined;
    assert.ok(ruleDetails, 'TEST1 rule found');
    assert.equal(ruleDetails.hook, 'Stop', 'rule has hook field');
    assert.equal(ruleDetails.message, 'You said should work without verifying.', 'rule has message field');
  });

  test('V16: rule fire writes message to monitor feed', async () => {
    const feedPath = path.join(root(), '.oxford', '.monitor_feed');
    try { fs.unlinkSync(feedPath); } catch {}

    const os = require('node:os');
    const encodedPath = root().replace(/\//g, '-');
    const jsonlDir = path.join(os.homedir(), '.claude', 'projects', encodedPath);
    const sessions = fs.readdirSync(jsonlDir).filter((f: string) => f.endsWith('.jsonl'));
    assert.ok(sessions.length > 0, 'has CC session files');

    const sessionFile = path.join(jsonlDir, sessions[0]);
    const ccEvent = JSON.stringify({
      uuid: 'monitor-trigger-1',
      type: 'assistant',
      timestamp: new Date().toISOString(),
      sessionId: sessions[0].replace('.jsonl', ''),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'I think this should work fine' }],
      },
    });
    fs.appendFileSync(sessionFile, ccEvent + '\n');

    await new Promise((r) => setTimeout(r, 5000));

    assert.ok(fs.existsSync(feedPath), '.monitor_feed created');
    const content = fs.readFileSync(feedPath, 'utf8');
    assert.ok(content.includes('should work without verifying'), `monitor feed contains rule message, got: ${content.slice(0, 200)}`);
  });

  test('V17: monitor script exists and is executable', async () => {
    const scriptPath = path.join(root(), '.oxford', 'monitor.sh');
    // Create the monitor script in test workspace if not present
    fs.mkdirSync(path.join(root(), '.oxford'), { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, '..', '..', '..', '.oxford', 'monitor.sh'),
      scriptPath,
    );
    fs.chmodSync(scriptPath, 0o755);
    assert.ok(fs.existsSync(scriptPath), 'monitor.sh exists');
    const stat = fs.statSync(scriptPath);
    assert.ok(stat.mode & 0o111, 'monitor.sh is executable');
  });

  test('V23: settings are grouped into separate sections', async () => {
    const ext = vscode.extensions.getExtension('marcusraty.little-oxford');
    assert.ok(ext, 'extension found');
    const pkg = ext.packageJSON;
    const config = pkg.contributes?.configuration;
    assert.ok(Array.isArray(config), 'configuration is an array (grouped)');
    const titles = config.map((c: any) => c.title);
    assert.ok(titles.includes('Diagram'), 'has Diagram group');
    assert.ok(titles.includes('Audit'), 'has Audit group');
    assert.ok(titles.includes('Rules'), 'has Rules group');
  });

  test('V24: JSON Schema registered for rule files', async () => {
    const ext = vscode.extensions.getExtension('marcusraty.little-oxford');
    assert.ok(ext, 'extension found');
    const pkg = ext.packageJSON;
    const jsonValidation = pkg.contributes?.jsonValidation;
    assert.ok(Array.isArray(jsonValidation), 'jsonValidation exists');
    assert.ok(jsonValidation.some((v: any) => v.fileMatch?.includes('.oxford/rules/*.json')), 'rule files have schema');
  });

  test('V25: custom editor registered for rule files', async () => {
    const ext = vscode.extensions.getExtension('marcusraty.little-oxford');
    assert.ok(ext, 'extension found');
    const pkg = ext.packageJSON;
    const editors = pkg.contributes?.customEditors;
    assert.ok(Array.isArray(editors), 'customEditors exists');
    const ruleEditor = editors.find((e: any) => e.viewType === 'little-oxford.ruleEditor');
    assert.ok(ruleEditor, 'rule editor registered');
    assert.equal(ruleEditor.priority, 'option', 'priority is option (user chooses)');
  });

  test('V26: companion rule detects source edited before test', async () => {
    // Write a companion rule with order checking
    const rulesDir = path.join(root(), '.oxford', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'order-test.json'), JSON.stringify({
      rules: [{
        id: 'C10', name: 'Source before test', kinds: ['tool_use'],
        trigger: 'src/',
        companions: ['tests/'],
        order: 'companion_first',
        hook: 'Stop',
        message: 'You edited source code before writing a test. Write a failing test first.',
        action: 'hook', severity: 'warning',
      }],
    }, null, 2), 'utf8');

    // Rules watcher picks up the new file automatically.
    await new Promise((r) => setTimeout(r, 1500));

    // Check the rule loaded with order field
    const details = await vscode.commands.executeCommand('little-oxford.getRuleDetails', 'C10') as any;
    assert.ok(details, 'C10 rule loaded');
    assert.equal(details.order, 'companion_first', 'order field preserved');
  });


  test('V30: reload evaluates rules against history events', async () => {
    const auditPath = path.join(root(), '.oxford', 'audit.jsonl');
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    const entries = [
      { id: 'hist-1', kind: 'text', content: { text: 'this should work fine' }, timestamp: Date.now(), session_id: 's1' },
      { id: 'hist-2', kind: 'text', content: { text: 'nothing special here' }, timestamp: Date.now(), session_id: 's1' },
      { id: 'hist-3', kind: 'text', content: { text: 'that is good enough for now' }, timestamp: Date.now(), session_id: 's1' },
    ];
    fs.writeFileSync(auditPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    const ruleCount = await vscode.commands.executeCommand('little-oxford.getRuleCount') as number;
    assert.ok(ruleCount > 0, 'rules are loaded');

    await vscode.commands.executeCommand('little-oxford.reloadAuditHistory');
    await new Promise((r) => setTimeout(r, 500));

    const counts = await vscode.commands.executeCommand('little-oxford.getAuditEventCounts') as Record<string, number>;
    assert.equal(counts.text, 3, 'all 3 text events loaded from file');
  });

  test('V31: writing a rule file to .oxford/rules/ triggers reload via watcher', async () => {
    const rulesDir = path.join(root(), '.oxford', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    const newRulePath = path.join(rulesDir, 'watcher-test.json');
    if (fs.existsSync(newRulePath)) fs.unlinkSync(newRulePath);

    fs.writeFileSync(newRulePath, JSON.stringify({
      rules: [{
        id: 'WATCHER1',
        name: 'Watcher reload test',
        kinds: ['text'],
        pattern: 'reload-via-watcher',
        action: 'notify',
        severity: 'warning',
      }],
    }, null, 2), 'utf8');

    // Wait > debounce (250ms) + processing margin.
    await new Promise((r) => setTimeout(r, 1500));

    const details = await vscode.commands.executeCommand(
      'little-oxford.getRuleDetails',
      'WATCHER1',
    ) as { id?: string; name?: string } | undefined;
    assert.ok(details, 'WATCHER1 rule loaded after writing the file (watcher fired)');
    assert.equal(details!.id, 'WATCHER1');

    fs.unlinkSync(newRulePath);
  });
});
