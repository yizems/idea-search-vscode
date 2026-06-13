export interface SearchQuery {
    text: string;
    isRegex: boolean;
    isCaseSensitive: boolean;
    isWholeWord: boolean;
    fileMask: string;
    scopeId: string;
}

export interface SearchMatch {
    lineNumber: number;   // 0-indexed
    lineText: string;
    matchStart: number;
    matchEnd: number;
}

export interface SearchResultFile {
    uriString: string;
    relativePath: string;
    matches: SearchMatch[];
}

export interface SearchSummary {
    totalMatches: number;
    totalFiles: number;
    elapsedMs: number;
    cancelled?: boolean;
}

export interface Scope {
    id: string;
    name: string;
    includePatterns: string[];
    excludePatterns: string[];
    isBuiltin: boolean;
}

export const BUILTIN_SCOPES: Scope[] = [
    {
        id: 'project',
        name: 'Project',
        includePatterns: ['**/*'],
        excludePatterns: [],
        isBuiltin: true,
    },
    {
        id: 'open-files',
        name: 'Open Files',
        includePatterns: [],
        excludePatterns: [],
        isBuiltin: true,
    },
    {
        id: 'current-file',
        name: 'Current File',
        includePatterns: [],
        excludePatterns: [],
        isBuiltin: true,
    },
    {
        id: 'git-changed',
        name: 'Git Changed Files',
        includePatterns: [],
        excludePatterns: [],
        isBuiltin: true,
    },
];
