// FSAI Desktop renderer：单页 5 页面 UI
const api = window.fsai;
let state = null;

const STATUS_TEXT = { running: '🟢 Running', starting: '🟡 Starting', error: '🔴 Error', stopped: '⚪ Stopped' };
const STATUS_CLS = { running: 'status-running', starting: 'status-starting', error: 'status-error', stopped: 'status-stopped' };

// ---------- 通用 ----------
function el(id) { return document.getElementById(id); }
// 安全读取 checkbox 状态：元素不存在时返回默认值，避免表单缺字段导致保存崩溃
function checked(id, fallback = false) {
  const n = document.getElementById(id);
  return n ? !!n.checked : fallback;
}
// 安全读取输入值：元素不存在时返回默认值
function val(id, fallback = '') {
  const n = document.getElementById(id);
  return n ? n.value : fallback;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function refreshState() {
  const r = await api.invoke('get-state');
  if (r.ok) {
    state = r.data;
    renderAll();
  }
}

function openModal(title, bodyHtml) {
  el('modal-title').textContent = title;
  el('modal-body').innerHTML = bodyHtml;
  el('modal').hidden = false;
}
function closeModal() { el('modal').hidden = true; }

// ---------- 导航 ----------
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    el('page-' + btn.dataset.page).classList.add('active');
  });
});

// ---------- 动作分发 ----------
// 所有按钮用 data-action 声明动作，由全局委托统一分发（内联 onclick 会被 CSP script-src 'self' 拦截）
async function _act(channel, ...args) {
  await api.invoke(channel, ...args);
  await refreshState();
}

const ACTIONS = {
  // Bot 卡片
  'start-bot': (id) => _act('start-bot', id),
  'stop-bot': (id) => _act('stop-bot', id),
  'restart-bot': (id) => _act('restart-bot', id),
  'edit-bot': (id) => _editBot(id),
  'duplicate-bot': (id) => _act('duplicate-bot', id),
  'delete-bot': (id) => _deleteBot(id),
  'test-bot': (id) => _testBot(id),
  'bot-knowledge': (id) => _botKnowledge(id),
  'bot-chat-ws': (id) => _botChatWs(id),
  'save-knowledge': (id) => _saveKnowledge(id),
  'sync-knowledge': (id) => _syncKnowledge(id),
  'remove-knowledge-doc': (id, arg) => _removeKnowledgeDoc(id, arg),
  'remove-chat-ws': (id, arg) => _removeChatWs(id, arg),
  // Direct profile
  'edit-direct': (id) => _editDirect(id),
  'delete-direct-profile': (id) => _act('delete-direct-profile', id),
  // Workspace
  'open-folder': (id, arg) => _openFolder(arg),
  'edit-workspace': (id) => _editWorkspace(id),
  'delete-workspace': (id) => _act('delete-workspace', id),
  'new-workspace': () => _newWorkspace(),
  'goto-page': (id, arg) => _gotoPage(arg),
  // Modal 内动作
  'pick-folder': () => _pickFolder(),
  'save-new-ws': () => _saveNewWs(),
  'save-ws': (id) => _saveWs(id),
  'save-bot': (id) => _saveBot(id),
  'save-new-bot': () => _saveNewBot(),
  'run-test': (id) => _runTest(id),
  'save-new-direct': () => _saveNewDirect(),
  'save-direct': (id) => _saveDirect(id),
};

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const handler = ACTIONS[action];
  if (handler) {
    e.preventDefault();
    handler(btn.dataset.id, btn.dataset.arg);
  }
});

// runtime/source 下拉变化时，联动刷新 profile 选项
document.addEventListener('change', (e) => {
  if (e.target && (e.target.id === 'f-runtime' || e.target.id === 'f-source')) {
    refreshProfileSelect();
  }
});

// ---------- 渲染 ----------
function renderAll() {
  renderDoctorSummary();
  renderBots();
  renderModels();
  renderWorkspaces();
  renderLogs();
  renderChatLogSelect();
  renderSettings();
}

// ---------- 模型 Profile 选项（按 runtime + source 动态生成） ----------
// 返回 cc-switch 类型下、指定 runtime 的 profile 选项 HTML
function ccProfileOptions(runtime, selectedName) {
  const src = runtime === 'codex' ? (state.ccSwitchCodex?.profiles || []) : (state.ccSwitch?.profiles || []);
  return src.map((p) => `<option value="${esc(p.name)}" ${p.name === selectedName ? 'selected' : ''}>${esc(p.name)} — ${esc(p.provider || '')}</option>`).join('');
}

