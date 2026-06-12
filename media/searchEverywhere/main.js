// @ts-check
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  // ── State ─────────────────────────────────────────────────────────
  let activeTab    = 'all';
  let allItems     = [];   // {type, label, detail, uriString?, line?, commandId?, symbolKind?}
  let filteredItems = [];
  let selectedIdx  = -1;

  // ── DOM refs ──────────────────────────────────────────────────────
  const seInput   = document.getElementById('seInput');
  const seTabs    = document.getElementById('seTabs');
  const seResults = document.getElementById('seResults');
  const seEmpty   = document.getElementById('seEmpty');
  const seStatus  = document.getElementById('seStatus');
  const sePreview = document.getElementById('sePreview');
  const backdrop  = document.getElementById('backdrop');

  // ── Icons per type / symbol kind ─────────────────────────────────
  const TYPE_ICON = { file: '📄', symbol: '🔷', text: '⌕', action: '⚡' };
  const SYMBOL_ICONS = ['📄','📦','📦','🔧','🔧','🔷','🔷','🏷️','🔑','📊','🔢','⚡','🔑','🔑','⬡','⬡','🔷','🔗','📄','📋','🔷','🔷','📄','📂','📦'];

  function symbolIcon(kind) {
    return SYMBOL_ICONS[kind] || '🔷';
  }

  // ── Tab switching ─────────────────────────────────────────────────
  seTabs.addEventListener('click', e => {
    const btn = /** @type {HTMLElement} */ (e.target);
    if (!btn.classList.contains('se-tab')) { return; }
    seTabs.querySelectorAll('.se-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    activeTab = btn.dataset.tab;
    if (seInput.value.trim()) { doSearch(); }
  });

  // ── Search input ──────────────────────────────────────────────────
  let searchTimer = null;
  seInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    if (!seInput.value.trim()) { clearResults(); return; }
    searchTimer = setTimeout(doSearch, 200);
  });

  seInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') { vscode.postMessage({ cmd: 'close' }); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      const tabs = Array.from(seTabs.querySelectorAll('.se-tab'));
      const cur  = tabs.findIndex(t => t.classList.contains('active'));
      const next = (cur + 1) % tabs.length;
      tabs[cur].classList.remove('active');
      tabs[next].classList.add('active');
      activeTab = tabs[next].dataset.tab;
      if (seInput.value.trim()) { doSearch(); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); moveSelection(-1); return; }
    if (e.key === 'Enter')     { e.preventDefault(); activateSelected(); return; }
  });

  if (backdrop) {
    backdrop.addEventListener('click', () => vscode.postMessage({ cmd: 'close' }));
  }

  // ── Search ────────────────────────────────────────────────────────
  function doSearch() {
    allItems = [];
    filteredItems = [];
    selectedIdx   = -1;
    seResults.innerHTML = '';
    seEmpty.style.display = 'none';
    seStatus.textContent = 'Searching…';
    sePreview.innerHTML = '<div class="se-preview-empty">Select a result to preview</div>';
    vscode.postMessage({ cmd: 'search', query: seInput.value.trim(), tab: activeTab });
  }

  function clearResults() {
    allItems = []; filteredItems = []; selectedIdx = -1;
    seResults.innerHTML = '';
    seEmpty.style.display = 'flex';
    seStatus.textContent = '';
    sePreview.innerHTML = '<div class="se-preview-empty">Select a result to preview</div>';
  }

  // ── Result rendering ──────────────────────────────────────────────
  const CATEGORY_LABELS = { file:'Files', symbol:'Symbols', text:'Text matches', action:'Actions' };

  function appendItem(item) {
    allItems.push(item);
    filteredItems.push(item);

    // Category header: show if first item of this type
    const prevType = allItems[allItems.length - 2]?.type;
    if (item.type !== prevType) {
      const cat = document.createElement('div');
      cat.className = 'se-category';
      cat.textContent = CATEGORY_LABELS[item.type] || item.type;
      seResults.appendChild(cat);
    }

    const el = document.createElement('div');
    el.className = 'se-item';
    el.setAttribute('tabindex', '-1');
    el.dataset.idx = String(filteredItems.length - 1);

    const icon = document.createElement('span');
    icon.className = 'se-item-icon';
    icon.textContent = item.type === 'symbol' ? symbolIcon(item.symbolKind) : (TYPE_ICON[item.type] || '•');

    const body = document.createElement('div');
    body.className = 'se-item-body';

    const lbl = document.createElement('div');
    lbl.className = 'se-item-label';
    lbl.textContent = item.label;

    const det = document.createElement('div');
    det.className = 'se-item-detail';
    det.textContent = item.detail;

    body.append(lbl, det);
    el.append(icon, body);

    el.addEventListener('click', () => activateItem(item));
    el.addEventListener('mouseenter', () => {
      setSelected(filteredItems.indexOf(item));
      previewItem(item);
    });

    seResults.appendChild(el);
    seEmpty.style.display = 'none';
  }

  function setSelected(idx) {
    seResults.querySelectorAll('.se-item').forEach((el, i) => {
      el.classList.toggle('selected', i === idx);
    });
    selectedIdx = idx;
    if (idx >= 0) {
      const items = Array.from(seResults.querySelectorAll('.se-item'));
      if (items[idx]) { items[idx].scrollIntoView({ block: 'nearest' }); }
    }
  }

  function moveSelection(delta) {
    const items = Array.from(seResults.querySelectorAll('.se-item'));
    if (!items.length) { return; }
    let next = selectedIdx + delta;
    if (next < 0)           { next = items.length - 1; }
    if (next >= items.length) { next = 0; }
    setSelected(next);
    if (filteredItems[next]) { previewItem(filteredItems[next]); }
  }

  function activateSelected() {
    if (selectedIdx >= 0 && filteredItems[selectedIdx]) {
      activateItem(filteredItems[selectedIdx]);
    }
  }

  function activateItem(item) {
    if (item.type === 'action') {
      vscode.postMessage({ cmd: 'runCommand', commandId: item.commandId });
    } else {
      vscode.postMessage({ cmd: 'openFile', uriString: item.uriString, lineNumber: item.line || 0 });
    }
  }

  function previewItem(item) {
    if (!item.uriString) { return; }
    vscode.postMessage({ cmd: 'previewFile', uriString: item.uriString, lineNumber: item.line || 0 });
  }

  // ── Preview rendering ─────────────────────────────────────────────
  function renderPreview(lines, startLine, matchLine) {
    sePreview.innerHTML = '';

    const pathEl = document.createElement('div');
    pathEl.className = 'se-preview-path';
    pathEl.textContent = filteredItems[selectedIdx]?.detail || '';
    sePreview.appendChild(pathEl);

    const code = document.createElement('div');
    code.className = 'se-preview-code';

    for (let i = 0; i < lines.length; i++) {
      const al  = startLine + i;
      const row = document.createElement('div');
      row.className = 'se-preview-line' + (al === matchLine ? ' match-line' : '');

      const num = document.createElement('span');
      num.className = 'se-preview-linenum';
      num.textContent = String(al + 1);

      const txt = document.createElement('span');
      txt.className = 'se-preview-linetext';
      const raw = lines[i];
      txt.textContent = raw.length > 300 ? raw.slice(0, 300) + '…' : raw;

      row.append(num, txt);
      code.appendChild(row);
    }
    sePreview.appendChild(code);

    const matchRow = code.querySelector('.match-line');
    if (matchRow) { matchRow.scrollIntoView({ block: 'center', behavior: 'instant' }); }
  }

  // ── Message bus ───────────────────────────────────────────────────
  window.addEventListener('message', event => {
    const msg = event.data;
    switch (msg.cmd) {
      case 'init':
        seInput.focus();
        break;

      case 'result':
        appendItem(msg);
        seStatus.textContent = `${allItems.length} results`;
        break;

      case 'categoryDone':
        break;

      case 'searchDone':
        if (!allItems.length) {
          seEmpty.style.display = 'flex';
          seEmpty.querySelector('.se-empty-text').textContent = `No results for "${seInput.value}"`;
          seStatus.textContent = 'No results';
        } else {
          seStatus.textContent = `${allItems.length} results`;
          if (selectedIdx < 0) { setSelected(0); if (filteredItems[0]) previewItem(filteredItems[0]); }
        }
        break;

      case 'previewContent':
        renderPreview(msg.lines, msg.startLine, msg.matchLine);
        break;
    }
  });

  // ── Boot ──────────────────────────────────────────────────────────
  vscode.postMessage({ cmd: 'ready' });
})();
