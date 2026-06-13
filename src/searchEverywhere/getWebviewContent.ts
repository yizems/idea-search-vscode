import * as vscode from 'vscode';
import * as crypto from 'crypto';

export function getSearchEverywhereHtml(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
): string {
    const styleUri  = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'searchEverywhere', 'style.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'searchEverywhere', 'main.js'));
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
  <title>Search Everywhere</title>
</head>
<body style="margin:0;padding:0">
  <div class="dialog">

    <!-- Search input -->
    <div class="search-bar">
      <span class="search-icon">⌕</span>
      <input type="text" id="seInput" class="se-input" placeholder="Search everywhere…"
             autocomplete="off" spellcheck="false">
      <span class="shortcut-hint">↑3 navigate · Enter open · Tab switch category</span>
    </div>

    <!-- Tabs: All / Files / Symbols / Text / Actions -->
    <div class="se-tabs" id="seTabs">
      <button class="se-tab active" data-tab="all">All</button>
      <button class="se-tab" data-tab="files">Files</button>
      <button class="se-tab" data-tab="symbols">Symbols</button>
      <button class="se-tab" data-tab="text">Text</button>
      <button class="se-tab" data-tab="actions">Actions</button>
    </div>

    <!-- Body: results + splitter + preview -->
    <div class="se-body">
      <div class="se-results-wrap">
        <div class="se-results" id="seResults">
          <div class="se-empty" id="seEmpty">
            <span class="se-empty-icon">⌕</span>
            <span class="se-empty-text">Type to search everywhere</span>
          </div>
        </div>
      </div>
      <div class="se-splitter" id="seSplitter"></div>
      <div class="se-preview" id="sePreview">
        <div class="se-preview-empty">Select a result to preview</div>
      </div>
    </div>

    <div class="se-footer">
      <span class="se-status" id="seStatus"></span>
      <span class="se-hint">↑↓ navigate · Enter open · Tab switch tab</span>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