// 动态更新 modal 里的 Profile 下拉框（runtime/source 变化时）
function refreshProfileSelect() {
  const runtime = document.querySelector('#f-runtime')?.value || 'claude-code';
  const source = document.querySelector('#f-source')?.value || 'cc-switch';
  const profileBox = document.querySelector('#f-profile');
  const directBox = document.querySelector('#f-direct');
  if (!profileBox || !directBox) return;
  // cc-switch profile 下拉框：只有 source=cc-switch 时可用
  const selectedName = profileBox.dataset.selected || '';
  profileBox.innerHTML = ccProfileOptions(runtime, selectedName);
  profileBox.disabled = source !== 'cc-switch';
  directBox.disabled = source !== 'direct';
}

function renderDoctorSummary() {
  const d = state.doctor || {};
  const parts = [];
  parts.push(d.runtime?.found ? '✓ claude' : '✗ claude');
  parts.push(d.codex?.found ? '✓ codex' : '✗ codex');
  parts.push(d.models?.found ? '✓ cc-switch' : '✗ cc-switch');
  el('doctor-summary').textContent = parts.join('  ');
}

function renderBots() {
  const list = el('bot-list');
  if (!state.bots.length) {
    list.innerHTML = '<div class="card" style="grid-column:1/-1;color:var(--text-dim)">暂无 Bot，点击右上角 + New Bot 创建。</div>';
    return;
  }
  list.innerHTML = state.bots.map((b) => {
    const running = state.running.includes(b.id);
    const status = running ? 'running' : (b.lastStatus || 'stopped');
    const ws = state.workspaces.find((w) => w.id === b.workspaceId);
    const modelLabel = b.model.source === 'direct'
      ? (state.directProfiles.find((p) => p.id === b.model.profile)?.name || '?')
      : b.model.profile;
    const runtimeLabel = b.runtime?.type === 'codex' ? 'Codex CLI' : 'Claude Code';
    const perChat = b.workspaceMode === 'per-chat';
    const chatCount = Object.keys(b.chatWorkspaces || {}).length;
    const wsLabel = perChat
      ? `🌿 ${esc(ws?.name || '目录')} · 每群独立（${chatCount} 群）`
      : `📁 ${esc(ws?.name || '(未选目录)')}`;
    const knowledgeBadge = b.knowledge?.enabled ? '<div class="meta">🧠 知识内核</div>' : '';
    const listenBadge = b.listen?.enabled ? '<div class="meta">👂 全局监听</div>' : '';
    const runBtn = running
      ? `<button class="danger" data-action="stop-bot" data-id="${b.id}">Stop</button>
         <button data-action="restart-bot" data-id="${b.id}">Restart</button>`
      : `<button class="primary" data-action="start-bot" data-id="${b.id}">Start</button>`;
    return `
      <div class="bot-card">
        <div class="name-row">
          <span class="bot-name">${esc(b.name)}</span>
          <span class="status-dot ${STATUS_CLS[status] || 'status-stopped'}"></span>
        </div>
        <div class="meta">${STATUS_TEXT[status] || status}</div>
        <div class="meta">🧩 ${esc(modelLabel || '(未选模型)')}</div>
        <div class="meta">${wsLabel}</div>
        <div class="meta">⚙️ ${runtimeLabel}</div>
        ${knowledgeBadge}
        ${listenBadge}
        <div class="actions">
          ${runBtn}
          <button data-action="edit-bot" data-id="${b.id}">Edit</button>
          <button data-action="bot-knowledge" data-id="${b.id}">知识</button>
          ${perChat ? `<button data-action="bot-chat-ws" data-id="${b.id}">群目录</button>` : ''}
          <button data-action="duplicate-bot" data-id="${b.id}">Duplicate</button>
          <button class="danger" data-action="delete-bot" data-id="${b.id}">Delete</button>
          <button data-action="test-bot" data-id="${b.id}">Test</button>
        </div>
      </div>`;
  }).join('');
}

