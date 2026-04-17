import * as vscode from 'vscode';
import * as fs from 'fs';
import { DocumentStore } from '../services/documentStore';
import { SearchService } from '../services/searchService';
import { CitationExtractor } from '../services/citationExtractor';
import { HighlightService } from '../services/highlightService';

export class ResearchToolProvider {
    private documentStore: DocumentStore;
    private searchService: SearchService;
    private citationExtractor: CitationExtractor | null;
    private highlightService: HighlightService | null;

    constructor(
        documentStore: DocumentStore, 
        searchService: SearchService,
        citationExtractor?: CitationExtractor,
        highlightService?: HighlightService
    ) {
        this.documentStore = documentStore;
        this.searchService = searchService;
        this.citationExtractor = citationExtractor || null;
        this.highlightService = highlightService || null;
    }

    searchDocumentsTool(): vscode.LanguageModelTool<{
        query: string;
        maxResults?: number;
        documentFilter?: string;
    }> {
        return {
            invoke: async (options, token) => {
                const { query, maxResults = 10, documentFilter } = options.input;
                
                const results = await this.searchService.search(query, maxResults, documentFilter);
                
                if (results.length === 0) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart('No results found for the query.')
                    ]);
                }

                const output = results.map(r => ({
                    document: r.documentName,
                    page: r.pageNumber,
                    relevance: `${(r.score * 100).toFixed(1)}%`,
                    excerpt: r.excerpt
                }));

                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(JSON.stringify(output, null, 2))
                ]);
            }
        };
    }

    getDocumentContentTool(): vscode.LanguageModelTool<{
        documentPath: string;
        pageRange?: string;
    }> {
        return {
            invoke: async (options, token) => {
                const { documentPath, pageRange } = options.input;
                
                // Find document by path or name
                let doc = this.documentStore.findDocumentByPath(documentPath);
                if (!doc) {
                    doc = this.documentStore.findDocumentByName(documentPath);
                }

                if (!doc) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(`Document not found: ${documentPath}`)
                    ]);
                }

                const content = this.documentStore.getDocumentContent(doc.id, pageRange);
                
                // Truncate if too long
                const maxLength = 50000;
                const truncated = content.length > maxLength 
                    ? content.substring(0, maxLength) + '\n\n[Content truncated...]'
                    : content;

                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(truncated)
                ]);
            }
        };
    }

    listDocumentsTool(): vscode.LanguageModelTool<{
        includeMetadata?: boolean;
    }> {
        return {
            invoke: async (options, token) => {
                const { includeMetadata = false } = options.input;
                
                const documents = this.documentStore.getAllDocuments();
                
                if (documents.length === 0) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart('No documents have been indexed yet.')
                    ]);
                }

                const output = documents.map(doc => {
                    const basic = {
                        name: doc.name,
                        path: doc.path
                    };

                    if (includeMetadata) {
                        return {
                            ...basic,
                            pages: doc.pageCount,
                            indexedAt: doc.indexedAt,
                            chunks: doc.chunks.length,
                            images: doc.images.length,
                            summary: doc.summary.substring(0, 200) + '...'
                        };
                    }

                    return basic;
                });

                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(JSON.stringify(output, null, 2))
                ]);
            }
        };
    }

    getDocumentImagesTool(): vscode.LanguageModelTool<{
        documentPath: string;
        pageNumber?: number;
    }> {
        return {
            invoke: async (options, token) => {
                const { documentPath, pageNumber } = options.input;
                
                // Find document
                let doc = this.documentStore.findDocumentByPath(documentPath);
                if (!doc) {
                    doc = this.documentStore.findDocumentByName(documentPath);
                }

                if (!doc) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(`Document not found: ${documentPath}`)
                    ]);
                }

                const images = this.documentStore.getDocumentImages(doc.id, pageNumber);

                if (images.length === 0) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart('No images found in this document.')
                    ]);
                }

                // Return image information with optional OCR text
                const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelDataPart)[] = [];
                
                parts.push(new vscode.LanguageModelTextPart(
                    `Found ${images.length} images in ${doc.name}:\n\n`
                ));

                for (const img of images) {
                    // Add image metadata
                    parts.push(new vscode.LanguageModelTextPart(
                        `## Image from Page ${img.pageNumber}\n` +
                        `- Size: ${img.width}x${img.height}\n` +
                        `- Path: ${img.path}\n` +
                        (img.description ? `- Description: ${img.description}\n` : '') +
                        (img.ocrText ? `- OCR Text: ${img.ocrText.substring(0, 500)}${img.ocrText.length > 500 ? '...' : ''}\n` : '') +
                        '\n'
                    ));

                    // Try to include actual image data for vision models
                    if (fs.existsSync(img.path)) {
                        try {
                            const imageBuffer = fs.readFileSync(img.path);
                            parts.push(vscode.LanguageModelDataPart.image(
                                new Uint8Array(imageBuffer),
                                'image/png'
                            ));
                        } catch (e) {
                            // Image file read failed, continue without it
                        }
                    }
                }

                return new vscode.LanguageModelToolResult(parts);
            }
        };
    }

    summarizeDocumentTool(): vscode.LanguageModelTool<{
        documentPath: string;
        section?: string;
    }> {
        return {
            invoke: async (options, token) => {
                const { documentPath, section } = options.input;
                
                // Find document
                let doc = this.documentStore.findDocumentByPath(documentPath);
                if (!doc) {
                    doc = this.documentStore.findDocumentByName(documentPath);
                }

                if (!doc) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(`Document not found: ${documentPath}`)
                    ]);
                }

                // If section specified, try to find relevant chunks
                if (section) {
                    const results = await this.searchService.search(
                        `${section} ${doc.name}`,
                        3,
                        doc.name
                    );

                    if (results.length > 0) {
                        const sectionContent = results
                            .map(r => r.text)
                            .join('\n\n');

                        return new vscode.LanguageModelToolResult([
                            new vscode.LanguageModelTextPart(
                                `## ${section} - ${doc.name}\n\n${sectionContent}`
                            )
                        ]);
                    }
                }

                // Return stored summary
                const output = {
                    document: doc.name,
                    pages: doc.pageCount,
                    summary: doc.summary,
                    indexedAt: doc.indexedAt
                };

                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(JSON.stringify(output, null, 2))
                ]);
            }
        };
    }

    /**
     * Semantic search tool using embeddings
     */
    semanticSearchTool(): vscode.LanguageModelTool<{
        query: string;
        maxResults?: number;
        documentFilter?: string;
    }> {
        return {
            invoke: async (options, token) => {
                const { query, maxResults = 10, documentFilter } = options.input;
                
                // Use hybrid search for best results
                const results = await this.searchService.hybridSearch(
                    query, 
                    maxResults, 
                    documentFilter
                );
                
                if (results.length === 0) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart('No results found for the semantic query.')
                    ]);
                }

                const output = results.map(r => ({
                    document: r.documentName,
                    page: r.pageNumber,
                    combinedRelevance: `${(r.combinedScore * 100).toFixed(1)}%`,
                    keywordScore: `${(r.keywordScore * 100).toFixed(1)}%`,
                    semanticScore: `${(r.semanticScore * 100).toFixed(1)}%`,
                    excerpt: r.excerpt
                }));

                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Semantic search results (using AI embeddings):\n\n${JSON.stringify(output, null, 2)}`
                    )
                ]);
            }
        };
    }

    /**
     * Get citations from a document
     */
    getCitationsTool(): vscode.LanguageModelTool<{
        documentPath: string;
    }> {
        return {
            invoke: async (options, token) => {
                if (!this.citationExtractor) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart('Citation extraction not available.')
                    ]);
                }

                const { documentPath } = options.input;
                
                // Find document
                let doc = this.documentStore.findDocumentByPath(documentPath);
                if (!doc) {
                    doc = this.documentStore.findDocumentByName(documentPath);
                }

                if (!doc) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(`Document not found: ${documentPath}`)
                    ]);
                }

                const content = this.documentStore.getDocumentContent(doc.id);
                const result = this.citationExtractor.extractCitations(content);

                const output = {
                    document: doc.name,
                    citationStyle: result.citationStyle,
                    totalInTextCitations: result.statistics.totalCitations,
                    uniqueReferences: result.statistics.uniqueReferences,
                    inTextCitations: result.inTextCitations.slice(0, 20).map(c => 
                        this.citationExtractor!.formatCitation(c)
                    ),
                    references: result.references.slice(0, 20).map(r => 
                        this.citationExtractor!.formatCitation(r)
                    ),
                    topCitedAuthors: Array.from(result.statistics.citationsByAuthor.entries())
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 10)
                        .map(([author, count]) => ({ author, count }))
                };

                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(JSON.stringify(output, null, 2))
                ]);
            }
        };
    }

    /**
     * Get user highlights from documents
     */
    getHighlightsTool(): vscode.LanguageModelTool<{
        documentPath?: string;
        tag?: string;
        color?: string;
    }> {
        return {
            invoke: async (options, token) => {
                if (!this.highlightService) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart('Highlight service not available.')
                    ]);
                }

                const { documentPath, tag, color } = options.input;
                
                let highlights;

                if (documentPath) {
                    // Find document and get its highlights
                    let doc = this.documentStore.findDocumentByPath(documentPath);
                    if (!doc) {
                        doc = this.documentStore.findDocumentByName(documentPath);
                    }
                    if (doc) {
                        highlights = this.highlightService.getHighlightsForDocument(doc.id);
                    } else {
                        return new vscode.LanguageModelToolResult([
                            new vscode.LanguageModelTextPart(`Document not found: ${documentPath}`)
                        ]);
                    }
                } else if (tag) {
                    highlights = this.highlightService.getHighlightsByTag(tag);
                } else if (color) {
                    highlights = this.highlightService.getHighlightsByColor(color as any);
                } else {
                    highlights = this.highlightService.getAllHighlights();
                }

                if (!highlights || highlights.length === 0) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart('No highlights found.')
                    ]);
                }

                const output = {
                    count: highlights.length,
                    highlights: highlights.slice(0, 20).map(h => ({
                        document: h.documentName,
                        page: h.pageNumber,
                        color: h.color,
                        text: h.text.substring(0, 200) + (h.text.length > 200 ? '...' : ''),
                        note: h.note,
                        tags: h.tags
                    }))
                };

                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(JSON.stringify(output, null, 2))
                ]);
            }
        };
    }
}
