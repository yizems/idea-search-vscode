import * as vscode from 'vscode';
import * as crypto from 'crypto';

export function getWebviewContent(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    mode: 'popup' | 'panel',
): string {
    const styleUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'media', 'findInFiles', 'style.css'),
    );
    const scriptUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'media', 'findInFiles', 'main.js'),
    );
    const nonce = crypto.randomBytes(16).toString('hex');

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
<body class="mode-${mode}">
  <div class="backdrop" id="backdrop"></div>
  <div class="dialog" id="dialog">

    <!-- ── Toolbar ── -->
    <div class="toolbar">
      <div class="search-row">
        <button class="toggle-replace-btn" id="toggleReplace" title="Toggle Replace (Ctrl+H)">▶</button>
        <div class="search-input-wrap" id="searchWrap">
          <span class="input-icon">⌕</span>
          <input type="text" id="searchInput" class="text-input" placeholder="Search…"
                 autocomplete="off" spellcheck="false">
          <div class="flag-group">
            <button class="flag-btn" id="btnCase"  data-flag="case"  title="Case Sensitive (Alt+C)">Aa</button>
            <button class="flag-btn" id="btnWord"  data-flag="word"  title="Whole Word (Alt+W)">W</button>
            <button class="flag-btn" id="btnRegex" data-flag="regex" title="Regular Expression (Alt+R)">.*</button>
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

    <!-- ── Results ── -->
    <div class="results-area" id="resultsArea">
      <div class="empty-state" id="emptyState">
        <span class="empty-icon">⌕</span>
        <span class="empty-text">Enter a search query to find in files</span>
      </div>
      <div class="results-list" id="resultsList"></div>
    </div>

    <!-- ── Status bar ── -->
    <div class="status-bar">
      <span class="status-text" id="statusText"></span>
      <div class="status-actions">
        <button class="icon-btn" id="btnToggleView" title="Toggle Tree / Flat View">⊞</button>
        ${mode === 'popup' ? '<button class="open-in-tab-btn" id="btnOpenInTab">Open in Tab</button>' : ''}
      </div>
    </div>

  </div><!-- /dialog -->

  <script nonce="${nonce}">window.__IDEA_SEARCH_MODE = '${mode}';</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