function renderModels() {
  const cs = state.ccSwitch || {};
  el('ccswitch-status').innerHTML = cs.found
    ? `<span style="color:var(--green)">✓ Detected</span> <span class="hint">${esc(cs.path || '')}</span>`
    : '<span style="color:var(--red)">✗ Not detected</span>（本机未装 cc-switch 时可用 Direct API 兜底）';
  el('ccswitch-profiles').innerHTML = (cs.profiles || []).length
    ? cs.profiles.map((p) => `<div class="table-row"><div><strong>${esc(p.name)}</strong><div class="hint">${esc(p.provider || '')} · ${esc(p.model || '(default)')}</div></div><span class="hint">${p.hasKey ? '✓ key' : '✗ no key'}</span></div>`).join('')
    : '<div class="hint">未发现 Profile</div>';

  // Codex 区
  const cx = state.ccSwitchCodex || {};
  el('ccswitch-codex-status').innerHTML = cx.found
    ? `<span style="color:var(--green)">✓ Detected</span> <span class="hint">${esc(cx.path || '')}</span>`
    : '<span style="color:var(--red)">✗ Not detected</span>';
  el('ccswitch-codex-profiles').innerHTML = (cx.profiles || []).length
    ? cx.profiles.map((p) => `<div class="table-row"><div><strong>${esc(p.name)}</strong><div class="hint">${esc(p.provider || '')} · ${esc(p.model || '(default)')}</div></div><span class="hint">${p.hasKey ? '✓ key' : '✗ no key'}</span></div>`).join('')
    : '<div class="hint">未发现 Codex Profile</div>';

  el('direct-list').innerHTML = state.directProfiles.length
    ? state.directProfiles.map((p) => `
      <div class="table-row">
        <div><strong>${esc(p.name)}</strong><div class="hint">${esc(p.provider || '')} · ${esc(p.model || '(default)')} · ${esc(p.baseUrl || '')}</div></div>
        <div class="actions">
          <button data-action="edit-direct" data-id="${p.id}">Edit</button>
          <button class="danger" data-action="delete-direct-profile" data-id="${p.id}">Delete</button>
        </div>
      </div>`).join('')
    : '<div class="hint">暂无 Direct API Profile</div>';
}

function renderWorkspaces() {
  const list = el('workspace-list');
  list.innerHTML = state.workspaces.length
    ? state.workspaces.map((w) => `
      <div class="table-row">
        <div><strong>${esc(w.name)}</strong><div class="hint">${esc(w.path)}</div></div>
        <div class="actions">
          <button data-action="open-folder" data-arg="${esc(w.path)}">Open</button>
          <button data-action="edit-workspace" data-id="${w.id}">Edit</button>
          <button class="danger" data-action="delete-workspace" data-id="${w.id}">Remove</button>
        </div>
      </div>`).join('')
    : '<div class="hint" style="padding:16px">暂无 Workspace</div>';
}

async function renderLogs() {
  const r = await api.invoke('get-logs', {});
  if (!r.ok) return;
  const logs = r.data.slice(-200).reverse();
  el('log-list').innerHTML = logs.map((l) =>
    `<div class="log-line log-level-${l.level}">[${new Date(l.ts).toLocaleTimeString()}] [${l.level.toUpperCase()}] [${esc(l.source)}] ${esc(l.message)}</div>`
  ).join('') || '<div class="hint">暂无日志</div>';
}

function renderSettings() {
  const g = state.settings.general;
  const rt = state.settings.runtime;
  el('set-start-on-login').checked = g.startOnLogin;
  el('set-minimize-tray').checked = g.minimizeToTray;
  el('set-auto-start-bots').checked = g.autoStartBots;
  el('set-claude-path').value = rt.claudePath || '';
  el('set-codex-path').value = rt.codexPath || '';
  el('set-ccswitch-path').value = rt.ccSwitchPath || '';
}

// ---------- 动作实现 ----------
async function _deleteBot(id) {
  if (!confirm('删除该 Bot？配置将被移除，Workspace 文件不会被删除。')) return;
  await _act('delete-bot', id);
}

async function _openFolder(p) {
  await api.invoke('open-folder', p);
}

async function _renderChatLog() {
  const select = el('chatlog-bot-select');
  const botId = select?.value;
  if (!botId) { el('chatlog-list').innerHTML = '<div class="hint">请先选择 Bot</div>'; return; }
  const r = await api.invoke('get-chatlog', botId, { limit: 500 });
  const records = r.ok ? r.data : [];
  el('chatlog-list').innerHTML = records.length
    ? records.map((rec) => {
        const t = new Date(rec.ts).toLocaleString();
        const isUser = rec.type === 'user';
        const color = isUser ? 'var(--accent)' : (rec.ok === false ? 'var(--red)' : 'var(--green)');
        const label = rec.type === 'user' ? '用户' : (rec.ok === false ? '错误' : '回复');
        return `<div style="margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--border)">
          <div style="color:${color};font-weight:600">[${t}] ${label}${rec.durationMs != null ? ' · ' + rec.durationMs + 'ms' : ''}</div>
          <div style="white-space:pre-wrap;word-break:break-all;color:var(--text);margin-top:4px">${esc(rec.content)}</div>
          ${rec.error ? `<div style="color:var(--red);margin-top:2px">${esc(rec.error)}</div>` : ''}
        </div>`;
      }).join('')
    : '<div class="hint">暂无聊天记录</div>';
}

