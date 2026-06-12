// @ts-check
(function () {
  'use strict';

  /** @type {any} */
  const vscode = acquireVsCodeApi();
  const MODE = window.__IDEA_SEARCH_MODE || 'popup';

  // ── State ────────────────────────────────────────────────────────────
  let state = vscode.getState() || {
    query: {
      text: '',
      isRegex: false,
      isCaseSensitive: false,
      isWholeWord: false,
      fileMask: '',
      scopeId: 'project',
    },
    results: /** @type {any[]} */ ([]),
    totalMatches: 0,
    totalFiles: 0,
    viewMode: /** @type {'flat'|'tree'} */ ('flat'),
    scopes: /** @type {any[]} */ ([]),
  };

  // ── DOM refs ─────────────────────────────────────────────────────────
  const $ = /** @param {string} id */ id => document.getElementById(id);
  const searchInput   = /** @type {HTMLInputElement}  */ ($('searchInput'));
  const replaceInput  = /** @type {HTMLInputElement}  */ ($('replaceInput'));
  const maskInput     = /** @type {HTMLInputElement}  */ ($('maskInput'));
  const scopeSelect   = /** @type {HTMLSelectElement} */ ($('scopeSelect'));
  const resultsList   = $('resultsList');
  const emptyState    = $('emptyState');
  const statusText    = $('statusText');
  const btnCase       = $('btnCase');
  const btnWord       = $('btnWord');
  const btnRegex      = $('btnRegex');
  const toggleReplace = $('toggleReplace');
  const replaceRow    = $('replaceRow');
  const btnOpenInTab  = $('btnOpenInTab');
  const btnToggleView = $('btnToggleView');
  const btnReplaceAll = $('btnReplaceAll');
  const backdrop      = $('backdrop');

  // ── Init ─────────────────────────────────────────────────────────────
  function initUI() {
    searchInput.value = state.query.text || '';
    maskInput.value   = state.query.fileMask || '';
    syncFlags();
    setTimeout(() => searchInput.focus(), 50);
  }

  function syncFlags() {
    btnCase.classList.toggle('active',  state.query.isCaseSensitive);
    btnWord.classList.toggle('active',  state.query.isWholeWord);
    btnRegex.classList.toggle('active', state.query.isRegex);
  }

  function renderScopes() {
    scopeSelect.innerHTML = '';
    state.scopes.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      opt.selected = s.id === state.query.scopeId;
      scopeSelect.appendChild(opt);
    });
  }

  // ── Event handlers ───────────────────────────────────────────────────
  searchInput.addEventListener('input', debounce(() => {
    state.query.text = searchInput.value;
    if (state.query.text.length >= 1) {
      triggerSearch();
    } else {
      clearResults('Enter a search query to find in files');
    }
  }, 300));

  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') { vscode.postMessage({ cmd: 'close' }); }
    else if (e.key === 'Enter') { triggerSearch(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); focusFirstResult(); }
  });

  maskInput.addEventListener('input', debounce(() => {
    state.query.fileMask = maskInput.value;
    if (state.query.text) { triggerSearch(); }
  }, 400));

  scopeSelect.addEventListener('change', () => {
    state.query.scopeId = scopeSelect.value;
    if (state.query.text) { triggerSearch(); }
  });

  [btnCase, btnWord, btnRegex].forEach(btn => {
    btn.addEventListener('click', () => {
      const f = btn.dataset.flag;
      if (f === 'case')  { state.query.isCaseSensitive = !state.query.isCaseSensitive; }
      if (f === 'word')  { state.query.isWholeWord     = !state.query.isWholeWord; }
      if (f === 'regex') { state.query.isRegex         = !state.query.isRegex; }
      syncFlags();
      if (state.query.text) { triggerSearch(); }
    });
  });

  toggleReplace.addEventListener('click', () => {
    const wasHidden = replaceRow.classList.toggle('hidden');
    toggleReplace.textContent = wasHidden ? '▶' : '▼';
    if (!wasHidden) { replaceInput.focus(); }
  });

  if (btnOpenInTab) {
    btnOpenInTab.addEventListener('click', () => {
      vscode.postMessage({ cmd: 'openInTab', query: { ...state.query } });
    });
  }

  if (backdrop) {
    backdrop.addEventListener('click', () => vscode.postMessage({ cmd: 'close' }));
  }

  btnToggleView.addEventListener('click', () => {
    state.viewMode = state.viewMode === 'flat' ? 'tree' : 'flat';
    btnToggleView.title = state.viewMode === 'tree' ? 'Switch to Flat View' : 'Switch to Tree View';
    rerenderResults();
    saveState();
  });

  if (btnReplaceAll) {
    btnReplaceAll.addEventListener('click', () => {
      vscode.postMessage({
        cmd: 'replaceAll',
        query: { ...state.query },
        replaceText: replaceInput.value,
      });
    });
  }

  // ── Search ───────────────────────────────────────────────────────────
  function triggerSearch() {
    if (!state.query.text) { return; }
    clearResults('');
    setStatus('Searching…');
    vscode.postMessage({ cmd: 'search', query: { ...state.query } });
    saveState();
  }

  function clearResults(emptyMsg) {
    state.results = [];
    state.totalMatches = 0;
    state.totalFiles = 0;
    resultsList.innerHTML = '';
    if (emptyMsg !== '') {
      emptyState.style.display = 'flex';
      emptyState.querySelector('.empty-text').textContent = emptyMsg || '';
    } else {
      emptyState.style.display = 'none';
    }
    setStatus('');
  }

  function setStatus(text) { statusText.textContent = text; }

  function focusFirstResult() {
    const first = resultsList.querySelector('.match-item');
    if (first) { /** @type {HTMLElement} */ (first).focus(); }
  }

  // ── Results rendering ────────────────────────────────────────────────
  function appendFileResult(file) {
    state.results.push(file);
    state.totalMatches += file.matches.length;
    state.totalFiles++;
    emptyState.style.display = 'none';

    if (state.viewMode === 'flat') {
      renderFileFlat(file, resultsList);
    } else {
      rerenderResults();   // tree is rebuilt in full (simpler, adequate for typical result counts)
    }
    updateStatusLive();
  }

  function renderFileFlat(file, container) {
    const group = document.createElement('div');
    group.className = 'file-group';
    group.dataset.uri = file.uriString;

    const header = document.createElement('div');
    header.className = 'file-header';
    header.innerHTML = `
      <span class="file-icon">📄</span>
      <span class="file-path">${escHtml(file.relativePath)}</span>
      <span class="badge">${file.matches.length}</span>`;
    header.addEventListener('click', () => group.classList.toggle('collapsed'));

    const matchList = document.createElement('div');
    matchList.className = 'match-list';

    for (const m of file.matches) {
      const item = makeMatchItem(file.uriString, m);
      matchList.appendChild(item);
    }

    group.appendChild(header);
    group.appendChild(matchList);
    container.appendChild(group);
  }

  function makeMatchItem(uriString, match) {
    const item = document.createElement('div');
    item.className = 'match-item';
    item.setAttribute('tabindex', '0');

    const lineNum = document.createElement('span');
    lineNum.className = 'line-num';
    lineNum.textContent = String(match.lineNumber + 1);

    const lineText = document.createElement('span');
    lineText.className = 'line-text';
    lineText.innerHTML = highlightMatch(match.lineText, match.matchStart, match.matchEnd);

    item.appendChild(lineNum);
    item.appendChild(lineText);

    item.addEventListener('click', e => openFile(uriString, match.lineNumber, e.ctrlKey || e.metaKey));
    item.addEventListener('keydown', e => {
      if (e.key === 'Enter') { openFile(uriString, match.lineNumber, false); }
      if (e.key === 'Escape') { searchInput.focus(); }
    });

    return item;
  }

  function rerenderResults() {
    resultsList.innerHTML = '';
    if (!state.results.length) {
      emptyState.style.display = 'flex';
      return;
    }
    emptyState.style.display = 'none';

    if (state.viewMode === 'flat') {
      state.results.forEach(f => renderFileFlat(f, resultsList));
    } else {
      renderTree();
    }
  }

  // ── Tree view ────────────────────────────────────────────────────────
  function renderTree() {
    const root = {};
    for (const file of state.results) {
      const parts = file.relativePath.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!node[parts[i]]) { node[parts[i]] = {}; }
        node = node[parts[i]];
      }
      if (!node.__files) { node.__files = []; }
      node.__files.push(file);
    }
    renderTreeNode(root, resultsList);
  }

  function renderTreeNode(node, container) {
    // Files directly in this dir
    if (node.__files) {
      for (const f of node.__files) { renderFileFlat(f, container); }
    }
    // Sub-directories
    for (const [name, child] of Object.entries(node)) {
      if (name === '__files') { continue; }
      const totalMatches = countMatches(child);

      const dirGroup = document.createElement('div');
      dirGroup.className = 'dir-group';

      const header = document.createElement('div');
      header.className = 'dir-header';
      header.innerHTML = `
        <span class="dir-arrow">▼</span>
        <span class="file-icon">📁</span>
        <span class="dir-name">${escHtml(name)}</span>
        <span class="badge">${totalMatches}</span>`;
      header.addEventListener('click', () => {
        dirGroup.classList.toggle('collapsed');
        header.querySelector('.dir-arrow').textContent =
          dirGroup.classList.contains('collapsed') ? '▶' : '▼';
      });

      dirGroup.appendChild(header);
      renderTreeNode(child, dirGroup);
      container.appendChild(dirGroup);
    }
  }

  function countMatches(node) {
    let n = node.__files ? node.__files.reduce((s, f) => s + f.matches.length, 0) : 0;
    for (const [k, v] of Object.entries(node)) {
      if (k !== '__files') { n += countMatches(v); }
    }
    return n;
  }

  // ── Helpers ──────────────────────────────────────────────────────────
  function updateStatusLive() {
    setStatus(`${state.totalMatches} match${state.totalMatches !== 1 ? 'es' : ''} in ${state.totalFiles} file${state.totalFiles !== 1 ? 's' : ''}`);
  }

  function openFile(uriString, lineNumber, inNewColumn) {
    vscode.postMessage({ cmd: 'openFile', uriString, lineNumber, inNewColumn });
  }

  function escHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function highlightMatch(lineText, start, end) {
    const before  = escHtml(lineText.slice(0, start));
    const matched = escHtml(lineText.slice(start, end));
    const after   = escHtml(lineText.slice(end));
    return `${before}<mark>${matched}</mark>${after}`;
  }

  function debounce(fn, delay) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  function saveState() { vscode.setState(state); }

  // ── Message bus (extension → webview) ───────────────────────────────
  window.addEventListener('message', event => {
    const msg = event.data;
    switch (msg.cmd) {
      case 'init': {
        state.scopes = msg.scopes || [];
        renderScopes();
        if (msg.pendingQuery) {
          Object.assign(state.query, msg.pendingQuery);
          searchInput.value = state.query.text || '';
          maskInput.value   = state.query.fileMask || '';
          syncFlags();
          // Restore scope dropdown selection
          for (const opt of scopeSelect.options) {
            opt.selected = opt.value === state.query.scopeId;
          }
          triggerSearch();
        }
        break;
      }

      case 'searchResult':
        appendFileResult(msg.file);
        break;

      case 'searchDone':
        if (state.totalMatches === 0) {
          emptyState.style.display = 'flex';
          emptyState.querySelector('.empty-text').textContent =
            `No results for "${state.query.text}"`;
          setStatus('No results');
        } else {
          setStatus(
            `${state.totalMatches} match${state.totalMatches !== 1 ? 'es' : ''} ` +
            `in ${state.totalFiles} file${state.totalFiles !== 1 ? 's' : ''} ` +
            `(${msg.elapsedMs}ms)`,
          );
        }
        saveState();
        break;

      case 'searchError':
        setStatus(`Error: ${msg.message}`);
        break;
    }
  });

  // ── Boot ─────────────────────────────────────────────────────────────
  initUI();
  vscode.postMessage({ cmd: 'ready' });
})();
