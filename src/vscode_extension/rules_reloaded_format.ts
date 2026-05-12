export function formatRulesReloaded(timestamp: number, count: number, now: number): string {
  const ageMs = now - timestamp;
  let when: string;
  if (ageMs < 5_000) {
    when = 'just reloaded';
  } else if (ageMs < 60_000) {
    when = `${Math.floor(ageMs / 1_000)}s ago`;
  } else if (ageMs < 3_600_000) {
    when = `${Math.floor(ageMs / 60_000)}m ago`;
  } else {
    when = `${Math.floor(ageMs / 3_600_000)}h ago`;
  }
  const noun = count === 1 ? 'rule' : 'rules';
  return `${count} ${noun} · ${when}`;
}