// 渲染 Logs 页的 Bot 下拉框
function renderChatLogSelect() {
  const select = el('chatlog-bot-select');
  if (!select) return;
  const prev = select.value;
  select.innerHTML = state.bots.map((b) => `<option value="${b.id}" ${b.id === prev ? 'selected' : ''}>${esc(b.name)}</option>`).join('');
}

function _testBot(id) {
  openModal('Test Bot', `
    <div class="field-group">
      <label>输入测试消息<textarea id="test-input" style="width:100%;height:80px;background:var(--panel-2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:8px"></textarea></label>
    </div>
    <div class="modal-actions">
      <button data-action="run-test" data-id="${id}">Run</button>
    </div>
    <div class="test-result" id="test-result">（结果将显示在这里）</div>
  `);
}

async function _runTest(id) {
  const text = document.querySelector('#test-input').value;
  const box = el('test-result');
  box.textContent = '执行中…';
  const r = await api.invoke('test-bot', id, text);
  box.textContent = r.ok ? (r.data.ok ? r.data.text : `Error: ${r.data.error}`) : `Error: ${r.error}`;
}

// ---------- 知识内核（跨群共享）----------
async function _botKnowledge(botId) {
  const bot = state.bots.find((x) => x.id === botId);
  const [k, assets] = await Promise.all([
    api.invoke('get-knowledge', botId),
    api.invoke('list-knowledge-assets', botId),
  ]);
  const content = k.ok ? k.data : '';
  const a = assets.ok ? assets.data : { memory: [], skills: [], docs: [], dir: '' };
  const list = (arr) => arr.length
    ? arr.map((x) => `<div class="hint">${x.isDir ? '📁' : '📄'} ${esc(x.name)}${x.size ? ` (${(x.size / 1024).toFixed(1)}KB)` : ''}</div>`).join('')
    : '<div class="hint">（空）</div>';
  const docsList = (a.docs || []).length
    ? (a.docs || []).map((x) => `<div class="table-row" style="padding:6px 0">
        <div class="hint">📄 ${esc(x.name)} ${x.size ? `(${(x.size / 1024).toFixed(1)}KB)` : ''}</div>
        <button class="danger" data-action="remove-knowledge-doc" data-id="${botId}" data-arg="${esc(x.name)}">删除</button>
      </div>`).join('')
    : '<div class="hint">（空）在飞书群里 @机器人 发文件，或说「记住：xxx」</div>';

  openModal(`知识内核 — ${bot?.name || ''}`, `
    <div class="hint" style="margin-bottom:8px">
      这是该 Bot 所有群共享的知识。修改后所有群立即生效。
    </div>
    <div class="field-group">
      <label>CLAUDE.md（共享知识）</label>
      <textarea id="kb-content" style="width:100%;height:220px;background:var(--panel-2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:8px;font-family:monospace;font-size:12px">${esc(content)}</textarea>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:12px">
      <button data-action="save-knowledge" data-id="${botId}" class="primary">保存</button>
      <button data-action="sync-knowledge" data-id="${botId}">从本机 ~/.claude 同步技能</button>
      <button data-action="open-folder" data-arg="${esc(a.dir || '')}">打开目录</button>
    </div>
    <div class="card" style="margin:0">
      <h2>已投喂文档（docs/）</h2>${docsList}
    </div>
    <div class="card" style="margin:10px 0 0">
      <h2>自动积累的记忆（memory/）</h2>${list(a.memory || [])}
    </div>
    <div class="card" style="margin:10px 0 0">
      <h2>沉淀的技能（skills/）</h2>${list(a.skills || [])}
    </div>
  `);
}

async function _removeKnowledgeDoc(botId, fileName) {
  if (!confirm(`删除已投喂的文档「${fileName}」？`)) return;
  const r = await api.invoke('remove-knowledge-doc', botId, fileName);
  if (!r.ok || !r.data?.ok) { alert(`删除失败: ${r.data?.error || r.error}`); return; }
  await _botKnowledge(botId); // 刷新弹窗
}

