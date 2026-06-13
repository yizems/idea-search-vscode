import * as vscode from 'vscode';
import { getSearchEverywhereHtml } from './getWebviewContent';
import { sendPreview } from '../findInFiles/messageHandler';

export class SearchEverywhereView {
    private static panel?: vscode.WebviewPanel;
    private static cts?: vscode.CancellationTokenSource;

    static show(context: vscode.ExtensionContext): void {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Active, true);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'ideaSearch.searchEverywhere',
            'Search Everywhere',
            { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
            },
        );

        panel.webview.html = getSearchEverywhereHtml(panel.webview, context.extensionUri);
        this.panel = panel;

        panel.webview.onDidReceiveMessage(msg => this.handleMessage(msg, panel, context));

        panel.onDidDispose(() => {
            this.cts?.cancel();
            this.cts?.dispose();
            this.cts   = undefined;
            this.panel = undefined;
        });
    }

    private static async handleMessage(
        msg: { cmd: string; [key: string]: unknown },
        panel: vscode.WebviewPanel,
        context: vscode.ExtensionContext,
    ): Promise<void> {
        switch (msg.cmd) {
            case 'ready': {
                panel.webview.postMessage({ cmd: 'init' });
                break;
            }

            case 'search': {
                this.cts?.cancel();
                this.cts?.dispose();
                this.cts = new vscode.CancellationTokenSource();
                const token = this.cts.token;
                const query = (msg.query as string).trim();
                if (!query) { break; }

                const tab = msg.tab as string || 'all';
                await this.runSearch(query, tab, panel, token);
                break;
            }

            case 'openFile': {
                const uri  = vscode.Uri.parse(msg.uriString as string);
                const line = (msg.lineNumber as number) ?? 0;
                panel.dispose();
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc, {
                    selection: new vscode.Range(line, 0, line, 0),
                    preview:   false,
                });
                break;
            }

            case 'runCommand': {
                panel.dispose();
                await vscode.commands.executeCommand(msg.commandId as string);
                break;
            }

            case 'close': {
                panel.dispose();
                break;
            }

            case 'previewFile': {
                const uri  = vscode.Uri.parse(msg.uriString as string);
                const line = (msg.lineNumber as number) ?? 0;
                await sendPreview(uri, line, msg2 => panel.webview.postMessage(msg2), msg.uriString as string);
                break;
            }
        }
    }

    private static async runSearch(
        query: string,
        tab: string,
        panel: vscode.WebviewPanel,
        token: vscode.CancellationToken,
    ): Promise<void> {
        const send = (msg: unknown) => {
            if (!token.isCancellationRequested) { panel.webview.postMessage(msg); }
        };

        send({ cmd: 'searchStart', tab });

        // ── Files ────────────────────────────────────────────────────
        if (tab === 'all' || tab === 'files') {
            if (!token.isCancellationRequested) {
                const uris = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 200, token);
                const lcQuery = query.toLowerCase();
                const filtered = uris
                    .filter(u => matchFuzzy(u.fsPath.split(/[/\\]/).pop() ?? '', lcQuery))
                    .slice(0, 80);
                const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
                for (const uri of filtered) {
                    if (token.isCancellationRequested) { break; }
                    const rel = uri.fsPath.replace(ws, '').replace(/^[/\\]/, '').replace(/\\/g, '/');
                    send({ cmd: 'result', type: 'file', label: rel.split('/').pop(), detail: rel, uriString: uri.toString(), line: 0 });
                }
                send({ cmd: 'categoryDone', type: 'file' });
            }
        }

        // ── Symbols ──────────────────────────────────────────────────
        if ((tab === 'all' || tab === 'symbols') && !token.isCancellationRequested) {
            try {
                const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
                    'vscode.executeWorkspaceSymbolProvider', query,
                );
                if (symbols && !token.isCancellationRequested) {
                    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
                    for (const s of symbols.slice(0, 80)) {
                        if (token.isCancellationRequested) { break; }
                        const rel = s.location.uri.fsPath.replace(ws, '').replace(/^[/\\]/, '').replace(/\\/g, '/');
                        send({
                            cmd: 'result', type: 'symbol',
                            label: s.name,
                            detail: rel + ':' + (s.location.range.start.line + 1),
                            symbolKind: s.kind,
                            uriString: s.location.uri.toString(),
                            line: s.location.range.start.line,
                        });
                    }
                }
            } catch { /* LSP may not be available */ }
            send({ cmd: 'categoryDone', type: 'symbol' });
        }

        // ── Text (first 40 matches across workspace) ──────────────────
        if ((tab === 'all' || tab === 'text') && !token.isCancellationRequested) {
            const maxTextResults = 40;
            let found = 0;
            try {
                const flags = 'gi';
                const pattern = new RegExp(escapeRe(query), flags);
                const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 500, token);
                const ws    = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
                outer: for (const uri of files) {
                    if (token.isCancellationRequested || found >= maxTextResults) { break; }
                    try {
                        const doc = await vscode.workspace.openTextDocument(uri);
                        for (let i = 0; i < doc.lineCount; i++) {
                            if (token.isCancellationRequested || found >= maxTextResults) { break outer; }
                            const line = doc.lineAt(i).text;
                            pattern.lastIndex = 0;
                            const m = pattern.exec(line);
                            if (m) {
                                const rel = uri.fsPath.replace(ws, '').replace(/^[/\\]/, '').replace(/\\/g, '/');
                                send({
                                    cmd: 'result', type: 'text',
                                    label: line.trim().slice(0, 100),
                                    detail: rel + ':' + (i + 1),
                                    uriString: uri.toString(),
                                    line: i,
                                    matchStart: m.index,
                                    matchEnd: m.index + m[0].length,
                                });
                                found++;
                            }
                        }
                    } catch { /* skip binary / unreadable */ }
                }
            } catch { /* ignore */ }
            send({ cmd: 'categoryDone', type: 'text' });
        }

        // ── Actions / Commands ────────────────────────────────────────
        if ((tab === 'all' || tab === 'actions') && !token.isCancellationRequested) {
            const allCommands = await vscode.commands.getCommands(true);
            const lcQuery = query.toLowerCase();
            const matched = allCommands
                .filter(c => matchFuzzy(c, lcQuery))
                .slice(0, 60);
            for (const c of matched) {
                if (token.isCancellationRequested) { break; }
                send({ cmd: 'result', type: 'action', label: c, detail: c, commandId: c });
            }
            send({ cmd: 'categoryDone', type: 'action' });
        }

        send({ cmd: 'searchDone', tab });
    }

    static dispose(): void {
        this.cts?.cancel();
        this.cts?.dispose();
        this.panel?.dispose();
    }
}

function matchFuzzy(text: string, lcQuery: string): boolean {
    const lcText = text.toLowerCase();
    if (lcText.includes(lcQuery)) { return true; }
    // CamelCase initials: 'UC' matches 'UserController'
    const initials = text.replace(/[a-z0-9]/g, '').toLowerCase();
    if (initials.includes(lcQuery)) { return true; }
    // Subsequence match
    let qi = 0;
    for (let i = 0; i < lcText.length && qi < lcQuery.length; i++) {
        if (lcText[i] === lcQuery[qi]) { qi++; }
    }
    return qi === lcQuery.length;
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
