import * as vscode from 'vscode';
import { FindInFilesPopup } from './findInFiles/FindInFilesPopup';
import { FindInFilesPanel } from './findInFiles/FindInFilesPanel';
import { ScopeManager } from './shared/ScopeManager';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const scopeManager = new ScopeManager(context);
    await scopeManager.load();

    // Register persistent bottom-panel view
    const panelProvider = new FindInFilesPanel(context, scopeManager);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            FindInFilesPanel.viewType,
            panelProvider,
            { webviewOptions: { retainContextWhenHidden: true } },
        ),
    );

    // Command: Find in Files (popup)
    context.subscriptions.push(
        vscode.commands.registerCommand('idea-search.findInFiles', () => {
            FindInFilesPopup.show(context, scopeManager);
        }),
    );

    // Command: Search Everywhere (placeholder — Sprint 2)
    context.subscriptions.push(
        vscode.commands.registerCommand('idea-search.searchEverywhere', () => {
            vscode.window.showInformationMessage('IDEA Search: Search Everywhere — coming in Sprint 2!');
        }),
    );
}

export function deactivate(): void {
    FindInFilesPopup.dispose();
}
