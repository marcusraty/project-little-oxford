// HTML + CSS + webview-side JS for the audit panel. Lifted out of
// audit_view.ts so the provider file stays small.

export function buildHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    font-size: 12px;
    color: var(--vscode-foreground, #ccc);
    background: var(--vscode-panel-background, #1e1e1e);
    height: 100vh;
    display: flex;
  }
  .events-pane {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-right: 1px solid var(--vscode-panel-border, #333);
  }
  .events-scroll { flex: 1; overflow-y: auto; padding: 4px 8px; }
  .splitter {
    width: 4px;
    cursor: col-resize;
    background: transparent;
    flex-shrink: 0;
  }
  .splitter:hover, .splitter.dragging { background: var(--vscode-focusBorder, #007fd4); }
  .sessions-pane {
    width: 200px;
    min-width: 80px;
    overflow-y: auto;
    padding: 4px 0;
  }
  .sessions-header {
    padding: 4px 10px 6px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground, #888);
  }
  .sessions-dir-link {
    cursor: pointer;
    color: var(--vscode-textLink-foreground, #3794ff);
    font-size: 10px;
  }
  .sessions-dir-link:hover { text-decoration: underline; }
  .sessions-dir-path {
    padding: 0 10px 4px;
    font-size: 9px;
    color: var(--vscode-descriptionForeground, #666);
    font-family: var(--vscode-editor-font-family, monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }
  .sessions-dir-path:hover { color: var(--vscode-textLink-foreground, #3794ff); }
  .session {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
  }
  .session:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: #4ec9b0; flex-shrink: 0; }
  .session-info { flex: 1; overflow: hidden; min-width: 0; }
  .session-title { display: block; overflow: hidden; text-overflow: ellipsis; font-size: 12px; }
  .session-id { font-size: 10px; color: var(--vscode-descriptionForeground, #666); font-family: var(--vscode-editor-font-family, monospace); }
  .session-meta { display: block; font-size: 10px; color: var(--vscode-descriptionForeground, #666); overflow: hidden; text-overflow: ellipsis; }

  .monitor-status {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    font-size: 11px;
    border-bottom: 1px solid var(--vscode-panel-border, #333);
    background: var(--vscode-editor-background);
  }
  .monitor-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: #ef4444; flex-shrink: 0;
  }
  .monitor-dot.connected { background: #22c55e; }
  .monitor-label { flex: 1; color: var(--vscode-descriptionForeground, #888); }
  .monitor-copy {
    background: transparent;
    border: 1px solid var(--vscode-button-secondaryBackground, #444);
    color: var(--vscode-foreground, #ccc);
    border-radius: 3px;
    padding: 1px 6px;
    font-size: 10px;
    cursor: pointer;
  }
  .monitor-copy:hover { background: var(--vscode-button-secondaryHoverBackground, #555); }
  .monitor-open {
    font-size: 10px;
    color: var(--vscode-textLink-foreground, #3794ff);
    cursor: pointer;
    text-decoration: none;
  }
  .monitor-open:hover { text-decoration: underline; }
  .rules-status {
    font-size: 10px;
    color: var(--vscode-descriptionForeground, #888);
    padding: 1px 6px;
    border: 1px solid var(--vscode-panel-border, #333);
    border-radius: 3px;
    background: var(--vscode-editorWidget-background, transparent);
  }
  .help-link {
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 3px;
    background: var(--vscode-statusBarItem-warningBackground, #d18616);
    color: var(--vscode-statusBarItem-warningForeground, #fff);
    cursor: pointer;
    text-decoration: none;
    margin-left: auto;
  }
  .help-link:hover { filter: brightness(1.1); }

  .toolbar {
    display: flex;
    gap: 4px;
    padding: 4px 8px 6px;
    border-bottom: 1px solid var(--vscode-panel-border, #333);
    align-items: center;
    flex-wrap: wrap;
  }
  .filter-btn {
    background: transparent;
    border: 1px solid var(--vscode-button-secondaryBackground, #444);
    color: var(--vscode-foreground, #ccc);
    border-radius: 3px;
    padding: 1px 6px;
    font-size: 10px;
    cursor: pointer;
  }
  .filter-btn.active {
    background: var(--vscode-button-background, #0e639c);
    border-color: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
  }
  .filter-btn.warn-active { background: #7d4e00; border-color: #7d4e00; color: #fff; }
  .filter-btn.err-active { background: #a1260d; border-color: #a1260d; color: #fff; }
  .spacer { flex: 1; }
  .toolbar-link {
    font-size: 10px;
    color: var(--vscode-textLink-foreground, #3794ff);
    cursor: pointer;
    text-decoration: none;
  }
  .toolbar-link:hover { text-decoration: underline; }

  .event {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 2px 0;
    line-height: 1.5;
    cursor: pointer;
  }
  .event:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
  .event-time {
    color: var(--vscode-descriptionForeground, #666);
    font-size: 10px;
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }
  .event-content { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .event-thinking .event-content { font-style: italic; color: var(--vscode-descriptionForeground, #888); }
  .event-tool_use .event-content { font-style: italic; }
  .event-user_prompt .event-content { color: var(--vscode-textLink-foreground, #3794ff); }
  .event-rule { background: rgba(255, 180, 0, 0.08); }
  .event-rule-error { background: rgba(255, 60, 0, 0.1); }
  .badge {
    font-size: 10px; font-weight: 600; padding: 0 4px; border-radius: 3px; flex-shrink: 0;
    background: var(--vscode-badge-background, #444);
    color: var(--vscode-badge-foreground, #fff);
  }
  .badge-tool { background: #1a5276; }
  .badge-rule { background: #7d4e00; }
  .badge-rule-error { background: #a1260d; }
  .empty {
    padding: 20px;
    text-align: center;
    color: var(--vscode-descriptionForeground, #666);
  }
  .load-more {
    text-align: center;
    padding: 4px;
    font-size: 10px;
    color: var(--vscode-descriptionForeground, #666);
  }
  .hidden { display: none !important; }
</style>
</head>
<body>
  <div class="events-pane">
    <div class="monitor-status">
      <span class="monitor-dot" id="monitor-dot"></span>
      <span class="monitor-label" id="monitor-label">Monitor not connected</span>
      <button class="monitor-copy" id="monitor-copy" title="Copy command to start the monitor">Copy command</button>
      <a class="monitor-open" id="monitor-open" title="Open monitor feed">Feed ↗</a>
      <span class="rules-status hidden" id="rules-status" title="Audit rules reloaded"></span>
      <a class="help-link" id="help-link" title="Need help? Email Marcus" role="button">? Help</a>
    </div>
    <div class="toolbar">
      <button class="filter-btn active" data-filter="all">All</button>
      <button class="filter-btn" data-filter="text">Text</button>
      <button class="filter-btn" data-filter="tool_use">Tools</button>
      <button class="filter-btn" data-filter="thinking">Thinking</button>
      <button class="filter-btn" data-filter="user_prompt">Prompts</button>
      <button class="filter-btn" data-filter="rules">Rules</button>
      <span class="spacer"></span>
      <button class="filter-btn" data-filter="warnings" title="Toggle warnings only">⚠</button>
      <button class="filter-btn" data-filter="errors" title="Toggle errors only">✕</button>
      <span class="spacer"></span>
      <a class="toolbar-link" id="open-rules">Rules ↗</a>
    </div>
    <div class="events-scroll" id="events-scroll">
      <div class="empty" id="empty-msg">No audit events yet. Start a Claude Code session to see activity here.</div>
    </div>
  </div>
  <div class="splitter" id="splitter"></div>
  <div class="sessions-pane" id="sessions-pane">
    <div class="sessions-header">Claude Code Sessions <span id="sessions-dir" class="sessions-dir-link" title="Open sessions directory">↗</span></div>
    <div class="sessions-dir-path" id="sessions-dir-path"></div>
    <div id="session-list"></div>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  const scroll = document.getElementById('events-scroll');
  const emptyMsg = document.getElementById('empty-msg');
  const sessionList = document.getElementById('session-list');
  const splitter = document.getElementById('splitter');
  const sessionsPane = document.getElementById('sessions-pane');
  const filterBtns = document.querySelectorAll('.filter-btn[data-filter]');
  const monitorDot = document.getElementById('monitor-dot');
  const monitorLabel = document.getElementById('monitor-label');
  const monitorCopy = document.getElementById('monitor-copy');
  const monitorOpen = document.getElementById('monitor-open');
  const rulesStatus = document.getElementById('rules-status');
  const helpLink = document.getElementById('help-link');
  if (helpLink) helpLink.addEventListener('click', () => vscode.postMessage({ type: 'open-help' }));

  monitorCopy.addEventListener('click', () => {
    vscode.postMessage({ type: 'copy-monitor-command' });
    monitorCopy.textContent = 'Copied!';
    setTimeout(() => { monitorCopy.textContent = 'Copy command'; }, 1500);
  });
  monitorOpen.addEventListener('click', () => {
    vscode.postMessage({ type: 'open-monitor-feed' });
  });

  let allEvents = [];
  let activeFilter = 'all';
  let warningsOnly = false;
  let errorsOnly = false;
  let ruleMatchMap = {};
  let pageSize = 50;
  let visibleCount = 50;

  // Scroll-to-top loads more
  scroll.addEventListener('scroll', () => {
    if (scroll.scrollTop === 0 && visibleCount < allEvents.length) {
      const prevHeight = scroll.scrollHeight;
      visibleCount = Math.min(visibleCount + pageSize, allEvents.length);
      renderEvents();
      scroll.scrollTop = scroll.scrollHeight - prevHeight;
    }
  });

  // Splitter drag
  let dragging = false;
  splitter.addEventListener('mousedown', (e) => { dragging = true; splitter.classList.add('dragging'); e.preventDefault(); });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    sessionsPane.style.width = Math.max(80, Math.min(document.body.clientWidth - e.clientX, document.body.clientWidth - 100)) + 'px';
  });
  window.addEventListener('mouseup', () => { dragging = false; splitter.classList.remove('dragging'); });

  // Filters
  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const f = btn.dataset.filter;
      if (f === 'warnings') {
        warningsOnly = !warningsOnly;
        errorsOnly = false;
        btn.classList.toggle('warn-active');
        document.querySelector('[data-filter="errors"]').classList.remove('err-active');
      } else if (f === 'errors') {
        errorsOnly = !errorsOnly;
        warningsOnly = false;
        btn.classList.toggle('err-active');
        document.querySelector('[data-filter="warnings"]').classList.remove('warn-active');
      } else {
        activeFilter = f;
        filterBtns.forEach(b => {
          if (!['warnings','errors'].includes(b.dataset.filter)) b.classList.remove('active');
        });
        btn.classList.add('active');
      }
      visibleCount = pageSize;
      renderEvents();
    });
  });

  // Open rules
  document.getElementById('open-rules').addEventListener('click', () => {
    vscode.postMessage({ type: 'open-rules' });
  });

  const dirLink = document.getElementById('sessions-dir');
  const dirPath = document.getElementById('sessions-dir-path');
  function openSessionsDir() { vscode.postMessage({ type: 'open-sessions-dir' }); }
  dirLink.addEventListener('click', openSessionsDir);
  dirPath.addEventListener('click', openSessionsDir);

  function renderEvents() {
    const filtered = allEvents.filter(ev => {
      if (warningsOnly) return ruleMatchMap[ev.id]?.severity === 'warning';
      if (errorsOnly) return ruleMatchMap[ev.id]?.severity === 'error';
      if (activeFilter === 'all') return true;
      if (activeFilter === 'rules') return !!ruleMatchMap[ev.id];
      return ev.kind === activeFilter;
    });
    const page = filtered.slice(-visibleCount);
    const hasMore = filtered.length > visibleCount;
    emptyMsg.classList.toggle('hidden', filtered.length > 0);
    const html = (hasMore ? '<div class="load-more">↑ scroll up for ' + (filtered.length - visibleCount) + ' more</div>' : '') + page.map(ev => {
      const rm = ruleMatchMap[ev.id];
      const ruleClass = rm ? (rm.severity === 'error' ? 'event-rule-error' : 'event-rule') : '';
      const badge = rm
        ? '<span class="badge ' + (rm.severity === 'error' ? 'badge-rule-error' : 'badge-rule') + '">' + escapeHtml(rm.ruleId) + '</span>'
        : (ev.badge ? '<span class="badge badge-tool">' + escapeHtml(ev.badge) + '</span>' : '');
      return '<div class="event event-' + escapeAttr(ev.kind) + ' ' + ruleClass + '" data-session="' + escapeAttr(ev.sessionId) + '" data-id="' + escapeAttr(ev.id) + '">'
        + '<span class="event-time">' + escapeHtml(ev.time) + '</span>'
        + badge
        + '<span class="event-content">' + escapeHtml(ev.content) + '</span>'
        + '</div>';
    }).join('');
    scroll.innerHTML = (filtered.length === 0 ? '<div class="empty">No matching events.</div>' : '') + html;
    scroll.scrollTop = scroll.scrollHeight;
  }

  function renderSessions(sessions) {
    sessionList.innerHTML = sessions.map(s =>
      '<div class="session" data-path="' + escapeAttr(s.path) + '" title="' + escapeAttr(s.id) + '">'
      + '<span class="dot"></span>'
      + '<div class="session-info">'
      + '<span class="session-title">' + escapeHtml(s.title) + ' <span class="session-id">' + escapeHtml(s.id.slice(0,8)) + '</span></span>'
      + '<span class="session-meta">' + 'last logged ' + escapeHtml(s.lastLogged) + '</span>'
      + '</div></div>'
    ).join('');
    sessionList.querySelectorAll('.session').forEach(el => {
      el.addEventListener('click', () => {
        vscode.postMessage({ type: 'open-jsonl', path: el.dataset.path });
      });
    });
  }

  scroll.addEventListener('click', (e) => {
    const eventEl = e.target.closest('.event');
    if (!eventEl) return;
    const sessionId = eventEl.dataset.session;
    // Escape sessionId before injecting into the attribute selector —
    // sessionIds are UUIDs in practice but a stray quote would otherwise
    // break the query string.
    const sessionEl = sessionList.querySelector('.session[title^="' + sessionId.replace(/["\\\\]/g, '\\\\$&') + '"]');
    if (sessionEl) {
      vscode.postMessage({ type: 'open-jsonl', path: sessionEl.dataset.path, line: eventEl.dataset.line });
    }
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'init') {
      allEvents = msg.events || [];
      if (msg.ruleMatches) ruleMatchMap = msg.ruleMatches;
      renderEvents();
      renderSessions(msg.sessions || []);
      if (msg.jsonlDir) dirPath.textContent = msg.jsonlDir;
    }
    if (msg.type === 'event') {
      // AV5: keep allEvents bounded at 500 without using Array.shift.
      allEvents.push(msg.event);
      if (allEvents.length > 500) allEvents = allEvents.slice(allEvents.length - 500);
      renderEvents();
    }
    if (msg.type === 'rule-match') {
      ruleMatchMap[msg.entryId] = { ruleId: msg.ruleId, ruleName: msg.ruleName, severity: msg.severity, matchedText: msg.matchedText };
      renderEvents();
    }
    if (msg.type === 'sessions') {
      renderSessions(msg.sessions || []);
    }
    if (msg.type === 'monitor-status') {
      const running = msg.running;
      monitorDot.className = 'monitor-dot' + (running ? ' connected' : '');
      monitorLabel.textContent = running ? 'Monitor connected' : 'Monitor not connected';
    }
    if (msg.type === 'rules-reloaded') {
      lastRulesReload = { timestamp: msg.timestamp, count: msg.count };
      refreshRulesStatus();
    }
  });

  // Webview-side mirror of formatRulesReloaded (src/vscode_extension/rules_reloaded_format.ts).
  // Lives in the webview so the chip can age over time without round-tripping to the host.
  let lastRulesReload = null;
  function formatRulesAgo(timestamp, count, now) {
    const ageMs = now - timestamp;
    let when;
    if (ageMs < 5000) when = 'just reloaded';
    else if (ageMs < 60000) when = Math.floor(ageMs / 1000) + 's ago';
    else if (ageMs < 3600000) when = Math.floor(ageMs / 60000) + 'm ago';
    else when = Math.floor(ageMs / 3600000) + 'h ago';
    const noun = count === 1 ? 'rule' : 'rules';
    return count + ' ' + noun + ' · ' + when;
  }
  function refreshRulesStatus() {
    if (!lastRulesReload) {
      rulesStatus.classList.add('hidden');
      return;
    }
    rulesStatus.textContent = formatRulesAgo(lastRulesReload.timestamp, lastRulesReload.count, Date.now());
    rulesStatus.classList.remove('hidden');
  }
  setInterval(refreshRulesStatus, 10000);

  // Webview-side escape — mirrors src/audit/html_escape.ts.
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  const escapeAttr = escapeHtml;
</script>
</body>
</html>`;
}