async function _saveKnowledge(botId) {
  const content = document.querySelector('#kb-content')?.value ?? '';
  await api.invoke('save-knowledge', botId, content);
  alert('已保存。所有群立即生效。');
}

async function _syncKnowledge(botId) {
  const r = await api.invoke('sync-knowledge', botId);
  alert(r.ok ? `已同步（${r.data?.copied ?? 0} 项）` : `同步失败: ${r.error}`);
}

// ---------- 群工作目录 ----------
async function _botChatWs(botId) {
  const r = await api.invoke('list-chat-workspaces', botId);
  const rows = (r.ok ? r.data : []);
  openModal('群工作目录', `
    <div class="hint" style="margin-bottom:10px">
      每个飞书群有独立的工作目录，互不干扰。共 ${rows.length} 个群。
    </div>
    ${rows.length ? rows.map((c) => `
      <div class="table-row">
        <div>
          <strong>${esc(c.chatId)}</strong>
          <div class="hint">${esc(c.path || '(无)')}</div>
          <div class="hint">${c.exists ? '✓ 目录存在' : '⚠ 目录不存在'}${(c.memories || []).length ? ` · 🧠 ${c.memories.length} 个记忆文件` : ''}</div>
          ${(c.memories || []).length ? `<div class="hint" style="padding-left:8px">${(c.memories || []).map((m) => '📄 ' + esc(m)).join(' · ')}</div>` : ''}
        </div>
        <div class="actions">
          <button data-action="open-folder" data-arg="${esc(c.path || '')}">Open</button>
          <button class="danger" data-action="remove-chat-ws" data-id="${botId}" data-arg="${esc(c.chatId)}">移除</button>
        </div>
      </div>`).join('') : '<div class="hint">暂无群工作目录（该 Bot 还没收到过消息）</div>'}
  `);
}

async function _removeChatWs(botId, chatId) {
  let r = await api.invoke('remove-chat-workspace', botId, chatId, false);
  if (!r.ok) { alert(`失败: ${r.error}`); return; }
  if (r.data?.ok) { await refreshState(); return; }
  // 目录非空，需要二次确认
  if (r.data?.dirty) {
    if (!confirm('该群工作目录非空，强制移除会永久丢失其中的文件。确定继续？')) return;
    const r2 = await api.invoke('remove-chat-workspace', botId, chatId, true);
    if (!r2.ok || !r2.data?.ok) { alert(`失败: ${r2.data?.error || r2.error}`); return; }
    await refreshState();
  }
}

