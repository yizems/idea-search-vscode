// @ts-check
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const MODE = window.__IDEA_SEARCH_MODE || 'popup';
  const MAX_HISTORY = 20;
  const MAX_TABS    = 10;

  // ── State ────────────────────────────────────────────────────────────
  const saved = vscode.getState() || {};
  let state = {
    sessions:        saved.sessions        || [],
    activeSessionId: saved.activeSessionId || null,
    viewMode:        saved.viewMode        || 'flat',
    scopes:          saved.scopes          || [],
    history:         saved.history         || [],
    showPreview:     saved.showPreview !== undefined ? saved.showPreview : true,
    splitDir:        saved.splitDir        || null,  // null = auto-detect on first load
  };
  let historyIdx  = -1;
  let historyTemp = '';
  let searchTimer = null;

  // ── Session helpers ──────────────────────────────────────────────────
  function makeSession(id, query) {
    return { id, label:(query&&query.text)||'Search', query:query?Object.assign({},query):defaultQuery(),
      results:[], totalMatches:0, totalFiles:0, status:'', isPinned:false, excludedKeys:[] };
  }
  function defaultQuery() {
    return {text:'',isRegex:false,isCaseSensitive:false,isWholeWord:false,fileMask:'',scopeId:'project'};
  }
  function activeSession() { return state.sessions.find(s=>s.id===state.activeSessionId); }
  function genId() { return 's'+Math.random().toString(36).slice(2,9); }

  // ── DOM refs ─────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const tabBar=         $('tabBar');
  const searchInput=    $('searchInput');
  const replaceInput=   $('replaceInput');
  const maskInput=      $('maskInput');
  const scopeSelect=    $('scopeSelect');
  const resultsList=    $('resultsList');
  const emptyState=     $('emptyState');
  const statusText=     $('statusText');
  const btnCase=        $('btnCase');
  const btnWord=        $('btnWord');
  const btnRegex=       $('btnRegex');
  const toggleReplace=  $('toggleReplace');
  const replaceRow=     $('replaceRow');
  const btnOpenInTab=   $('btnOpenInTab');
  const btnToggleView=  $('btnToggleView');
  const btnExpandAll=   $('btnExpandAll');
  const btnCollapseAll= $('btnCollapseAll');
  const btnReplaceAll=  $('btnReplaceAll');
  const backdrop=       $('backdrop');
  const previewPane=    $('previewPane');
  const previewContent= $('previewContent');
  const previewTitle=   $('previewTitle');
  const btnHistory=     $('btnHistory');
  const historyDropdown=$('historyDropdown');
  const btnPreview=     $('btnPreview');
  const btnClosePreview=$('btnClosePreview');
  const btnManageScopes=$('btnManageScopes');
  const resultsPane=    $('resultsPane');
  const paneSplitter=   $('paneSplitter');
  const resultsArea=    $('resultsArea');
  const btnSplitDir=    $('btnSplitDir');

  // ── Split layout helpers ──────────────────────────────────────────
  // state.splitDir: 'v' (top/bottom) | 'h' (left/right)
  // Decide initial layout by viewport aspect ratio
  if (!state.splitDir) {
    state.splitDir = window.innerWidth >= window.innerHeight * 1.4 ? 'h' : 'v';
  }

  function applySplitDir() {
    if (!resultsArea) return;
    resultsArea.classList.toggle('layout-h', state.splitDir === 'h');
    resultsArea.classList.toggle('layout-v', state.splitDir !== 'h');
    if (btnSplitDir) {
      btnSplitDir.textContent = state.splitDir === 'h' ? '⇕' : '⇔';
      btnSplitDir.title = state.splitDir === 'h' ? 'Switch to top/bottom split' : 'Switch to left/right split';
    }
    // Reset custom sizes when direction changes
    if (resultsPane) { resultsPane.style.flex=''; resultsPane.style.height=''; resultsPane.style.width=''; }
    if (previewPane)  { previewPane.style.height=''; previewPane.style.width=''; }
  }
  applySplitDir();

  // ── Drag: pane splitter (direction-aware) ────────────────────────
  if (paneSplitter) {
    paneSplitter.addEventListener('mousedown', e => {
      e.preventDefault();
      paneSplitter.classList.add('dragging');
      const isH     = state.splitDir === 'h';
      const startPos = isH ? e.clientX : e.clientY;
      const startSize = resultsPane
        ? (isH ? resultsPane.getBoundingClientRect().width : resultsPane.getBoundingClientRect().height)
        : 200;
      const totalSize = resultsArea
        ? (isH ? resultsArea.getBoundingClientRect().width : resultsArea.getBoundingClientRect().height)
        : 600;
      const splitterSize = isH ? paneSplitter.offsetWidth : paneSplitter.offsetHeight;

      function onMove(ev) {
        const delta   = (isH ? ev.clientX : ev.clientY) - startPos;
        const minPane = isH ? 120 : 60;
        const newSize = Math.max(minPane, Math.min(totalSize - minPane - splitterSize, startSize + delta));
        if (resultsPane) {
          resultsPane.style.flex = 'none';
          if (isH) { resultsPane.style.width = newSize + 'px'; resultsPane.style.height = ''; }
          else     { resultsPane.style.height = newSize + 'px'; resultsPane.style.width = ''; }
        }
        if (previewPane) {
          const previewSize = totalSize - newSize - splitterSize;
          if (isH) { previewPane.style.width = previewSize + 'px'; previewPane.style.height = ''; }
          else     { previewPane.style.height = previewSize + 'px'; previewPane.style.width = ''; }
        }
      }
      function onUp() {
        paneSplitter.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
  }

  // ── F3 Tab bar ───────────────────────────────────────────────────────
  function renderTabs() {
    tabBar.innerHTML = '';
    for (const sess of state.sessions) {
      const tab = document.createElement('div');
      tab.className = 'tab'+(sess.id===state.activeSessionId?' active':'');
      tab.dataset.id = sess.id;
      tab.title = sess.label+(sess.query.fileMask?' | '+sess.query.fileMask:'');

      if (sess.isPinned) {
        const pi = document.createElement('span');
        pi.className='tab-pin-icon'; pi.textContent='📌'; pi.title='Unpin';
        pi.addEventListener('click',e=>{e.stopPropagation();togglePin(sess.id);});
        tab.appendChild(pi);
      }
      const lbl = document.createElement('span');
      lbl.className = 'tab-label';
      const t = sess.label||'Search';
      lbl.textContent = t.length>20 ? t.slice(0,20)+'…' : t;
      tab.appendChild(lbl);

      if (sess.totalMatches>0) {
        const b = document.createElement('span');
        b.className='tab-badge';
        b.textContent=sess.totalMatches>999?'999+':String(sess.totalMatches);
        tab.appendChild(b);
      }
      if (!sess.isPinned) {
        const pb = document.createElement('button');
        pb.className='tab-action tab-pin-btn'; pb.textContent='📌'; pb.title='Pin';
        pb.addEventListener('click',e=>{e.stopPropagation();togglePin(sess.id);});
        tab.appendChild(pb);
        const cb = document.createElement('button');
        cb.className='tab-action tab-close-btn'; cb.textContent='×'; cb.title='Close';
        cb.addEventListener('click',e=>{e.stopPropagation();closeTab(sess.id);});
        tab.appendChild(cb);
      }
      tab.addEventListener('click',()=>switchTab(sess.id));
      tabBar.appendChild(tab);
    }
    const nb = document.createElement('button');
    nb.className='new-tab-btn'; nb.textContent='+'; nb.title='New tab';
    nb.addEventListener('click',createNewEmptyTab);
    tabBar.appendChild(nb);
  }

  function switchTab(id) {
    if (state.activeSessionId===id) return;
    state.activeSessionId=id; loadSessionIntoUI(activeSession()); renderTabs(); saveState();
  }
  function closeTab(id) {
    const idx=state.sessions.findIndex(s=>s.id===id);
    if (idx===-1) return;
    state.sessions.splice(idx,1);
    if (state.activeSessionId===id) {
      const next=state.sessions[Math.min(idx,state.sessions.length-1)];
      if (next) { state.activeSessionId=next.id; loadSessionIntoUI(next); }
      else { createNewEmptyTab(); return; }
    }
    renderTabs(); saveState();
  }
  function togglePin(id) {
    const s=state.sessions.find(s=>s.id===id);
    if (s) { s.isPinned=!s.isPinned; renderTabs(); savePinnedSessions(); }
  }
  function createNewEmptyTab() {
    const s=makeSession(genId(),null);
    state.sessions.push(s); state.activeSessionId=s.id;
    renderTabs(); loadSessionIntoUI(s); saveState();
  }
  function savePinnedSessions() {
    const p=state.sessions.filter(s=>s.isPinned).map(s=>({...s,results:s.results.slice(0,500)}));
    vscode.postMessage({cmd:'savePinnedSessions',sessions:p}); saveState();
  }

  // ── UI init ──────────────────────────────────────────────────────────
  function initUI(pendingQuery) {
    if (!state.sessions.length) { state.sessions.push(makeSession(genId(),null)); }
    if (!state.activeSessionId) { state.activeSessionId=state.sessions[0].id; }
    renderTabs();
    if (pendingQuery) {
      const s=makeSession(genId(),pendingQuery); enforcedPush(s);
      state.activeSessionId=s.id; renderTabs(); loadSessionIntoUI(s); triggerSearch();
    } else { loadSessionIntoUI(activeSession()); }
    setTimeout(()=>searchInput.focus(),60);
  }
  function loadSessionIntoUI(sess) {
    if (!sess) return;
    searchInput.value=sess.query.text||''; maskInput.value=sess.query.fileMask||'';
    syncFlags(sess.query);
    for (const o of scopeSelect.options) o.selected=o.value===sess.query.scopeId;
    rerenderResults(sess); setStatus(sess.status); historyIdx=-1; historyTemp='';
  }
  function syncFlags(q) {
    btnCase.classList.toggle('active',q.isCaseSensitive);
    btnWord.classList.toggle('active',q.isWholeWord);
    btnRegex.classList.toggle('active',q.isRegex);
  }
  function renderScopes() {
    const prev=scopeSelect.value; scopeSelect.innerHTML='';
    for (const s of state.scopes) {
      const o=document.createElement('option'); o.value=s.id; o.textContent=s.name;
      scopeSelect.appendChild(o);
    }
    const want=(activeSession()?.query.scopeId)||prev;
    for (const o of scopeSelect.options) o.selected=o.value===want;
  }

  // ── Search ───────────────────────────────────────────────────────────
  function scheduleSearch() {
    clearTimeout(searchTimer);
    if (!searchInput.value.trim()) { clearResultsDisplay('Enter a search query to find in files'); return; }
    searchTimer=setTimeout(triggerSearch,280);
  }
  function getQueryFromUI() {
    const s=activeSession();
    return { text:searchInput.value, isRegex:s?s.query.isRegex:false,
      isCaseSensitive:s?s.query.isCaseSensitive:false, isWholeWord:s?s.query.isWholeWord:false,
      fileMask:maskInput.value, scopeId:scopeSelect.value||'project' };
  }
  function triggerSearch() {
    clearTimeout(searchTimer);
    const q=getQueryFromUI(); if (!q.text.trim()) return;
    let sess=activeSession();
    if (sess && sess.results.length===0 && !sess.isPinned && (!sess.query.text||sess.query.text===q.text)) {
      Object.assign(sess.query,q); sess.label=q.text;
    } else {
      sess=makeSession(genId(),q); enforcedPush(sess); state.activeSessionId=sess.id;
    }
    sess.status='Searching…'; sess.excludedKeys=[]; sess.results=[]; sess.totalMatches=0; sess.totalFiles=0;
    renderTabs(); clearResultsDisplay(''); setStatus('Searching…'); addToHistory(q);
    vscode.postMessage({cmd:'search',query:q,sessionId:sess.id}); saveState();
  }
  function enforcedPush(sess) {
    while (state.sessions.filter(s=>!s.isPinned).length>=MAX_TABS) {
      const o=state.sessions.find(s=>!s.isPinned);
      if (o) state.sessions=state.sessions.filter(s=>s!==o); else break;
    }
    state.sessions.push(sess);
  }
  function clearResultsDisplay(msg) {
    resultsList.innerHTML='';
    if (msg!=null) { emptyState.style.display='flex'; emptyState.querySelector('.empty-text').textContent=msg; }
    else emptyState.style.display='none';
    // keep preview pane visibility as-is (controlled by toggle button)
  }
  function setStatus(t) { statusText.textContent=t||''; }
  function focusFirstResult() { const f=resultsList.querySelector('.match-item'); if(f) f.focus(); }

  // ── F7 History ───────────────────────────────────────────────────────
  function addToHistory(q) {
    if (!q.text) return;
    state.history=state.history.filter(h=>!(h.text===q.text&&h.fileMask===q.fileMask&&h.scopeId===q.scopeId));
    state.history.unshift({text:q.text,fileMask:q.fileMask,scopeId:q.scopeId});
    if (state.history.length>MAX_HISTORY) state.history.length=MAX_HISTORY;
  }
  function navigateHistory(dir) {
    if (!state.history.length) return;
    if (historyIdx===-1) historyTemp=searchInput.value;
    historyIdx = dir==='up' ? Math.min(historyIdx+1,state.history.length-1) : Math.max(historyIdx-1,-1);
    if (historyIdx===-1) { searchInput.value=historyTemp; return; }
    const h=state.history[historyIdx];
    searchInput.value=h.text; maskInput.value=h.fileMask||'';
    for (const o of scopeSelect.options) o.selected=o.value===h.scopeId;
  }
  function openHistoryDropdown() {
    historyDropdown.innerHTML='';
    if (!state.history.length) {
      const e=document.createElement('div'); e.className='history-empty'; e.textContent='No recent searches';
      historyDropdown.appendChild(e);
    } else {
      for (const h of state.history) {
        const item=document.createElement('div'); item.className='history-item';
        const sn=state.scopes.find(s=>s.id===h.scopeId)?.name||h.scopeId;
        item.innerHTML=`<span class="history-text">${escHtml(h.text)}</span>`+
          `<span class="history-meta">${escHtml(sn)}${h.fileMask?' · '+escHtml(h.fileMask):''}</span>`;
        item.addEventListener('click',()=>{
          searchInput.value=h.text; maskInput.value=h.fileMask||'';
          for (const o of scopeSelect.options) o.selected=o.value===h.scopeId;
          historyDropdown.classList.add('hidden'); triggerSearch();
        });
        historyDropdown.appendChild(item);
      }
      const cl=document.createElement('div'); cl.className='history-clear'; cl.textContent='✕ Clear history';
      cl.addEventListener('click',()=>{ state.history=[]; historyDropdown.classList.add('hidden'); saveState(); });
      historyDropdown.appendChild(cl);
    }
    historyDropdown.classList.remove('hidden');
  }

  // ── Results rendering ────────────────────────────────────────────────
  function rerenderResults(sess) {
    sess=sess||activeSession(); resultsList.innerHTML='';
    if (!sess||!sess.results.length) {
      if (sess&&sess.query.text&&sess.status&&!sess.status.startsWith('Search')) {
        emptyState.style.display='flex'; emptyState.querySelector('.empty-text').textContent=sess.status;
      }
      return;
    }
    emptyState.style.display='none';
    if (state.viewMode==='flat') for (const f of sess.results) renderFileGroup(f,resultsList,sess);
    else renderTree(sess);
  }
  function appendFileResultToDOM(file,sess) {
    emptyState.style.display='none';
    if (state.viewMode==='flat') renderFileGroup(file,resultsList,sess); else rerenderResults(sess);
    setStatus(`${sess.totalMatches} match${sess.totalMatches!==1?'es':''} in ${sess.totalFiles} file${sess.totalFiles!==1?'s':''}…`);
  }
  function renderFileGroup(file,container,sess) {
    const group=document.createElement('div'); group.className='file-group'; group.dataset.uri=file.uriString;
    const header=document.createElement('div'); header.className='file-header';
    const arrow=document.createElement('span'); arrow.className='collapse-icon'; arrow.textContent='▼';
    const icon=document.createElement('span'); icon.className='file-icon'; icon.textContent='📄';
    const pe=document.createElement('span'); pe.className='file-path'; pe.textContent=pe.title=file.relativePath;
    const badge=document.createElement('span'); badge.className='badge'; badge.textContent=String(file.matches.length);
    header.append(arrow,icon,pe,badge);
    if (!replaceRow.classList.contains('hidden')) {
      const rb=document.createElement('button'); rb.className='icon-btn file-replace-btn';
      rb.textContent='↺'; rb.title='Replace all in this file';
      rb.addEventListener('click',e=>{e.stopPropagation();doReplaceFile(file,sess);});
      header.appendChild(rb);
    }
    header.addEventListener('click',()=>{ group.classList.toggle('collapsed'); arrow.textContent=group.classList.contains('collapsed')?'▶':'▼'; });
    const ml=document.createElement('div'); ml.className='match-list';
    for (const m of file.matches) ml.appendChild(makeMatchItem(file,m,sess));
    group.append(header,ml); container.appendChild(group);
  }
  function makeMatchItem(file,match,sess) {
    const key=`${file.uriString}:${match.lineNumber}:${match.matchStart}`;
    const isExc=sess.excludedKeys.includes(key);
    const item=document.createElement('div');
    item.className='match-item'+(isExc?' excluded':''); item.setAttribute('tabindex','0'); item.dataset.key=key;
    const ln=document.createElement('span'); ln.className='line-num'; ln.textContent=String(match.lineNumber+1);
    const lt=document.createElement('span'); lt.className='line-text';
    // Trim leading whitespace for display; adjust highlight offsets accordingly
    const rawLine   = match.lineText;
    const trimmed   = rawLine.trimStart();
    const trimOffset = rawLine.length - trimmed.length;
    const dispStart = Math.max(0, match.matchStart - trimOffset);
    const dispEnd   = Math.max(0, match.matchEnd   - trimOffset);
    lt.innerHTML=highlightMatch(trimmed, dispStart, dispEnd);
    const eb=document.createElement('button');
    eb.className='match-btn exclude-btn'+(isExc?' active':'');
    eb.textContent='○'; eb.title=isExc?'Include in replace':'Exclude from replace';
    eb.addEventListener('click',e=>{e.stopPropagation();toggleExclude(key,sess,item,eb);});
    item.append(ln,lt,eb);
    if (!replaceRow.classList.contains('hidden')&&!isExc) {
      const rb=document.createElement('button'); rb.className='match-btn replace-item-btn';
      rb.textContent='↺'; rb.title='Replace this occurrence';
      rb.addEventListener('click',e=>{e.stopPropagation();doReplaceItem(file.uriString,match,sess);});
      item.appendChild(rb);
    }
    item.addEventListener('click',e=>{
      if (e.target===eb||(e.target instanceof HTMLButtonElement)) return;
      // Single click: update preview only
      if (state.showPreview) {
        vscode.postMessage({cmd:'previewFile',uriString:file.uriString,lineNumber:match.lineNumber});
        if (previewTitle) previewTitle.textContent=file.relativePath+':'+(match.lineNumber+1);
      }
    });
    item.addEventListener('dblclick',e=>{
      if (e.target===eb||(e.target instanceof HTMLButtonElement)) return;
      // Double click: open source file
      openFile(file.uriString,match.lineNumber,e.ctrlKey||e.metaKey);
    });
    item.addEventListener('keydown',e=>{
      if (e.key==='Enter') openFile(file.uriString,match.lineNumber,false);
      if (e.key==='Escape') searchInput.focus();
    });
    return item;
  }
  function toggleExclude(key,sess,itemEl,btn) {
    const i=sess.excludedKeys.indexOf(key);
    if (i===-1) { sess.excludedKeys.push(key); itemEl.classList.add('excluded'); btn.classList.add('active'); btn.title='Include in replace'; }
    else { sess.excludedKeys.splice(i,1); itemEl.classList.remove('excluded'); btn.classList.remove('active'); btn.title='Exclude from replace'; }
    saveState();
  }
  function doReplaceFile(file,sess) {
    const pairs=file.matches.filter(m=>!sess.excludedKeys.includes(`${file.uriString}:${m.lineNumber}:${m.matchStart}`)).map(m=>({lineNumber:m.lineNumber,matchStart:m.matchStart,matchEnd:m.matchEnd}));
    if (!pairs.length) return;
    vscode.postMessage({cmd:'replaceFile',uriString:file.uriString,replacePairs:pairs,replaceText:replaceInput.value,sessionId:sess.id});
  }
  function doReplaceItem(uriString,match,sess) {
    vscode.postMessage({cmd:'replaceItem',uriString,match:{lineNumber:match.lineNumber,matchStart:match.matchStart,matchEnd:match.matchEnd},replaceText:replaceInput.value,sessionId:sess.id});
  }

  // ── Tree view ────────────────────────────────────────────────────────
  function renderTree(sess) {
    const root={};
    for (const f of sess.results) {
      const parts=f.relativePath.split('/'); let node=root;
      for (let i=0;i<parts.length-1;i++) { if (!node[parts[i]]) node[parts[i]]={};  node=node[parts[i]]; }
      if (!node.__files) node.__files=[];
      node.__files.push(f);
    }
    renderTreeNode(root,resultsList,sess);
  }
  function renderTreeNode(node,container,sess) {
    if (node.__files) for (const f of node.__files) renderFileGroup(f,container,sess);
    for (const [name,child] of Object.entries(node)) {
      if (name==='__files') continue;
      const cnt=countTreeMatches(child);
      const dg=document.createElement('div'); dg.className='dir-group';
      const dh=document.createElement('div'); dh.className='dir-header';
      dh.innerHTML=`<span class="dir-arrow">▼</span><span class="file-icon">📁</span><span class="dir-name">${escHtml(name)}</span><span class="badge">${cnt}</span>`;
      dh.addEventListener('click',()=>{ dg.classList.toggle('collapsed'); dh.querySelector('.dir-arrow').textContent=dg.classList.contains('collapsed')?'▶':'▼'; });
      dg.appendChild(dh); renderTreeNode(child,dg,sess); container.appendChild(dg);
    }
  }
  function countTreeMatches(node) {
    let n=node.__files?node.__files.reduce((s,f)=>s+f.matches.length,0):0;
    for (const [k,v] of Object.entries(node)) if (k!=='__files') n+=countTreeMatches(v);
    return n;
  }

  // ── F8 Preview ───────────────────────────────────────────────────────
  // Track what's currently shown in preview for dblclick navigation
  let previewCurrentUri = null;

  function renderPreview(lines, startLine, matchLine, uriString) {
    if (!previewPane||!state.showPreview) return;
    if (uriString) previewCurrentUri = uriString;
    previewPane.classList.remove('hidden');
    if (paneSplitter) paneSplitter.classList.remove('hidden');
    previewContent.innerHTML='';
    for (let i=0;i<lines.length;i++) {
      const al=startLine+i;
      const row=document.createElement('div');
      row.className='preview-line'+(al===matchLine?' preview-match-line':'');
      const num=document.createElement('span'); num.className='preview-line-num'; num.textContent=String(al+1);
      const txt=document.createElement('span'); txt.className='preview-line-text';
      const raw=lines[i]; txt.textContent=raw.length>300?raw.slice(0,300)+'…':raw;
      row.append(num,txt);
      // Double-click any preview line → open that line in editor
      row.addEventListener('dblclick', () => {
        if (previewCurrentUri) {
          openFile(previewCurrentUri, al, false);
        }
      });
      row.style.cursor = 'default';
      previewContent.appendChild(row);
    }
    const mr=previewContent.querySelector('.preview-match-line');
    if (mr) mr.scrollIntoView({block:'center',behavior:'instant'});
  }

  // ── Event handlers ───────────────────────────────────────────────────
  searchInput.addEventListener('input',()=>{ historyIdx=-1; historyTemp=''; scheduleSearch(); });
  searchInput.addEventListener('keydown',e=>{
    if (e.key==='Escape') { historyDropdown.classList.add('hidden'); vscode.postMessage({cmd:'close'}); return; }
    if (e.key==='Enter')  { clearTimeout(searchTimer); triggerSearch(); return; }
    if (e.key==='ArrowUp'  &&!e.altKey&&!e.ctrlKey&&!e.metaKey) { e.preventDefault(); navigateHistory('up'); return; }
    if (e.key==='ArrowDown'&&!e.altKey&&!e.ctrlKey&&!e.metaKey) {
      e.preventDefault(); historyIdx>=0 ? navigateHistory('down') : focusFirstResult(); return;
    }
  });
  maskInput.addEventListener('input',debounce(()=>{ const s=activeSession(); if(s) s.query.fileMask=maskInput.value; if(searchInput.value) triggerSearch(); },400));
  scopeSelect.addEventListener('change',()=>{ const s=activeSession(); if(s) s.query.scopeId=scopeSelect.value; if(searchInput.value) triggerSearch(); });
  [btnCase,btnWord,btnRegex].forEach(btn=>btn.addEventListener('click',()=>{
    const s=activeSession(); if(!s) return;
    const f=btn.dataset.flag;
    if(f==='case') s.query.isCaseSensitive=!s.query.isCaseSensitive;
    if(f==='word') s.query.isWholeWord=!s.query.isWholeWord;
    if(f==='regex') s.query.isRegex=!s.query.isRegex;
    syncFlags(s.query); if(searchInput.value) triggerSearch();
  }));
  toggleReplace.addEventListener('click',()=>{
    const h=replaceRow.classList.toggle('hidden'); toggleReplace.textContent=h?'▶':'▼';
    if(!h) replaceInput.focus();
    const s=activeSession(); if(s&&s.results.length) rerenderResults(s);
  });
  if (btnOpenInTab) btnOpenInTab.addEventListener('click',()=>{ const s=activeSession(); if(s) vscode.postMessage({cmd:'openInTab',query:Object.assign({},s.query)}); });
  if (backdrop) backdrop.addEventListener('click',()=>vscode.postMessage({cmd:'close'}));
  if (btnManageScopes) btnManageScopes.addEventListener('click',()=>vscode.postMessage({cmd:'manageScopes'}));
  if (btnReplaceAll) btnReplaceAll.addEventListener('click',()=>{
    const s=activeSession(); if(!s) return;
    vscode.postMessage({cmd:'replaceAll',query:Object.assign({},s.query),replaceText:replaceInput.value,excludedKeys:s.excludedKeys,sessionId:s.id});
  });
  btnToggleView.addEventListener('click',()=>{ state.viewMode=state.viewMode==='flat'?'tree':'flat'; rerenderResults(); saveState(); });
  btnExpandAll.addEventListener('click',()=>{ resultsList.querySelectorAll('.file-group.collapsed,.dir-group.collapsed').forEach(el=>{ el.classList.remove('collapsed'); const a=el.querySelector('.collapse-icon,.dir-arrow'); if(a) a.textContent='▼'; }); });
  btnCollapseAll.addEventListener('click',()=>{ resultsList.querySelectorAll('.file-group:not(.collapsed),.dir-group:not(.collapsed)').forEach(el=>{ el.classList.add('collapsed'); const a=el.querySelector('.collapse-icon,.dir-arrow'); if(a) a.textContent='▶'; }); });
  if (btnHistory) btnHistory.addEventListener('click',e=>{ e.stopPropagation(); historyDropdown.classList.contains('hidden')?openHistoryDropdown():historyDropdown.classList.add('hidden'); });
  if (btnPreview) { btnPreview.addEventListener('click',()=>{ state.showPreview=!state.showPreview; btnPreview.classList.toggle('active',state.showPreview); setPreviewVisible(state.showPreview); saveState(); }); btnPreview.classList.toggle('active',state.showPreview); }
  if (btnClosePreview) btnClosePreview.addEventListener('click',()=>{ state.showPreview=false; if(btnPreview) btnPreview.classList.remove('active'); setPreviewVisible(false); saveState(); });
  if (btnSplitDir) btnSplitDir.addEventListener('click',()=>{
    state.splitDir = state.splitDir === 'h' ? 'v' : 'h';
    applySplitDir();
    saveState();
  });
  document.addEventListener('click',e=>{ if(historyDropdown&&!historyDropdown.contains(e.target)&&e.target!==btnHistory) historyDropdown.classList.add('hidden'); });

  // ── Preview visibility helper ─────────────────────────────────────
  function setPreviewVisible(visible) {
    if (previewPane)   { previewPane.classList.toggle('hidden',  !visible); }
    if (paneSplitter)  { paneSplitter.classList.toggle('hidden', !visible); }
    if (!visible && resultsPane) {
      resultsPane.style.flex=''; resultsPane.style.height=''; resultsPane.style.width='';
    }
  }
  // Apply initial state
  setPreviewVisible(state.showPreview);

  // ── Helpers ──────────────────────────────────────────────────────────
  function openFile(u,l,nc) { vscode.postMessage({cmd:'openFile',uriString:u,lineNumber:l,inNewColumn:!!nc}); }
  function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function highlightMatch(t,s,e) { return escHtml(t.slice(0,s))+'<mark>'+escHtml(t.slice(s,e))+'</mark>'+escHtml(t.slice(e)); }
  function debounce(fn,d) { let t; return function(...a){clearTimeout(t);t=setTimeout(()=>fn.apply(this,a),d);}; }
  function saveState() {
    vscode.setState({ sessions:state.sessions.map(s=>({...s,results:s.isPinned?s.results:s.results.slice(0,300)})),
      activeSessionId:state.activeSessionId, viewMode:state.viewMode, scopes:state.scopes,
      history:state.history, showPreview:state.showPreview, splitDir:state.splitDir });
  }

  // ── Message bus ──────────────────────────────────────────────────────
  window.addEventListener('message',event=>{
    const msg=event.data;
    switch(msg.cmd) {
      case 'init': {
        state.scopes=msg.scopes||[]; renderScopes();
        if (msg.pinnedSessions&&msg.pinnedSessions.length) {
          const ids=new Set(state.sessions.map(s=>s.id));
          for (const ps of msg.pinnedSessions) if(!ids.has(ps.id)) state.sessions.unshift(ps);
        }
        initUI(msg.pendingQuery||null); break;
      }
      case 'scopesUpdated': state.scopes=msg.scopes||[]; renderScopes(); break;
      case 'searchResult': {
        const s=state.sessions.find(s=>s.id===msg.sessionId); if(!s) break;
        s.results.push(msg.file); s.totalMatches+=msg.file.matches.length; s.totalFiles++;
        if (s.id===state.activeSessionId) appendFileResultToDOM(msg.file,s);
        renderTabs(); break;
      }
      case 'searchDone': {
        const s=state.sessions.find(s=>s.id===msg.sessionId); if(!s) break;
        s.status = msg.cancelled ? `Cancelled — ${s.totalMatches} matches in ${s.totalFiles} files`
          : s.totalMatches===0 ? `No results for "${s.query.text}"`
          : `${s.totalMatches} match${s.totalMatches!==1?'es':''} in ${s.totalFiles} file${s.totalFiles!==1?'s':''} (${msg.elapsedMs}ms)`;
        if (s.id===state.activeSessionId) { setStatus(s.status); if(s.totalMatches===0){emptyState.style.display='flex';emptyState.querySelector('.empty-text').textContent=s.status;} }
        renderTabs(); saveState(); break;
      }
      case 'searchError': {
        const s=state.sessions.find(s=>s.id===msg.sessionId);
        if(s){s.status=`Error: ${msg.message}`;if(s.id===state.activeSessionId)setStatus(s.status);renderTabs();} break;
      }
      case 'previewContent': renderPreview(msg.lines,msg.startLine,msg.matchLine,msg.uriString); break;
      case 'replaceFileDone': {
        const s=state.sessions.find(s=>s.id===msg.sessionId); if(!s) break;
        s.results=s.results.filter(r=>r.uriString!==msg.uriString);
        s.totalMatches=s.results.reduce((n,r)=>n+r.matches.length,0); s.totalFiles=s.results.length;
        s.status=`${s.totalMatches} matches in ${s.totalFiles} files`;
        if(s.id===state.activeSessionId){rerenderResults(s);setStatus(s.status);}
        renderTabs(); saveState(); break;
      }
      case 'replaceItemDone': {
        const s=state.sessions.find(s=>s.id===msg.sessionId); if(!s) break;
        for (const f of s.results) {
          if(f.uriString===msg.uriString){f.matches=f.matches.filter(m=>!(m.lineNumber===msg.match.lineNumber&&m.matchStart===msg.match.matchStart));break;}
        }
        s.results=s.results.filter(r=>r.matches.length>0);
        s.totalMatches=s.results.reduce((n,r)=>n+r.matches.length,0); s.totalFiles=s.results.length;
        s.status=`${s.totalMatches} matches in ${s.totalFiles} files`;
        if(s.id===state.activeSessionId){rerenderResults(s);setStatus(s.status);}
        renderTabs(); saveState(); break;
      }
    }
  });

  vscode.postMessage({cmd:'ready'});
})();
