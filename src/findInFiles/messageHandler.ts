import * as vscode from 'vscode';
import { SearchQuery, SearchResultFile, BUILTIN_SCOPES } from '../shared/types';
import { search } from './SearchEngine';
import { ScopeManager } from '../shared/ScopeManager';

export interface MessageSender {
    postMessage(msg: unknown): Thenable<boolean>;
}

export const PENDING_QUERY_KEY  = 'idea-search.pendingQuery';
export const PINNED_SESSIONS_KEY = 'idea-search.pinnedSessions';
const PREVIEW_CTX = 12;

/** Read lines around a given line from a document and send previewContent. */
export async function sendPreview(
    uri: vscode.Uri,
    lineNumber: number,
    send: (msg: unknown) => void,
    uriString: string,
    ctx = PREVIEW_CTX,
): Promise<void> {
    try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const startLine = Math.max(0, lineNumber - ctx);
        const endLine   = Math.min(doc.lineCount - 1, lineNumber + ctx);
        const lines: string[] = [];
        for (let i = startLine; i <= endLine; i++) {
            lines.push(doc.lineAt(i).text);
        }
        send({ cmd: 'previewContent', lines, startLine, matchLine: lineNumber, uriString });
    } catch { /* unreadable files — silently ignore */ }
}

export function createFindInFilesHandler(
    context: vscode.ExtensionContext,
    scopeManager: ScopeManager,
    getSender: () => MessageSender | undefined,
) {
    const ctsBySession = new Map<string, vscode.CancellationTokenSource>();

    function send(msg: unknown): void {
        getSender()?.postMessage(msg);
    }

    async function handleMessage(msg: { cmd: string; [key: string]: unknown }): Promise<void> {
        switch (msg.cmd) {

            case 'ready': {
                const scopes = scopeManager.getAllScopes();
                const pendingQuery = context.workspaceState.get<SearchQuery>(PENDING_QUERY_KEY) ?? null;
                const pinnedSessions = context.workspaceState.get<unknown[]>(PINNED_SESSIONS_KEY) ?? [];
                if (pendingQuery) {
                    await context.workspaceState.update(PENDING_QUERY_KEY, undefined);
                }
                send({ cmd: 'init', scopes, pinnedSessions, pendingQuery });
                break;
            }

            case 'search': {
                const sessionId = msg.sessionId as string;
                ctsBySession.get(sessionId)?.cancel();
                ctsBySession.get(sessionId)?.dispose();
                const cts = new vscode.CancellationTokenSource();
                ctsBySession.set(sessionId, cts);
                const token = cts.token;
                const query = msg.query as SearchQuery;
                const scope = scopeManager.getScope(query.scopeId) ?? BUILTIN_SCOPES[0];
                try {
                    const summary = await search(
                        query, scope,
                        (result: SearchResultFile) => {
                            if (!token.isCancellationRequested) {
                                send({ cmd: 'searchResult', file: result, sessionId });
                            }
                        },
                        token,
                    );
                    if (!token.isCancellationRequested) {
                        send({ cmd: 'searchDone', ...summary, sessionId });
                    }
                } catch (err) {
                    send({ cmd: 'searchError', message: String(err), sessionId });
                } finally {
                    // Only remove from map if still ours (guard against race with newer search)
                    if (ctsBySession.get(sessionId) === cts) {
                        ctsBySession.delete(sessionId);
                    }
                    cts.dispose();
                }
                break;
            }

            case 'cancelSearch': {
                const sid = msg.sessionId as string;
                ctsBySession.get(sid)?.cancel();
                ctsBySession.get(sid)?.dispose();
                ctsBySession.delete(sid);
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

            case 'previewFile': {
                const uri = vscode.Uri.parse(msg.uriString as string);
                await sendPreview(uri, msg.lineNumber as number, send, msg.uriString as string);
                break;
            }

            case 'replaceAll': {
                const query       = msg.query as SearchQuery;
                const replaceText = msg.replaceText as string;
                const excludeSet  = new Set((msg.excludedKeys as string[]) ?? []);

                const confirmed = await vscode.window.showWarningMessage(
                    `Replace all occurrences of "${query.text}" with "${replaceText}"?`,
                    { modal: true }, 'Replace All',
                );
                if (confirmed !== 'Replace All') { break; }

                const edit  = new vscode.WorkspaceEdit();
                const scope = scopeManager.getScope(query.scopeId) ?? BUILTIN_SCOPES[0];
                const cts2  = new vscode.CancellationTokenSource();
                await search(query, scope, result => {
                    const uri = vscode.Uri.parse(result.uriString);
                    for (const m of result.matches) {
                        const key = `${result.uriString}:${m.lineNumber}:${m.matchStart}`;
                        if (!excludeSet.has(key)) {
                            edit.replace(uri,
                                new vscode.Range(m.lineNumber, m.matchStart, m.lineNumber, m.matchEnd),
                                replaceText);
                        }
                    }
                }, cts2.token);
                await vscode.workspace.applyEdit(edit);
                cts2.dispose();
                send({ cmd: 'replaceAllDone', sessionId: msg.sessionId });
                break;
            }

            case 'replaceFile': {
                const uriStr      = msg.uriString as string;
                const replacePairs = msg.replacePairs as Array<{ lineNumber: number; matchStart: number; matchEnd: number }>;
                const replaceText = msg.replaceText as string;
                const edit = new vscode.WorkspaceEdit();
                const uri  = vscode.Uri.parse(uriStr);
                for (const p of replacePairs) {
                    edit.replace(uri, new vscode.Range(p.lineNumber, p.matchStart, p.lineNumber, p.matchEnd), replaceText);
                }
                await vscode.workspace.applyEdit(edit);
                send({ cmd: 'replaceFileDone', uriString: uriStr, sessionId: msg.sessionId });
                break;
            }

            case 'replaceItem': {
                const uri  = vscode.Uri.parse(msg.uriString as string);
                const m    = msg.match as { lineNumber: number; matchStart: number; matchEnd: number };
                const edit = new vscode.WorkspaceEdit();
                edit.replace(uri, new vscode.Range(m.lineNumber, m.matchStart, m.lineNumber, m.matchEnd),
                    msg.replaceText as string);
                await vscode.workspace.applyEdit(edit);
                send({ cmd: 'replaceItemDone', uriString: msg.uriString, match: m, sessionId: msg.sessionId });
                break;
            }

            case 'openInTab': {
                await context.workspaceState.update(PENDING_QUERY_KEY, msg.query);
                await vscode.commands.executeCommand('idea-search.panel.focus');
                break;
            }

            case 'savePinnedSessions': {
                await context.workspaceState.update(PINNED_SESSIONS_KEY, msg.sessions);
                break;
            }

            case 'manageScopes': {
                await vscode.commands.executeCommand('idea-search.manageScopes');
                break;
            }
        }
    }

    function refreshScopes(): void {
        send({ cmd: 'scopesUpdated', scopes: scopeManager.getAllScopes() });
    }

    function dispose(): void {
        for (const cts of ctsBySession.values()) {
            cts.cancel();
            cts.dispose();
        }
        ctsBySession.clear();
    }

    return { handleMessage, refreshScopes, dispose };
}
