import * as vscode from 'vscode';
import { SearchQuery, SearchResultFile, BUILTIN_SCOPES } from '../shared/types';
import { search } from './SearchEngine';
import { ScopeManager } from '../shared/ScopeManager';
import { getWebviewContent } from './getWebviewContent';
import { PENDING_QUERY_KEY } from './FindInFilesPopup';

export class FindInFilesPanel implements vscode.WebviewViewProvider {
    public static readonly viewType = 'idea-search.panel';

    private view?: vscode.WebviewView;
    private cts?: vscode.CancellationTokenSource;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly scopeManager: ScopeManager,
    ) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _resolveContext: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
        };

        webviewView.webview.html = getWebviewContent(
            webviewView.webview,
            this.context.extensionUri,
            'panel',
        );

        webviewView.webview.onDidReceiveMessage(msg => this.handleMessage(msg));

        webviewView.onDidDispose(() => {
            this.view = undefined;
            this.cts?.cancel();
            this.cts?.dispose();
        });
    }

    private async handleMessage(msg: { cmd: string; [key: string]: unknown }): Promise<void> {
        if (!this.view) { return; }

        switch (msg.cmd) {
            case 'ready': {
                const scopes = this.scopeManager.getAllScopes();
                // Check if popup passed a pending query via "Open in Tab"
                const pendingQuery = this.context.workspaceState.get<SearchQuery>(PENDING_QUERY_KEY);
                if (pendingQuery) {
                    await this.context.workspaceState.update(PENDING_QUERY_KEY, undefined);
                    this.view.webview.postMessage({ cmd: 'init', mode: 'panel', scopes, pendingQuery });
                } else {
                    this.view.webview.postMessage({ cmd: 'init', mode: 'panel', scopes });
                }
                break;
            }

            case 'search': {
                this.cts?.cancel();
                this.cts?.dispose();
                this.cts = new vscode.CancellationTokenSource();
                const token = this.cts.token;

                const query = msg.query as SearchQuery;
                const scope = this.scopeManager.getScope(query.scopeId) ?? BUILTIN_SCOPES[0];

                try {
                    const summary = await search(
                        query,
                        scope,
                        (result: SearchResultFile) => {
                            if (!token.isCancellationRequested) {
                                this.view?.webview.postMessage({ cmd: 'searchResult', file: result });
                            }
                        },
                        token,
                    );
                    this.view.webview.postMessage({ cmd: 'searchDone', ...summary });
                } catch (err) {
                    this.view.webview.postMessage({ cmd: 'searchError', message: String(err) });
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
                    viewColumn: msg.inNewColumn ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
                    selection: new vscode.Range(line, 0, line, 0),
                    preview: true,
                    preserveFocus: true,
                });
                break;
            }

            case 'replaceAll': {
                await this.doReplaceAll(msg.query as SearchQuery, msg.replaceText as string);
                break;
            }
        }
    }

    private async doReplaceAll(query: SearchQuery, replaceText: string): Promise<void> {
        const answer = await vscode.window.showWarningMessage(
            `Replace all occurrences of "${query.text}" with "${replaceText}"?`,
            { modal: true },
            'Replace All',
        );
        if (answer !== 'Replace All') { return; }

        const edit = new vscode.WorkspaceEdit();
        const scope = this.scopeManager.getScope(query.scopeId) ?? BUILTIN_SCOPES[0];
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

    dispose(): void {
        this.cts?.cancel();
        this.cts?.dispose();
    }
}
