import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { BEHAVIORAL_RULES, COMPANION_RULES } from '../audit/default_rules';

export const MONITOR_SH = `#!/usr/bin/env bash
cd "$(dirname "$0")"
FEED=".monitor_feed"
HEARTBEAT=".monitor_heartbeat"
touch "$FEED"
(while true; do date +%s > "$HEARTBEAT"; sleep 2; done) &
trap "kill $! 2>/dev/null; rm -f $HEARTBEAT" EXIT
echo "little-oxford monitor started — watching for rule matches"
tail -n 0 -f "$FEED" | while IFS= read -r line; do
  echo "$line"
done
`;

export interface InitState {
  initialized: boolean;
  hasMonitor: boolean;
  hasRules: boolean;
}

async function hasAnyRuleFile(rulesDir: string): Promise<boolean> {
  try {
    const files = await fsp.readdir(rulesDir);
    return files.some((f) => f.endsWith('.json'));
  } catch {
    return false;
  }
}

export async function getInitState(root: string): Promise<InitState> {
  const monitorPath = path.join(root, '.oxford', 'monitor.sh');
  const rulesDir = path.join(root, '.oxford', 'rules');
  const [monitorStat, rulesPresent] = await Promise.all([
    fsp.stat(monitorPath).then(() => true).catch(() => false),
    hasAnyRuleFile(rulesDir),
  ]);
  return { initialized: monitorStat && rulesPresent, hasMonitor: monitorStat, hasRules: rulesPresent };
}

export async function initializeProject(root: string): Promise<void> {
  const oxfordDir = path.join(root, '.oxford');
  const rulesDir = path.join(oxfordDir, 'rules');
  await fsp.mkdir(rulesDir, { recursive: true });

  if (!(await hasAnyRuleFile(rulesDir))) {
    await fsp.writeFile(
      path.join(rulesDir, 'behavioral.json'),
      JSON.stringify({ rules: BEHAVIORAL_RULES }, null, 2) + '\n',
      'utf8',
    );
    await fsp.writeFile(
      path.join(rulesDir, 'companion.json'),
      JSON.stringify({ rules: COMPANION_RULES }, null, 2) + '\n',
      'utf8',
    );
  }

  const monitorPath = path.join(oxfordDir, 'monitor.sh');
  try {
    await fsp.stat(monitorPath);
  } catch {
    await fsp.writeFile(monitorPath, MONITOR_SH, 'utf8');
    await fsp.chmod(monitorPath, 0o755);
  }

  const st = await fsp.stat(monitorPath);
  if (!(st.mode & 0o111)) await fsp.chmod(monitorPath, 0o755);
}
