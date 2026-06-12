import * as vscode from 'vscode';
import { ScopeManager } from '../shared/ScopeManager';
import { getWebviewContent } from './getWebviewContent';
import { createFindInFilesHandler } from './messageHandler';

export class FindInFilesPanel implements vscode.WebviewViewProvider {
    public static readonly viewType = 'idea-search.panel';

    private view?: vscode.WebviewView;
    private handler?: ReturnType<typeof createFindInFilesHandler>;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly scopeManager: ScopeManager,
    ) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _ctx: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
        };

        webviewView.webview.html = getWebviewContent(
            webviewView.webview, this.context.extensionUri, 'panel',
        );

        this.handler = createFindInFilesHandler(
            this.context,
            this.scopeManager,
            () => this.view?.webview,
        );

        webviewView.webview.onDidReceiveMessage(msg => {
            if (msg.cmd === 'close') { return; } // no-op in panel mode
            this.handler!.handleMessage(msg);
        });

        webviewView.onDidDispose(() => {
            this.handler?.dispose();
            this.view = undefined;
        });
    }

    refreshScopes(): void {
        this.handler?.refreshScopes();
    }

    dispose(): void {
        this.handler?.dispose();
    }
}
