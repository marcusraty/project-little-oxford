import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { runTests } from '@vscode/test-electron';

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-vscode-test-'));
  const { execSync } = await import('node:child_process');
  execSync('git init', { cwd: workspace, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: workspace, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: workspace, stdio: 'ignore' });
  fs.mkdirSync(path.join(workspace, '.oxford'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });

  // Seed audit.jsonl with mixed event types for history load test
  // Copy the REAL 300MB audit.jsonl to test against actual production data
  const realAudit = path.resolve(__dirname, '../../.oxford/audit.jsonl');
  const testAudit = path.join(workspace, '.oxford', 'audit.jsonl');
  if (fs.existsSync(realAudit)) {
    fs.copyFileSync(realAudit, testAudit);
    console.log(`Copied real audit.jsonl (${(fs.statSync(testAudit).size / 1024 / 1024).toFixed(1)}MB)`);
  } else {
    // Fallback: seed with mixed kinds
    const auditLines: string[] = [];
    auditLines.push(JSON.stringify({ id: 'hist-text-1', session_id: 's1', project_id: workspace, conversation_id: 'c1', turn_id: 't1', timestamp: '2026-05-08T01:00:00Z', kind: 'text', content: { text: 'Let me check the code' } }));
    auditLines.push(JSON.stringify({ id: 'hist-thinking-1', session_id: 's1', project_id: workspace, conversation_id: 'c1', turn_id: 't1', timestamp: '2026-05-08T01:00:01Z', kind: 'thinking', content: { text: 'I need to consider edge cases' } }));
    auditLines.push(JSON.stringify({ id: 'hist-tool-1', session_id: 's1', project_id: workspace, conversation_id: 'c1', turn_id: 't1', timestamp: '2026-05-08T01:00:02Z', kind: 'tool_use', content: { tool_name: 'Read', input: { file_path: '/tmp/test.ts' }, touched_paths: ['/tmp/test.ts'] } }));
    auditLines.push(JSON.stringify({ id: 'hist-prompt-1', session_id: 's1', project_id: workspace, conversation_id: 'c1', turn_id: 't2', timestamp: '2026-05-08T01:00:03Z', kind: 'user_prompt', content: { text: 'Can you fix the bug?' } }));
    auditLines.push(JSON.stringify({ id: 'hist-text-2', session_id: 's1', project_id: workspace, conversation_id: 'c1', turn_id: 't2', timestamp: '2026-05-08T01:00:04Z', kind: 'text', content: { text: 'Fixed it' } }));
    auditLines.push(JSON.stringify({ id: 'hist-tool-2', session_id: 's1', project_id: workspace, conversation_id: 'c1', turn_id: 't2', timestamp: '2026-05-08T01:00:05Z', kind: 'tool_use', content: { tool_name: 'Edit', input: { file_path: '/tmp/test.ts', old_string: 'old', new_string: 'new' }, touched_paths: ['/tmp/test.ts'] } }));
    fs.writeFileSync(testAudit, auditLines.join('\n') + '\n', 'utf8');
  }

  // Seed rules with new hook+message format for V15 test
  fs.mkdirSync(path.join(workspace, '.oxford', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.oxford', 'rules', 'test.json'), JSON.stringify({
    rules: [{
      id: 'TEST1', name: 'Test rule', kinds: ['text'], pattern: 'should work',
      hook: 'Stop', message: 'You said should work without verifying.',
      action: 'hook', severity: 'warning',
    }],
  }, null, 2), 'utf8');

  const encodedPath = workspace.replace(/\//g, '-');
  const jsonlDir = path.join(os.homedir(), '.claude', 'projects', encodedPath);
  fs.mkdirSync(jsonlDir, { recursive: true });

  const fakeSession1 = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test-session-1' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } }),
  ].join('\n') + '\n';

  const fakeSession2 = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test-session-2' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'World' }] } }),
  ].join('\n') + '\n';

  fs.writeFileSync(path.join(jsonlDir, 'test-session-1.jsonl'), fakeSession1, 'utf8');
  fs.writeFileSync(path.join(jsonlDir, 'test-session-2.jsonl'), fakeSession2, 'utf8');

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspace,
        '--disable-extensions',
      ],
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(jsonlDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('Failed to run tests:', err);
  process.exit(1);
});
