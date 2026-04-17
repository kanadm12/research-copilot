import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Highlight - Represents a highlighted passage in a document
 */
export interface Highlight {
    id: string;
    documentId: string;
    documentName: string;
    pageNumber: number;
    text: string;
    color: HighlightColor;
    note?: string;
    tags: string[];
    createdAt: string;
    updatedAt: string;
    position: {
        startOffset: number;
        endOffset: number;
    };
}

export type HighlightColor = 
    | 'yellow' 
    | 'green' 
    | 'blue' 
    | 'pink' 
    | 'purple'
    | 'orange';

export interface HighlightGroup {
    name: string;
    color: HighlightColor;
    highlights: Highlight[];
}

export interface HighlightExport {
    highlights: Highlight[];
    exportedAt: string;
    documentName?: string;
}

export class HighlightService {
    private context: vscode.ExtensionContext;
    private highlights: Map<string, Highlight> = new Map();
    private highlightsByDocument: Map<string, Set<string>> = new Map();
    private storagePath: string;
    private decorationTypes: Map<HighlightColor, vscode.TextEditorDecorationType> = new Map();

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.storagePath = path.join(context.globalStorageUri.fsPath, 'highlights.json');
        this.initializeDecorations();
        this.loadHighlights();
    }

    /**
     * Initialize VS Code text decorations for each highlight color
     */
    private initializeDecorations(): void {
        const colors: Record<HighlightColor, string> = {
            yellow: 'rgba(255, 255, 0, 0.3)',
            green: 'rgba(0, 255, 0, 0.3)',
            blue: 'rgba(0, 150, 255, 0.3)',
            pink: 'rgba(255, 105, 180, 0.3)',
            purple: 'rgba(147, 112, 219, 0.3)',
            orange: 'rgba(255, 165, 0, 0.3)'
        };

        for (const [color, rgba] of Object.entries(colors)) {
            this.decorationTypes.set(color as HighlightColor, 
                vscode.window.createTextEditorDecorationType({
                    backgroundColor: rgba,
                    borderRadius: '3px',
                    overviewRulerColor: rgba,
                    overviewRulerLane: vscode.OverviewRulerLane.Right
                })
            );
        }
    }

    /**
     * Load highlights from storage
     */
    private loadHighlights(): void {
        try {
            if (fs.existsSync(this.storagePath)) {
                const data = fs.readFileSync(this.storagePath, 'utf8');
                const parsed = JSON.parse(data);
                
                for (const highlight of parsed.highlights || []) {
                    this.highlights.set(highlight.id, highlight);
                    this.addToDocumentIndex(highlight);
                }
                
                console.log(`Loaded ${this.highlights.size} highlights`);
            }
        } catch (error) {
            console.error('Failed to load highlights:', error);
        }
    }

    /**
     * Save highlights to storage
     */
    private saveHighlights(): void {
        try {
            const dir = path.dirname(this.storagePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            const data = {
                version: '1.0',
                savedAt: new Date().toISOString(),
                highlights: Array.from(this.highlights.values())
            };

            fs.writeFileSync(this.storagePath, JSON.stringify(data, null, 2), 'utf8');
        } catch (error) {
            console.error('Failed to save highlights:', error);
        }
    }

    private addToDocumentIndex(highlight: Highlight): void {
        if (!this.highlightsByDocument.has(highlight.documentId)) {
            this.highlightsByDocument.set(highlight.documentId, new Set());
        }
        this.highlightsByDocument.get(highlight.documentId)!.add(highlight.id);
    }

    /**
     * Create a new highlight
     */
    createHighlight(params: {
        documentId: string;
        documentName: string;
        pageNumber: number;
        text: string;
        startOffset: number;
        endOffset: number;
        color?: HighlightColor;
        note?: string;
        tags?: string[];
    }): Highlight {
        const highlight: Highlight = {
            id: this.generateId(),
            documentId: params.documentId,
            documentName: params.documentName,
            pageNumber: params.pageNumber,
            text: params.text,
            color: params.color || 'yellow',
            note: params.note,
            tags: params.tags || [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            position: {
                startOffset: params.startOffset,
                endOffset: params.endOffset
            }
        };

        this.highlights.set(highlight.id, highlight);
        this.addToDocumentIndex(highlight);
        this.saveHighlights();

        return highlight;
    }

    /**
     * Update an existing highlight
     */
    updateHighlight(
        id: string, 
        updates: Partial<Pick<Highlight, 'color' | 'note' | 'tags'>>
    ): Highlight | null {
        const highlight = this.highlights.get(id);
        if (!highlight) return null;

        if (updates.color !== undefined) highlight.color = updates.color;
        if (updates.note !== undefined) highlight.note = updates.note;
        if (updates.tags !== undefined) highlight.tags = updates.tags;
        highlight.updatedAt = new Date().toISOString();

        this.saveHighlights();
        return highlight;
    }

    /**
     * Delete a highlight
     */
    deleteHighlight(id: string): boolean {
        const highlight = this.highlights.get(id);
        if (!highlight) return false;

        this.highlights.delete(id);
        this.highlightsByDocument.get(highlight.documentId)?.delete(id);
        this.saveHighlights();
        return true;
    }

    /**
     * Get a single highlight
     */
    getHighlight(id: string): Highlight | undefined {
        return this.highlights.get(id);
    }

    /**
     * Get all highlights for a document
     */
    getHighlightsForDocument(documentId: string): Highlight[] {
        const ids = this.highlightsByDocument.get(documentId);
        if (!ids) return [];
        
        return Array.from(ids)
            .map(id => this.highlights.get(id))
            .filter((h): h is Highlight => h !== undefined)
            .sort((a, b) => a.position.startOffset - b.position.startOffset);
    }

    /**
     * Get all highlights
     */
    getAllHighlights(): Highlight[] {
        return Array.from(this.highlights.values());
    }

    /**
     * Get highlights by tag
     */
    getHighlightsByTag(tag: string): Highlight[] {
        return Array.from(this.highlights.values())
            .filter(h => h.tags.includes(tag));
    }

    /**
     * Get highlights by color
     */
    getHighlightsByColor(color: HighlightColor): Highlight[] {
        return Array.from(this.highlights.values())
            .filter(h => h.color === color);
    }

    /**
     * Search highlights by text
     */
    searchHighlights(query: string): Highlight[] {
        const lowerQuery = query.toLowerCase();
        return Array.from(this.highlights.values())
            .filter(h => 
                h.text.toLowerCase().includes(lowerQuery) ||
                h.note?.toLowerCase().includes(lowerQuery) ||
                h.tags.some(t => t.toLowerCase().includes(lowerQuery))
            );
    }

    /**
     * Get all unique tags
     */
    getAllTags(): string[] {
        const tags = new Set<string>();
        for (const highlight of this.highlights.values()) {
            for (const tag of highlight.tags) {
                tags.add(tag);
            }
        }
        return Array.from(tags).sort();
    }

    /**
     * Group highlights by various criteria
     */
    groupHighlights(by: 'document' | 'color' | 'tag' | 'date'): Map<string, Highlight[]> {
        const groups = new Map<string, Highlight[]>();
        
        for (const highlight of this.highlights.values()) {
            let key: string;
            
            switch (by) {
                case 'document':
                    key = highlight.documentName;
                    break;
                case 'color':
                    key = highlight.color;
                    break;
                case 'tag':
                    // Create entry for each tag
                    if (highlight.tags.length === 0) {
                        key = 'untagged';
                        if (!groups.has(key)) groups.set(key, []);
                        groups.get(key)!.push(highlight);
                    } else {
                        for (const tag of highlight.tags) {
                            if (!groups.has(tag)) groups.set(tag, []);
                            groups.get(tag)!.push(highlight);
                        }
                    }
                    continue;
                case 'date':
                    key = highlight.createdAt.split('T')[0]; // Just the date part
                    break;
                default:
                    key = 'other';
            }
            
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key)!.push(highlight);
        }

        return groups;
    }

    /**
     * Apply highlights to a text editor
     */
    applyHighlightsToEditor(editor: vscode.TextEditor, documentId: string): void {
        const highlights = this.getHighlightsForDocument(documentId);
        
        // Group by color
        const byColor = new Map<HighlightColor, vscode.Range[]>();
        
        for (const highlight of highlights) {
            if (!byColor.has(highlight.color)) {
                byColor.set(highlight.color, []);
            }
            
            try {
                const startPos = editor.document.positionAt(highlight.position.startOffset);
                const endPos = editor.document.positionAt(highlight.position.endOffset);
                byColor.get(highlight.color)!.push(new vscode.Range(startPos, endPos));
            } catch (e) {
                // Position might be out of bounds if document changed
                console.warn(`Could not apply highlight ${highlight.id}:`, e);
            }
        }

        // Apply decorations
        for (const [color, ranges] of byColor) {
            const decorationType = this.decorationTypes.get(color);
            if (decorationType) {
                editor.setDecorations(decorationType, ranges);
            }
        }
    }

    /**
     * Clear all decorations from editor
     */
    clearHighlightsFromEditor(editor: vscode.TextEditor): void {
        for (const decorationType of this.decorationTypes.values()) {
            editor.setDecorations(decorationType, []);
        }
    }

    /**
     * Export highlights to various formats
     */
    exportHighlights(format: 'markdown' | 'json' | 'html', documentId?: string): string {
        const highlights = documentId 
            ? this.getHighlightsForDocument(documentId)
            : this.getAllHighlights();

        switch (format) {
            case 'markdown':
                return this.exportToMarkdown(highlights);
            case 'html':
                return this.exportToHtml(highlights);
            case 'json':
            default:
                return JSON.stringify({ highlights, exportedAt: new Date().toISOString() }, null, 2);
        }
    }

    private exportToMarkdown(highlights: Highlight[]): string {
        let md = '# Research Highlights\n\n';
        md += `*Exported on ${new Date().toLocaleDateString()}*\n\n`;
        md += '---\n\n';

        // Group by document
        const byDocument = new Map<string, Highlight[]>();
        for (const h of highlights) {
            if (!byDocument.has(h.documentName)) {
                byDocument.set(h.documentName, []);
            }
            byDocument.get(h.documentName)!.push(h);
        }

        for (const [docName, docHighlights] of byDocument) {
            md += `## 📄 ${docName}\n\n`;
            
            for (const h of docHighlights) {
                const colorEmoji = this.getColorEmoji(h.color);
                md += `### ${colorEmoji} Page ${h.pageNumber}\n\n`;
                md += `> ${h.text}\n\n`;
                
                if (h.note) {
                    md += `**Note:** ${h.note}\n\n`;
                }
                
                if (h.tags.length > 0) {
                    md += `**Tags:** ${h.tags.map(t => `\`${t}\``).join(', ')}\n\n`;
                }
                
                md += '---\n\n';
            }
        }

        return md;
    }

    private exportToHtml(highlights: Highlight[]): string {
        const colorMap: Record<HighlightColor, string> = {
            yellow: '#fff59d',
            green: '#a5d6a7',
            blue: '#90caf9',
            pink: '#f48fb1',
            purple: '#ce93d8',
            orange: '#ffcc80'
        };

        let html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Research Highlights</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
        .highlight { margin: 20px 0; padding: 15px; border-radius: 8px; }
        .quote { font-style: italic; margin-bottom: 10px; }
        .note { color: #666; margin-top: 10px; }
        .tags { margin-top: 10px; }
        .tag { background: #e0e0e0; padding: 2px 8px; border-radius: 12px; margin-right: 5px; font-size: 0.9em; }
        .meta { color: #888; font-size: 0.85em; }
        h1 { border-bottom: 2px solid #333; padding-bottom: 10px; }
        h2 { color: #444; margin-top: 30px; }
    </style>
</head>
<body>
    <h1>📚 Research Highlights</h1>
    <p class="meta">Exported on ${new Date().toLocaleDateString()}</p>
`;

        // Group by document
        const byDocument = new Map<string, Highlight[]>();
        for (const h of highlights) {
            if (!byDocument.has(h.documentName)) {
                byDocument.set(h.documentName, []);
            }
            byDocument.get(h.documentName)!.push(h);
        }

        for (const [docName, docHighlights] of byDocument) {
            html += `<h2>📄 ${this.escapeHtml(docName)}</h2>\n`;
            
            for (const h of docHighlights) {
                html += `<div class="highlight" style="background-color: ${colorMap[h.color]}">
    <div class="meta">Page ${h.pageNumber}</div>
    <div class="quote">"${this.escapeHtml(h.text)}"</div>
    ${h.note ? `<div class="note"><strong>Note:</strong> ${this.escapeHtml(h.note)}</div>` : ''}
    ${h.tags.length > 0 ? `<div class="tags">${h.tags.map(t => `<span class="tag">${this.escapeHtml(t)}</span>`).join('')}</div>` : ''}
</div>\n`;
            }
        }

        html += '</body></html>';
        return html;
    }

    private getColorEmoji(color: HighlightColor): string {
        const emojis: Record<HighlightColor, string> = {
            yellow: '🟡',
            green: '🟢',
            blue: '🔵',
            pink: '🩷',
            purple: '🟣',
            orange: '🟠'
        };
        return emojis[color] || '⚪';
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    private generateId(): string {
        return 'hl_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    }

    /**
     * Get statistics about highlights
     */
    getStatistics(): {
        total: number;
        byDocument: Map<string, number>;
        byColor: Map<HighlightColor, number>;
        byTag: Map<string, number>;
        withNotes: number;
    } {
        const byDocument = new Map<string, number>();
        const byColor = new Map<HighlightColor, number>();
        const byTag = new Map<string, number>();
        let withNotes = 0;

        for (const h of this.highlights.values()) {
            // By document
            byDocument.set(h.documentName, (byDocument.get(h.documentName) || 0) + 1);
            
            // By color
            byColor.set(h.color, (byColor.get(h.color) || 0) + 1);
            
            // By tag
            for (const tag of h.tags) {
                byTag.set(tag, (byTag.get(tag) || 0) + 1);
            }
            
            // With notes
            if (h.note) withNotes++;
        }

        return {
            total: this.highlights.size,
            byDocument,
            byColor,
            byTag,
            withNotes
        };
    }

    /**
     * Dispose resources
     */
    dispose(): void {
        for (const decorationType of this.decorationTypes.values()) {
            decorationType.dispose();
        }
        this.saveHighlights();
    }
}
