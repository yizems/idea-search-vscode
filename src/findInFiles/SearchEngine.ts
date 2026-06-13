import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { SearchQuery, SearchMatch, SearchResultFile, SearchSummary, Scope } from '../shared/types';

// ── Regex builder ──────────────────────────────────────────────────────────

function buildPattern(query: SearchQuery): RegExp | null {
    if (!query.text) { return null; }
    try {
        const flags = query.isCaseSensitive ? 'g' : 'gi';
        if (query.isRegex) {
            return new RegExp(query.text, flags);
        }
        let escaped = query.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (query.isWholeWord) {
            escaped = `\\b${escaped}\\b`;
        }
        return new RegExp(escaped, flags);
    } catch {
        return null;
    }
}

// ── File mask parser ───────────────────────────────────────────────────────

export function parseFileMask(mask: string): { include: string[]; exclude: string[] } {
    if (!mask.trim()) {
        return { include: ['**/*'], exclude: [] };
    }

    const include: string[] = [];
    const exclude: string[] = [];

    for (const part of mask.split(',').map(p => p.trim()).filter(Boolean)) {
        if (part.startsWith('!')) {
            const pat = part.slice(1);
            exclude.push(pat.includes('/') ? pat : `**/${pat}`);
        } else {
            include.push(part.includes('/') ? part : `**/${part}`);
        }
    }

    return { include: include.length ? include : ['**/*'], exclude };
}

// ── Scope → file list ──────────────────────────────────────────────────────

const DEFAULT_EXCLUDE = [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/out/**',
    '**/build/**',
    '**/.next/**',
    '**/coverage/**',
];

async function getFilesForScope(
    scope: Scope,
    fileMask: string,
    token: vscode.CancellationToken,
): Promise<vscode.Uri[]> {
    const { include, exclude } = parseFileMask(fileMask);
    const allExclude = [...DEFAULT_EXCLUDE, ...scope.excludePatterns, ...exclude];
    const excludeGlob = `{${allExclude.join(',')}}`;

    const config = vscode.workspace.getConfiguration('idea-search');
    const maxFiles: number = config.get('maxFilesToSearch', 5000);

    if (scope.id === 'current-file') {
        const active = vscode.window.activeTextEditor;
        return active ? [active.document.uri] : [];
    }

    if (scope.id === 'open-files') {
        const seen = new Set<string>();
        const uris: vscode.Uri[] = [];
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                const input = tab.input as { uri?: vscode.Uri } | undefined;
                if (input?.uri) {
                    const key = input.uri.toString();
                    if (!seen.has(key)) {
                        seen.add(key);
                        uris.push(input.uri);
                    }
                }
            }
        }
        return uris;
    }

    if (scope.id === 'git-changed') {
        return getGitChangedFiles(token);
    }

    // Project (default)
    const includeGlob = include.length === 1 ? include[0] : `{${include.join(',')}}`;
    return vscode.workspace.findFiles(includeGlob, excludeGlob, maxFiles, token);
}

function getGitChangedFiles(token: vscode.CancellationToken): Promise<vscode.Uri[]> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) { return Promise.resolve([]); }

    return new Promise(resolve => {
        const proc = execFile(
            'git',
            ['status', '--porcelain', '-z'],
            { cwd: workspaceFolder.uri.fsPath, timeout: 8000 },
            (err, stdout) => {
                if (err || !stdout) { resolve([]); return; }
                // --porcelain -z: entries are NUL-separated, each entry is "XY path" or "XY src\0dest" for renames
                const entries = stdout.split('\0').filter(Boolean);
                const paths: string[] = [];
                let i = 0;
                while (i < entries.length) {
                    const entry = entries[i];
                    if (entry.length < 3) { i++; continue; }
                    const xy = entry.slice(0, 2);
                    const path = entry.slice(3);
                    // R/C = rename/copy: next NUL token is the destination path
                    if ((xy[0] === 'R' || xy[0] === 'C') && i + 1 < entries.length) {
                        paths.push(entries[i + 1]);
                        i += 2;
                    } else {
                        if (path) { paths.push(path); }
                        i++;
                    }
                }
                resolve(paths
                    .filter(Boolean)
                    .map(f => vscode.Uri.joinPath(workspaceFolder.uri, f)));
            },
        );
        token.onCancellationRequested(() => proc.kill());
    });
}

// ── Per-file search ────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

async function searchInFile(uri: vscode.Uri, pattern: RegExp): Promise<SearchMatch[]> {
    try {
        const stat = await fs.stat(uri.fsPath);
        if (stat.size > MAX_FILE_SIZE) { return []; }

        const content = await fs.readFile(uri.fsPath, 'utf-8');
        const lines = content.split('\n');
        const matches: SearchMatch[] = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            pattern.lastIndex = 0;

            let match: RegExpExecArray | null;
            while ((match = pattern.exec(line)) !== null) {
                matches.push({
                    lineNumber: i,
                    lineText: line,
                    matchStart: match.index,
                    matchEnd: match.index + match[0].length,
                });
            }
        }
        return matches;
    } catch {
        return [];
    }
}

// ── Public search API ──────────────────────────────────────────────────────

function chunkArray<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) { out.push(arr.slice(i, i + size)); }
    return out;
}

export async function search(
    query: SearchQuery,
    scope: Scope,
    onResult: (result: SearchResultFile) => void,
    token: vscode.CancellationToken,
): Promise<SearchSummary> {
    const startTime = Date.now();
    const pattern = buildPattern(query);
    if (!pattern) {
        return { totalMatches: 0, totalFiles: 0, elapsedMs: 0 };
    }

    const files = await getFilesForScope(scope, query.fileMask, token);
    if (token.isCancellationRequested) {
        return { totalMatches: 0, totalFiles: 0, elapsedMs: Date.now() - startTime, cancelled: true };
    }

    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    let totalMatches = 0;
    let totalFiles = 0;

    for (const batch of chunkArray(files, 20)) {
        if (token.isCancellationRequested) { break; }

        const results = await Promise.all(
            batch.map(async uri => {
                if (token.isCancellationRequested) { return null; }
                // Each file needs its own RegExp instance (due to lastIndex state)
                const localPattern = new RegExp(pattern.source, pattern.flags);
                const matches = await searchInFile(uri, localPattern);
                if (!matches.length) { return null; }
                const relativePath = path.relative(workspacePath, uri.fsPath).replace(/\\/g, '/');
                return { uriString: uri.toString(), relativePath, matches } as SearchResultFile;
            }),
        );

        for (const r of results) {
            if (r) {
                totalMatches += r.matches.length;
                totalFiles++;
                onResult(r);
            }
        }
    }

    return {
        totalMatches,
        totalFiles,
        elapsedMs: Date.now() - startTime,
        cancelled: token.isCancellationRequested,
    };
}