// ---------- Bot 编辑表单 ----------
function _editBot(id) {
  const b = state.bots.find((x) => x.id === id);
  if (!b) return;
  const runtime = b.runtime?.type || 'claude-code';
  const directOpts = state.directProfiles.map((p) => `<option value="${p.id}" ${p.id === b.model.profile ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  const ccProfiles = ccProfileOptions(runtime, b.model.profile);

  openModal('Edit Bot', `
    <div class="field-group"><label>Bot Name<input type="text" id="f-name" value="${esc(b.name)}"></label></div>
    <div class="field-group"><label>Feishu App ID<input type="text" id="f-appid" value="${esc(b.feishu.appId)}"></label></div>
    <div class="field-group"><label>Feishu App Secret<input type="password" id="f-secret" placeholder="（已保存，留空不改）"></label></div>
    <div class="field-group">
      <label>Runtime
        <select id="f-runtime">
          <option value="claude-code" ${runtime === 'claude-code' ? 'selected' : ''}>Claude Code</option>
          <option value="codex" ${runtime === 'codex' ? 'selected' : ''}>Codex CLI</option>
        </select>
      </label>
    </div>
    <div class="field-group">
      <label>Model Source
        <select id="f-source">
          <option value="cc-switch" ${b.model.source === 'cc-switch' ? 'selected' : ''}>cc-switch</option>
          <option value="direct" ${b.model.source === 'direct' ? 'selected' : ''}>Direct API</option>
        </select>
      </label>
    </div>
    <div class="field-group"><label>Profile (cc-switch)<select id="f-profile" data-selected="${esc(b.model.profile)}">${ccProfiles}</select></label></div>
    <div class="field-group"><label>Profile (Direct API)<select id="f-direct">${directOpts}</select></label></div>
    <div class="field-group"><label>Workspace</label>${workspaceSelectHtml(b.workspaceId)}</div>
    <div class="field-group"><label><input type="checkbox" id="f-perchat" ${b.workspaceMode === 'per-chat' ? 'checked' : ''} /> 每个飞书群使用独立工作目录</label>
      <div class="hint">开启后，各群在 Workspace 下的独立子目录中干活，互不干扰</div></div>
    <div class="field-group"><label><input type="checkbox" id="f-knowledge" ${b.knowledge?.enabled ? 'checked' : ''} /> 启用知识内核</label>
      <div class="hint">所有群共享一份 CLAUDE.md + memory + skills，升级一次全部生效</div></div>
    <div class="field-group"><label><input type="checkbox" id="f-listen" ${b.listen?.enabled ? 'checked' : ''} /> 全局监听群消息（不只 @ 它）</label>
      <div class="hint">开启后 Bot 会读取群内所有消息并判断是否需要回复。默认关闭（仅 @ 时回复）</div></div>
    <div class="field-group"><label><input type="checkbox" id="f-aijudge" ${b.listen?.useAIJudge !== false ? 'checked' : ''} /> 用 AI 判断意图</label>
      <div class="hint">规则不确定时调模型判断是否该回复（关闭则只按触发词/@ 判断，更省成本）</div></div>
    <div class="field-group"><label><input type="checkbox" id="f-auto" ${b.autoStart ? 'checked' : ''} /> Start automatically</label></div>
    <div class="field-group"><label><input type="checkbox" id="f-skip" ${b.skipPermissions ? 'checked' : ''} /> --dangerously-skip-permissions</label></div>
    <div class="modal-actions"><button data-action="save-bot" data-id="${b.id}" class="primary">Save</button></div>
  `);
  refreshProfileSelect();
}

async function _saveBot(id) {
  const b = state.bots.find((x) => x.id === id);
  const runtimeType = document.querySelector('#f-runtime').value;
  const source = document.querySelector('#f-source').value;
  const profile = source === 'direct' ? document.querySelector('#f-direct').value : document.querySelector('#f-profile').value;
  const updated = {
    ...b,
    name: document.querySelector('#f-name').value,
    feishu: { appId: document.querySelector('#f-appid').value, appSecret: document.querySelector('#f-secret').value },
    runtime: { type: runtimeType },
    model: { source, profile },
    workspaceId: val('f-ws'),
    workspaceMode: checked('f-perchat') ? 'per-chat' : 'shared',
    chatWorkspaces: b.chatWorkspaces || {}, // 保留已有群目录注册表
    knowledge: { ...(b.knowledge || {}), enabled: checked('f-knowledge') },
    listen: {
      ...(b.listen || {}),
      enabled: checked('f-listen'),
      useAIJudge: checked('f-aijudge', true),
    },
    autoStart: checked('f-auto'),
    skipPermissions: checked('f-skip'),
  };
  await api.invoke('save-bot', updated);
  closeModal();
  await refreshState();
}

// ---------- New Bot ----------
function _newBot() {
  openModal('New Bot', `
    <div class="field-group"><label>Bot Name<input type="text" id="f-name" placeholder="Backend Coder"></label></div>
    <div class="field-group"><label>Feishu App ID<input type="text" id="f-appid"></label></div>
    <div class="field-group"><label>Feishu App Secret<input type="password" id="f-secret"></label></div>
    <div class="field-group">
      <label>Runtime
        <select id="f-runtime">
          <option value="claude-code" selected>Claude Code</option>
          <option value="codex">Codex CLI</option>
        </select>
      </label>
    </div>
    <div class="field-group">
      <label>Model Source
        <select id="f-source">
          <option value="cc-switch" selected>cc-switch</option>
          <option value="direct">Direct API</option>
        </select>
      </label>
    </div>
    <div class="field-group"><label>Profile (cc-switch)<select id="f-profile" data-selected="">${ccProfileOptions('claude-code', '')}</select></label></div>
    <div class="field-group"><label>Profile (Direct API)<select id="f-direct">${state.directProfiles.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label></div>
    <div class="field-group"><label>Workspace</label>${workspaceSelectHtml('')}</div>
    <div class="field-group"><label><input type="checkbox" id="f-perchat" /> 每个飞书群使用独立工作目录</label>
      <div class="hint">开启后，各群在 Workspace 下的独立子目录中干活，互不干扰</div></div>
    <div class="field-group"><label><input type="checkbox" id="f-knowledge" /> 启用知识内核</label>
      <div class="hint">所有群共享一份 CLAUDE.md + memory + skills，升级一次全部生效</div></div>
    <div class="field-group"><label><input type="checkbox" id="f-listen" /> 全局监听群消息（不只 @ 它）</label>
      <div class="hint">开启后 Bot 会读取群内所有消息并判断是否需要回复。默认关闭（仅 @ 时回复）</div></div>
    <div class="field-group"><label><input type="checkbox" id="f-aijudge" checked /> 用 AI 判断意图</label>
      <div class="hint">规则不确定时调模型判断是否该回复（关闭则只按触发词/@ 判断，更省成本）</div></div>
    <div class="modal-actions"><button data-action="save-new-bot" class="primary">Save</button></div>
  `);
  refreshProfileSelect();
}

async function _saveNewBot() {
  const wsVal = val('f-ws');
  if (!wsVal) { alert('请先添加一个 Workspace（工作目录）'); return; }
  const runtimeType = document.querySelector('#f-runtime').value;
  const source = document.querySelector('#f-source').value;
  const profile = source === 'direct' ? document.querySelector('#f-direct').value : document.querySelector('#f-profile').value;
  const bot = {
    id: 'bot-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: document.querySelector('#f-name').value,
    feishu: { appId: document.querySelector('#f-appid').value, appSecret: document.querySelector('#f-secret').value },
    model: { source, profile },
    runtime: { type: runtimeType },
    workspaceId: val('f-ws'),
    workspaceMode: checked('f-perchat') ? 'per-chat' : 'shared',
    chatWorkspaces: {},
    chatSessions: {},
    knowledge: { enabled: checked('f-knowledge'), autoMemory: true, autoSkills: true },
    listen: { enabled: checked('f-listen'), triggers: [], useAIJudge: checked('f-aijudge', true) },
    autoStart: false,
    skipPermissions: false,
    lastStatus: 'stopped',
  };
  await api.invoke('save-bot', bot);
  closeModal();
  await refreshState();
}

// ---------- Workspace ----------
// 渲染 Workspace 下拉框；为空时显示引导 + 快捷新建入口
function workspaceSelectHtml(selectedId) {
  if (!state.workspaces.length) {
    return `<div class="hint" style="color:var(--yellow)">还没有 Workspace，请先<a href="#" data-action="goto-page" data-arg="workspaces">到 Workspaces 页添加</a>，或<button data-action="new-workspace" style="margin-left:6px">+ 立即新建</button></div>
      <input type="hidden" id="f-ws" value="">`;
  }
  const opts = state.workspaces.map((w) =>
    `<option value="${w.id}" ${w.id === selectedId ? 'selected' : ''}>${esc(w.name)} — ${esc(w.path)}</option>`
  ).join('');
  return `<select id="f-ws">${opts}</select>`;
}

function _gotoPage(page) {
  closeModal();
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  document.querySelector('.nav-item[data-page="' + page + '"]').classList.add('active');
  el('page-' + page).classList.add('active');
}

function _newWorkspace() {
  openModal('Add Workspace', `
    <div class="field-group"><label>Name<input type="text" id="f-wsname" placeholder="backend"></label></div>
    <div class="field-group"><label>Path<input type="text" id="f-wspath"></label><button data-action="pick-folder" style="margin-top:6px">Choose Folder</button></div>
    <div class="modal-actions"><button data-action="save-new-ws" class="primary">Save</button></div>
  `);
}

async function _pickFolder() {
  const r = await api.invoke('choose-folder');
  if (r.ok && r.data) document.querySelector('#f-wspath').value = r.data;
}

async function _saveNewWs() {
  const ws = {
    id: 'ws-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: document.querySelector('#f-wsname').value,
    path: document.querySelector('#f-wspath').value,
  };
  await api.invoke('save-workspace', ws);
  closeModal();
  await refreshState();
}

function _editWorkspace(id) {
  const w = state.workspaces.find((x) => x.id === id);
  if (!w) return;
  openModal('Edit Workspace', `
    <div class="field-group"><label>Name<input type="text" id="f-wsname" value="${esc(w.name)}"></label></div>
    <div class="field-group"><label>Path<input type="text" id="f-wspath" value="${esc(w.path)}"></label><button data-action="pick-folder" style="margin-top:6px">Choose Folder</button></div>
    <div class="modal-actions"><button data-action="save-ws" data-id="${w.id}" class="primary">Save</button></div>
  `);
}

async function _saveWs(id) {
  const w = state.workspaces.find((x) => x.id === id);
  const updated = { ...w, name: document.querySelector('#f-wsname').value, path: document.querySelector('#f-wspath').value };
  await api.invoke('save-workspace', updated);
  closeModal();
  await refreshState();
}

// ---------- Direct profile ----------
function _newDirect() {
  openModal('New Direct API Profile', `
    <div class="field-group"><label>Name<input type="text" id="f-dname" placeholder="My Kimi"></label></div>
    <div class="field-group"><label>Provider<input type="text" id="f-dprovider" placeholder="Kimi"></label></div>
    <div class="field-group"><label>Base URL<input type="text" id="f-dbase" placeholder="https://api.moonshot.cn/anthropic"></label></div>
    <div class="field-group"><label>API Key<input type="password" id="f-dkey"></label></div>
    <div class="field-group"><label>Model<input type="text" id="f-dmodel" placeholder="kimi-k2"></label></div>
    <div class="modal-actions"><button data-action="save-new-direct" class="primary">Save</button></div>
  `);
}

async function _saveNewDirect() {
  const p = {
    id: 'mp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: document.querySelector('#f-dname').value,
    provider: document.querySelector('#f-dprovider').value,
    baseUrl: document.querySelector('#f-dbase').value,
    apiKey: document.querySelector('#f-dkey').value,
    model: document.querySelector('#f-dmodel').value,
  };
  await api.invoke('save-direct-profile', p);
  closeModal();
  await refreshState();
}

function _editDirect(id) {
  const p = state.directProfiles.find((x) => x.id === id);
  if (!p) return;
  openModal('Edit Direct API Profile', `
    <div class="field-group"><label>Name<input type="text" id="f-dname" value="${esc(p.name)}"></label></div>
    <div class="field-group"><label>Provider<input type="text" id="f-dprovider" value="${esc(p.provider)}"></label></div>
    <div class="field-group"><label>Base URL<input type="text" id="f-dbase" value="${esc(p.baseUrl)}"></label></div>
    <div class="field-group"><label>API Key<input type="password" id="f-dkey" placeholder="（已保存，留空不改）"></label></div>
    <div class="field-group"><label>Model<input type="text" id="f-dmodel" value="${esc(p.model)}"></label></div>
    <div class="modal-actions"><button data-action="save-direct" data-id="${p.id}" class="primary">Save</button></div>
  `);
}

async function _saveDirect(id) {
  const p = state.directProfiles.find((x) => x.id === id);
  const updated = {
    ...p,
    name: document.querySelector('#f-dname').value,
    provider: document.querySelector('#f-dprovider').value,
    baseUrl: document.querySelector('#f-dbase').value,
    apiKey: document.querySelector('#f-dkey').value,
    model: document.querySelector('#f-dmodel').value,
  };
  await api.invoke('save-direct-profile', updated);
  closeModal();
  await refreshState();
}

// ---------- Settings ----------
async function _saveSettings() {
  await api.invoke('update-settings', {
    general: {
      startOnLogin: document.querySelector('#set-start-on-login').checked,
      minimizeToTray: document.querySelector('#set-minimize-tray').checked,
      autoStartBots: document.querySelector('#set-auto-start-bots').checked,
    },
    runtime: {
      claudePath: document.querySelector('#set-claude-path').value,
      codexPath: document.querySelector('#set-codex-path').value,
      ccSwitchPath: document.querySelector('#set-ccswitch-path').value,
    },
  });
  await refreshState();
}

async function _runDoctor() {
  const r = await api.invoke('run-doctor');
  if (r.ok) {
    el('doctor-result').textContent = JSON.stringify(r.data, null, 2);
  }
}

// ---------- 事件绑定（静态按钮） ----------
el('btn-new-bot').addEventListener('click', _newBot);
el('btn-new-workspace').addEventListener('click', _newWorkspace);
el('btn-new-direct').addEventListener('click', _newDirect);
el('btn-refresh-ccswitch').addEventListener('click', async () => { await api.invoke('refresh-ccswitch'); await refreshState(); });
el('btn-refresh-logs').addEventListener('click', renderLogs);
el('btn-refresh-chatlog').addEventListener('click', _renderChatLog);
el('btn-save-settings').addEventListener('click', _saveSettings);
el('btn-run-doctor').addEventListener('click', _runDoctor);
el('modal-close').addEventListener('click', closeModal);

// 监听主进程推送
api.on('bot-status', () => refreshState());
api.on('bots-changed', () => refreshState());

// 初始加载
refreshState();
