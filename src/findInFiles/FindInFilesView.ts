import * as vscode from 'vscode';
import { ScopeManager } from '../shared/ScopeManager';
import { getWebviewContent } from './getWebviewContent';
import { createFindInFilesHandler } from './messageHandler';

export class FindInFilesView {
    private static panel?: vscode.WebviewPanel;
    private static handler?: ReturnType<typeof createFindInFilesHandler>;

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

        const handler = createFindInFilesHandler(
            context,
            scopeManager,
            () => this.panel?.webview,
        );
        this.handler = handler;

        panel.webview.onDidReceiveMessage(msg => {
            if (msg.cmd === 'close') { panel.dispose(); return; }
            handler.handleMessage(msg);
        });

        panel.onDidDispose(() => {
            handler.dispose();
            this.panel   = undefined;
            this.handler = undefined;
        });
    }

    static refreshScopes(): void {
        this.handler?.refreshScopes();
    }

    static dispose(): void {
        this.handler?.dispose();
        this.panel?.dispose();
    }
}
