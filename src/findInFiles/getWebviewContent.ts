import * as vscode from 'vscode';
import * as crypto from 'crypto';

export function getWebviewContent(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    mode: 'popup' | 'panel',
): string {
    const styleUri  = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'findInFiles', 'style.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'findInFiles', 'main.js'));
    const nonce     = crypto.randomBytes(16).toString('hex');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${webview.cspSource} 'unsafe-inline';
             script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>Find in Files</title>
</head>
<body class="mode-${mode}" style="margin:0;padding:0">
  <div class="backdrop" id="backdrop" style="display:none"></div>
  <div class="dialog" id="dialog">

    <!-- ── F3 Tab bar ── -->
    <div class="tab-bar" id="tabBar"></div>

    <!-- ── Toolbar ── -->
    <div class="toolbar">
      <div class="search-row">
        <button class="toggle-replace-btn" id="toggleReplace" title="Toggle Replace">▶</button>
        <div class="search-input-wrap" id="searchWrap">
          <span class="input-icon">⌕</span>
          <input type="text" id="searchInput" class="text-input" placeholder="Search…"
                 autocomplete="off" spellcheck="false">
          <div class="flag-group">
            <button class="flag-btn" id="btnCase"  data-flag="case"  title="Case Sensitive">Aa</button>
            <button class="flag-btn" id="btnWord"  data-flag="word"  title="Whole Word">W</button>
            <button class="flag-btn" id="btnRegex" data-flag="regex" title="Regular Expression">.*</button>
          </div>
          <!-- F7 History -->
          <div class="history-wrap">
            <button class="icon-btn hist-btn" id="btnHistory" title="Search history">🕐</button>
            <div class="history-dropdown hidden" id="historyDropdown"></div>
          </div>
        </div>
      </div>

      <div class="replace-row hidden" id="replaceRow">
        <span class="toggle-replace-btn" style="visibility:hidden">▶</span>
        <div class="search-input-wrap">
          <span class="input-icon">↺</span>
          <input type="text" id="replaceInput" class="text-input" placeholder="Replace…"
                 autocomplete="off" spellcheck="false">
          <button class="action-btn" id="btnReplaceAll">Replace All</button>
        </div>
      </div>

      <div class="options-row">
        <label class="opt-label">Scope</label>
        <select id="scopeSelect" class="opt-select"></select>
        <button class="icon-btn" id="btnManageScopes" title="Manage custom scopes">⚙</button>
        <label class="opt-label">File mask</label>
        <input type="text" id="maskInput" class="mask-input text-input"
               placeholder="*.ts, !**/*.d.ts" autocomplete="off" spellcheck="false"
               list="maskSuggestions">
        <datalist id="maskSuggestions">
          <option value="*.ts,*.tsx">TypeScript</option>
          <option value="*.js,*.mjs,*.cjs">JavaScript</option>
          <option value="*.py">Python</option>
          <option value="*.java">Java</option>
          <option value="*.go">Go</option>
          <option value="*.rs">Rust</option>
          <option value="*.gradle,*.gradle.kts,.gradle*">Gradle</option>
          <option value="*.md,*.mdx">Markdown</option>
          <option value="*.json">JSON</option>
          <option value="*.css,*.scss,*.less">Styles</option>
        </datalist>
      </div>
    </div>

    <!-- ── Results + Preview split area ── -->
    <div class="results-area" id="resultsArea">
      <!-- Results pane -->
      <div class="results-pane" id="resultsPane">
        <div class="empty-state" id="emptyState">
          <span class="empty-icon">⌕</span>
          <span class="empty-text">Enter a search query to find in files</span>
        </div>
        <div class="results-list" id="resultsList"></div>
      </div>

      <!-- Splitter (hidden until preview open) -->
      <div class="pane-splitter hidden" id="paneSplitter"></div>

      <!-- Preview pane -->
      <div class="preview-pane hidden" id="previewPane">
        <div class="preview-header">
          <span class="preview-title" id="previewTitle">Preview</span>
          <button class="icon-btn" id="btnClosePreview" title="Close preview">×</button>
        </div>
        <div class="preview-content" id="previewContent"></div>
      </div>
    </div>

    <!-- ── Status bar ── -->
    <div class="status-bar">
      <span class="status-text" id="statusText"></span>
      <div class="status-actions">
        <button class="icon-btn" id="btnPreview"      title="Toggle preview">👁</button>
        <button class="icon-btn" id="btnSplitDir"     title="Toggle split direction (horizontal ↔ vertical)">⇔</button>
        <button class="icon-btn" id="btnExpandAll"    title="Expand all">⊞</button>
        <button class="icon-btn" id="btnCollapseAll"  title="Collapse all">⊟</button>
        <button class="icon-btn" id="btnToggleView"   title="Toggle Tree / Flat view">🌲</button>
      </div>
    </div>

  </div><!-- /dialog -->

  <script nonce="${nonce}">window.__IDEA_SEARCH_MODE = '${mode}';</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

