import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { SearchQuery, SearchMatch, SearchResultFile, SearchSummary, Scope } from '../shared/types';

// 鈹€鈹€ Regex builder (used for non-project scopes) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

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

// 鈹€鈹€ File mask parser 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

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

// 鈹€鈹€ Shared exclude config 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

const DEFAULT_EXCLUDE = [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/out/**',
    '**/build/**',
    '**/.next/**',
    '**/coverage/**',
    // macOS metadata & package formats
    '**/.DS_Store',
    '**/__MACOSX/**',
    '**/*.xcodeproj/**',
    '**/*.xcworkspace/**',
    '**/*.xcarchive/**',
];

function buildExcludeGlob(scope: Scope, mask: string): string {
    const config     = vscode.workspace.getConfiguration('idea-search');
    const binaryExts: string[] = config.get('excludeBinaryExtensions', []);
    const { exclude } = parseFileMask(mask);
    const all = [
        ...DEFAULT_EXCLUDE,
        ...scope.excludePatterns,
        ...exclude,
        ...binaryExts.map(ext => `**/*.${ext}`),
    ];
    return `{${all.join(',')}}`;
}

// 鈹€鈹€ Special-scope file lists (open-files / git-changed / current-file) 鈹€鈹€鈹€鈹€鈹€

async function getSpecialScopeFiles(
    scope: Scope,
    fileMask: string,
    token: vscode.CancellationToken,
): Promise<vscode.Uri[]> {
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
                    if (!seen.has(key)) { seen.add(key); uris.push(input.uri); }
                }
            }
        }
        return uris;
    }

    if (scope.id === 'git-changed') {
        return getGitChangedFiles(token);
    }

    // Custom scope: use findFiles with include/exclude globs
    const config = vscode.workspace.getConfiguration('idea-search');
    const maxFiles: number = config.get('maxFilesToSearch', 5000);
    const { include } = parseFileMask(fileMask);
    const excludeGlob = buildExcludeGlob(scope, fileMask);
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
                const entries = stdout.split('\0').filter(Boolean);
                const paths: string[] = [];
                let i = 0;
                while (i < entries.length) {
                    const entry = entries[i];
                    if (entry.length < 3) { i++; continue; }
                    const xy = entry.slice(0, 2);
                    const p  = entry.slice(3);
                    if ((xy[0] === 'R' || xy[0] === 'C') && i + 1 < entries.length) {
                        paths.push(entries[i + 1]);
                        i += 2;
                    } else {
                        if (p) { paths.push(p); }
                        i++;
                    }
                }
                resolve(paths.filter(Boolean).map(f => vscode.Uri.joinPath(workspaceFolder.uri, f)));
            },
        );
        token.onCancellationRequested(() => proc.kill());
    });
}

// 鈹€鈹€ Per-file search (used for special scopes) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

async function searchInFile(uri: vscode.Uri, pattern: RegExp): Promise<SearchMatch[]> {
    try {
        const stat = await fs.stat(uri.fsPath);
        if (stat.size > MAX_FILE_SIZE) { return []; }

        const content = await fs.readFile(uri.fsPath, 'utf-8');
        const lines   = content.split('\n');
        const matches: SearchMatch[] = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            pattern.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = pattern.exec(line)) !== null) {
                matches.push({ lineNumber: i, lineText: line, matchStart: m.index, matchEnd: m.index + m[0].length });
            }
        }
        return matches;
    } catch {
        return [];
    }
}

function chunkArray<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) { out.push(arr.slice(i, i + size)); }
    return out;
}

// ── ripgrep-backed search (project scope) ─────────────────────────────────

