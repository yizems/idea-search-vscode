import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Scope, BUILTIN_SCOPES } from './types';

const SCOPES_FILENAME = 'idea-search-scopes.json';

export class ScopeManager {
    private customScopes: Scope[] = [];

    constructor(private readonly context: vscode.ExtensionContext) {}

    async load(): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { return; }

        try {
            const filePath = path.join(workspaceFolder.uri.fsPath, '.vscode', SCOPES_FILENAME);
            const content = await fs.readFile(filePath, 'utf-8');
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed)) {
                this.customScopes = parsed;
            }
        } catch {
            this.customScopes = [];
        }
    }

    getAllScopes(): Scope[] {
        return [...BUILTIN_SCOPES, ...this.customScopes];
    }

    getScope(id: string): Scope | undefined {
        return this.getAllScopes().find(s => s.id === id);
    }

    async addScope(scope: Omit<Scope, 'isBuiltin'>): Promise<void> {
        const newScope: Scope = { ...scope, isBuiltin: false };
        this.customScopes.push(newScope);
        await this.save();
    }

    async updateScope(id: string, updates: Partial<Omit<Scope, 'id' | 'isBuiltin'>>): Promise<void> {
        const idx = this.customScopes.findIndex(s => s.id === id);
        if (idx !== -1) {
            this.customScopes[idx] = { ...this.customScopes[idx], ...updates };
            await this.save();
        }
    }

    async removeScope(id: string): Promise<void> {
        this.customScopes = this.customScopes.filter(s => s.id !== id);
        await this.save();
    }

    private async save(): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { return; }

        const dirPath = path.join(workspaceFolder.uri.fsPath, '.vscode');
        const filePath = path.join(dirPath, SCOPES_FILENAME);

        try {
            await fs.mkdir(dirPath, { recursive: true });
            await fs.writeFile(filePath, JSON.stringify(this.customScopes, null, 2), 'utf-8');
        } catch (err) {
            vscode.window.showErrorMessage(`IDEA Search: Failed to save scopes — ${err}`);
        }
    }
}
