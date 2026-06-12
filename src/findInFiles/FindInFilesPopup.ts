import * as vscode from 'vscode';
import { SearchQuery, SearchResultFile, BUILTIN_SCOPES } from '../shared/types';
import { search } from './SearchEngine';
import { ScopeManager } from '../shared/ScopeManager';
import { getWebviewContent } from './getWebviewContent';

const PENDING_QUERY_KEY = 'idea-search.pendingQuery';

export class FindInFilesPopup {
    private static panel: vscode.WebviewPanel | undefined;
    private static cts: vscode.CancellationTokenSource | undefined;

    static show(context: vscode.ExtensionContext, scopeManager: ScopeManager): void {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Active, true);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'ideaSearch.popup',
            'Find in Files',
            { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
            },
        );

        panel.webview.html = getWebviewContent(panel.webview, context.extensionUri, 'popup');
        this.panel = panel;

        panel.webview.onDidReceiveMessage(
            msg => this.handleMessage(msg, panel, context, scopeManager),
        );

        panel.onDidDispose(() => {
            this.panel = undefined;
            this.cts?.cancel();
            this.cts?.dispose();
            this.cts = undefined;
        });
    }

    private static async handleMessage(
        msg: { cmd: string; [key: string]: unknown },
        panel: vscode.WebviewPanel,
        context: vscode.ExtensionContext,
        scopeManager: ScopeManager,
    ): Promise<void> {
        switch (msg.cmd) {
            case 'ready': {
                panel.webview.postMessage({
                    cmd: 'init',
                    mode: 'popup',
                    scopes: scopeManager.getAllScopes(),
                });
                break;
            }

            case 'search': {
                this.cts?.cancel();
                this.cts?.dispose();
                this.cts = new vscode.CancellationTokenSource();
                const token = this.cts.token;

                const query = msg.query as SearchQuery;
                const scope = scopeManager.getScope(query.scopeId) ?? BUILTIN_SCOPES[0];

                try {
                    const summary = await search(
                        query,
                        scope,
                        (result: SearchResultFile) => {
                            if (!token.isCancellationRequested) {
                                panel.webview.postMessage({ cmd: 'searchResult', file: result });
                            }
                        },
                        token,
                    );
                    panel.webview.postMessage({ cmd: 'searchDone', ...summary });
                } catch (err) {
                    panel.webview.postMessage({ cmd: 'searchError', message: String(err) });
                }
                break;
            }

            case 'cancelSearch': {
                this.cts?.cancel();
                break;
            }

            case 'openFile': {
                const uri = vscode.Uri.parse(msg.uriString as string);
                const line = msg.lineNumber as number;
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc, {
                    viewColumn: msg.inNewColumn ? vscode.ViewColumn.Beside : vscode.ViewColumn.One,
                    selection: new vscode.Range(line, 0, line, 0),
                    preview: true,
                    preserveFocus: false,
                });
                // Popup stays open so the user can browse more results
                break;
            }

            case 'openInTab': {
                // Store query so the panel can pick it up when it resolves
                await context.workspaceState.update(PENDING_QUERY_KEY, msg.query);
                panel.dispose();
                await vscode.commands.executeCommand('idea-search.panel.focus');
                break;
            }

            case 'close': {
                panel.dispose();
                break;
            }

            case 'replaceAll': {
                await this.doReplaceAll(
                    msg.query as SearchQuery,
                    msg.replaceText as string,
                    scopeManager,
                );
                break;
            }
        }
    }

    private static async doReplaceAll(
        query: SearchQuery,
        replaceText: string,
        scopeManager: ScopeManager,
    ): Promise<void> {
        const answer = await vscode.window.showWarningMessage(
            `Replace all occurrences of "${query.text}" with "${replaceText}"?`,
            { modal: true },
            'Replace All',
        );
        if (answer !== 'Replace All') { return; }

        const edit = new vscode.WorkspaceEdit();
        const scope = scopeManager.getScope(query.scopeId) ?? BUILTIN_SCOPES[0];
        const cts = new vscode.CancellationTokenSource();

        await search(
            query,
            scope,
            result => {
                const uri = vscode.Uri.parse(result.uriString);
                for (const m of result.matches) {
                    edit.replace(
                        uri,
                        new vscode.Range(m.lineNumber, m.matchStart, m.lineNumber, m.matchEnd),
                        replaceText,
                    );
                }
            },
            cts.token,
        );

        await vscode.workspace.applyEdit(edit);
        cts.dispose();
    }

    static dispose(): void {
        this.panel?.dispose();
        this.cts?.cancel();
        this.cts?.dispose();
    }
}

export { PENDING_QUERY_KEY };