/** Locate the rg binary bundled with VS Code. */
function findRgBinary(): string {
    // VS Code ships rg inside its own app directory
    const vscodeExe = process.execPath; // path to the Electron executable
    const base = path.dirname(vscodeExe);

    // Typical paths on each OS
    const candidates: string[] = [];
    if (process.platform === 'win32') {
        candidates.push(
            path.join(base, 'resources', 'app', 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg.exe'),
            path.join(base, 'resources', 'app', 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', 'rg.exe'),
        );
    } else if (process.platform === 'darwin') {
        // execPath is …/Electron; VS Code is …/Contents/MacOS/Electron
        const appDir = path.join(base, '..', 'Resources', 'app');
        candidates.push(
            path.join(appDir, 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg'),
            path.join(appDir, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', 'rg'),
        );
    } else {
        candidates.push(
            path.join(base, 'resources', 'app', 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg'),
            path.join(base, 'resources', 'app', 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', 'rg'),
        );
    }

    const { existsSync } = require('fs') as typeof import('fs');
    for (const c of candidates) {
        if (existsSync(c)) { return c; }
    }
    return 'rg'; // fallback: hope it's on PATH
}

async function searchWithRipgrep(
    query: SearchQuery,
    scope: Scope,
    onResult: (result: SearchResultFile) => void,
    token: vscode.CancellationToken,
): Promise<{ totalMatches: number; totalFiles: number }> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) { return { totalMatches: 0, totalFiles: 0 }; }

    const workspacePath = workspaceFolder.uri.fsPath;
    const config        = vscode.workspace.getConfiguration('idea-search');
    const maxFiles      = config.get<number>('maxFilesToSearch', 5000);
    const binaryExts: string[] = config.get('excludeBinaryExtensions', []);
    const { include, exclude } = parseFileMask(query.fileMask);
    const allExclude = [...DEFAULT_EXCLUDE, ...scope.excludePatterns, ...exclude, ...binaryExts.map(e => `**/*.${e}`)];

    // Build rg args
    const args: string[] = [
        '--line-number',
        '--with-filename',
        '--null',              // NUL-separate filename from line
        '--color', 'never',
        '--max-count', '500', // per-file match cap to avoid huge output
    ];

    if (!query.isCaseSensitive) { args.push('--ignore-case'); }
    if (query.isWholeWord)       { args.push('--word-regexp'); }
    if (query.isRegex)           { args.push('--regexp', query.text); }
    else                         { args.push('--fixed-strings', '--regexp', query.text); }

    for (const g of include)     { args.push('--glob', g); }
    for (const g of allExclude)  { args.push('--glob', `!${g}`); }
    args.push('--max-filesize', `${MAX_FILE_SIZE}`);
    args.push(workspacePath);

    const rgPath = findRgBinary();

    return new Promise(resolve => {
        let totalMatches = 0;
        let totalFiles   = 0;
        let fileCount    = 0;

        const fileMap = new Map<string, SearchResultFile>();
        let buf = '';

        const proc = require('child_process').spawn(rgPath, args, {
            cwd: workspacePath,
        }) as import('child_process').ChildProcess;

        token.onCancellationRequested(() => proc.kill());

        proc.stdout?.setEncoding('utf8');
        proc.stdout?.on('data', (chunk: string) => {
            if (token.isCancellationRequested) { return; }
            buf += chunk;
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';

            for (const line of lines) {
                if (!line) { continue; }
                // Format: <file>\0<linenum>:<match-text>
                const nulIdx = line.indexOf('\0');
                if (nulIdx === -1) { continue; }
                const filePart  = line.slice(0, nulIdx);
                const rest      = line.slice(nulIdx + 1);
                const colonIdx  = rest.indexOf(':');
                if (colonIdx === -1) { continue; }
                const lineNum   = parseInt(rest.slice(0, colonIdx), 10) - 1; // 0-indexed
                const lineText  = rest.slice(colonIdx + 1);

                const uriString = vscode.Uri.file(filePart).toString();

                if (!fileMap.has(uriString)) {
                    if (fileCount >= maxFiles) { continue; }
                    const relativePath = path.relative(workspacePath, filePart).replace(/\\/g, '/');
                    const fileResult: SearchResultFile = { uriString, relativePath, matches: [] };
                    fileMap.set(uriString, fileResult);
                    fileCount++;
                    totalFiles++;
                    // Emit file result immediately for streaming
                    onResult(fileResult);
                }

                // Find match positions within the line using original pattern
                const pat = buildPattern(query);
                if (!pat) { continue; }
                pat.lastIndex = 0;
                let m: RegExpExecArray | null;
                while ((m = pat.exec(lineText)) !== null) {
                    fileMap.get(uriString)!.matches.push({
                        lineNumber: lineNum,
                        lineText,
                        matchStart: m.index,
                        matchEnd:   m.index + m[0].length,
                    });
                    totalMatches++;
                }
            }
        });

        proc.on('close', () => resolve({ totalMatches, totalFiles }));
        proc.on('error', () => resolve({ totalMatches, totalFiles }));
    });
}

// 鈹€鈹€ Public search API 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

export async function search(
    query: SearchQuery,
    scope: Scope,
    onResult: (result: SearchResultFile) => void,
    token: vscode.CancellationToken,
): Promise<SearchSummary> {
    const startTime = Date.now();
    if (!query.text) {
        return { totalMatches: 0, totalFiles: 0, elapsedMs: 0 };
    }

    // 鈹€鈹€ Project scope: delegate to ripgrep 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    if (scope.id === 'project') {
        const { totalMatches, totalFiles } = await searchWithRipgrep(query, scope, onResult, token);
        return {
            totalMatches,
            totalFiles,
            elapsedMs: Date.now() - startTime,
            cancelled: token.isCancellationRequested,
        };
    }

    // 鈹€鈹€ Special scopes: build file list then search with Node RegExp 鈹€鈹€鈹€鈹€鈹€鈹€
    const pattern = buildPattern(query);
    if (!pattern) {
        return { totalMatches: 0, totalFiles: 0, elapsedMs: 0 };
    }

    const files = await getSpecialScopeFiles(scope, query.fileMask, token);
    if (token.isCancellationRequested) {
        return { totalMatches: 0, totalFiles: 0, elapsedMs: Date.now() - startTime, cancelled: true };
    }

    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    let totalMatches = 0;
    let totalFiles   = 0;

    for (const batch of chunkArray(files, 20)) {
        if (token.isCancellationRequested) { break; }

        const results = await Promise.all(
            batch.map(async uri => {
                if (token.isCancellationRequested) { return null; }
                const localPattern = new RegExp(pattern.source, pattern.flags);
                const matches = await searchInFile(uri, localPattern);
                if (!matches.length) { return null; }
                const relativePath = path.relative(workspacePath, uri.fsPath).replace(/\\/g, '/');
                return { uriString: uri.toString(), relativePath, matches } as SearchResultFile;
            }),
        );

        for (const r of results) {
            if (r) { totalMatches += r.matches.length; totalFiles++; onResult(r); }
        }
    }

    return {
        totalMatches,
        totalFiles,
        elapsedMs: Date.now() - startTime,
        cancelled: token.isCancellationRequested,
    };
}

