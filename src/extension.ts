import * as vscode from 'vscode';
import { FindInFilesView } from './findInFiles/FindInFilesView';
import { FindInFilesPanel } from './findInFiles/FindInFilesPanel';
import { SearchEverywhereView } from './searchEverywhere/SearchEverywhereView';
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
            FindInFilesView.show(context, scopeManager);
        }),
    );

    // Command: Search Everywhere (F1)
    context.subscriptions.push(
        vscode.commands.registerCommand('idea-search.searchEverywhere', () => {
            SearchEverywhereView.show(context);
        }),
    );

    // Command: Manage Scopes (F4)
    context.subscriptions.push(
        vscode.commands.registerCommand('idea-search.manageScopes', async () => {
            await manageScopesUI(scopeManager, panelProvider);
        }),
    );
}

export function deactivate(): void {
    FindInFilesView.dispose();
    SearchEverywhereView.dispose();
}

// ── F4: Scope management via QuickInput/QuickPick ─────────────────────────
async function manageScopesUI(
    scopeManager: ScopeManager,
    panel: FindInFilesPanel,
): Promise<void> {
    const ADD_SCOPE_LABEL = '$(add)  Add new scope';

    const pick = await vscode.window.showQuickPick(
        [
            { label: ADD_SCOPE_LABEL, kind: vscode.QuickPickItemKind.Default },
            { label: '─', kind: vscode.QuickPickItemKind.Separator },
            ...scopeManager.getAllScopes()
                .filter(s => !s.isBuiltin)
                .map(s => ({
                    label: s.name,
                    description: `include: ${s.includePatterns.join(', ')}`,
                    detail: s.excludePatterns.length
                        ? `exclude: ${s.excludePatterns.join(', ')}`
                        : undefined,
                    scopeId: s.id,
                })),
        ],
        {
            title: 'Manage Custom Scopes',
            placeHolder: 'Add a new scope or select one to edit / delete',
        },
    );
    if (!pick) { return; }

    if (pick.label === ADD_SCOPE_LABEL) {
        await addScopeUI(scopeManager, panel);
    } else if ('scopeId' in pick) {
        await editOrDeleteScopeUI(pick.scopeId as string, scopeManager, panel);
    }
}

async function addScopeUI(scopeManager: ScopeManager, panel: FindInFilesPanel): Promise<void> {
    const name = await vscode.window.showInputBox({ prompt: 'Scope name', placeHolder: 'e.g. Backend only' });
    if (!name) { return; }

    const includeRaw = await vscode.window.showInputBox({
        prompt: 'Include patterns (comma-separated globs)',
        placeHolder: 'src/backend/**, *.java',
        value: '**/*',
    });
    if (includeRaw === undefined) { return; }

    const excludeRaw = await vscode.window.showInputBox({
        prompt: 'Exclude patterns (comma-separated globs, optional)',
        placeHolder: '**/node_modules/**, **/dist/**',
    });

    const id = 'custom_' + Date.now().toString(36);
    await scopeManager.addScope({
        id,
        name,
        includePatterns: includeRaw.split(',').map(p => p.trim()).filter(Boolean),
        excludePatterns: (excludeRaw ?? '').split(',').map(p => p.trim()).filter(Boolean),
    });

    notifyPanelScopesChanged(panel);
    vscode.window.showInformationMessage(`Scope "${name}" created.`);
}

async function editOrDeleteScopeUI(
    scopeId: string,
    scopeManager: ScopeManager,
    panel: FindInFilesPanel,
): Promise<void> {
    const scope = scopeManager.getScope(scopeId);
    if (!scope) { return; }

    const action = await vscode.window.showQuickPick(
        ['Edit', 'Delete', 'Cancel'],
        { title: `Scope: ${scope.name}` },
    );
    if (!action || action === 'Cancel') { return; }

    if (action === 'Delete') {
        const confirmed = await vscode.window.showWarningMessage(
            `Delete scope "${scope.name}"?`, { modal: true }, 'Delete',
        );
        if (confirmed !== 'Delete') { return; }
        await scopeManager.removeScope(scopeId);
        notifyPanelScopesChanged(panel);
        vscode.window.showInformationMessage(`Scope "${scope.name}" deleted.`);
        return;
    }

    // Edit
    const name = await vscode.window.showInputBox({ prompt: 'Scope name', value: scope.name });
    if (!name) { return; }
    const includeRaw = await vscode.window.showInputBox({
        prompt: 'Include patterns',
        value: scope.includePatterns.join(', '),
    });
    if (includeRaw === undefined) { return; }
    const excludeRaw = await vscode.window.showInputBox({
        prompt: 'Exclude patterns',
        value: scope.excludePatterns.join(', '),
    });

    await scopeManager.updateScope(scopeId, {
        name,
        includePatterns: includeRaw.split(',').map(p => p.trim()).filter(Boolean),
        excludePatterns: (excludeRaw ?? '').split(',').map(p => p.trim()).filter(Boolean),
    });
    notifyPanelScopesChanged(panel);
    vscode.window.showInformationMessage(`Scope "${name}" updated.`);
}

function notifyPanelScopesChanged(panel: FindInFilesPanel): void {
    panel.refreshScopes();
    FindInFilesView.refreshScopes();
}
