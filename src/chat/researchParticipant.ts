import * as vscode from 'vscode';
import { DocumentStore, ChunkPosition } from '../services/documentStore';
import { SearchService } from '../services/searchService';
import { CitationExtractor } from '../services/citationExtractor';
import { HighlightService } from '../services/highlightService';
import { CitedAnswerGenerator, CitedAnswer, InlineCitation } from '../services/citedAnswerGenerator';
import { PdfViewerService, CitationLink } from '../services/pdfViewerService';
import { PdfPositionService } from '../services/pdfPositionService';

export class ResearchChatParticipant {
    private documentStore: DocumentStore;
    private searchService: SearchService;
    private citationExtractor: CitationExtractor | null;
    private highlightService: HighlightService | null;
    private citedAnswerGenerator: CitedAnswerGenerator | null = null;
    private pdfViewerService: PdfViewerService | null = null;

    constructor(
        documentStore: DocumentStore, 
        searchService: SearchService,
        citationExtractor?: CitationExtractor,
        highlightService?: HighlightService,
        citedAnswerGenerator?: CitedAnswerGenerator,
        pdfViewerService?: PdfViewerService
    ) {
        this.documentStore = documentStore;
        this.searchService = searchService;
        this.citationExtractor = citationExtractor || null;
        this.highlightService = highlightService || null;
        this.citedAnswerGenerator = citedAnswerGenerator || null;
        this.pdfViewerService = pdfViewerService || null;
    }

    async handleRequest(
        request: vscode.ChatRequest,
        context: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> {
        const query = request.prompt;

        // Extract attached file references from the chat
        const attachedFiles = this.extractAttachedFiles(request);
        console.log('Research Copilot: Attached files:', attachedFiles);
        
        // Check if we have any indexed documents
        const docCount = this.documentStore.getDocumentCount();
        
        // If files are attached, try to find matching indexed documents
        let matchedDocs: { name: string; id: string; path: string }[] = [];
        if (attachedFiles.length > 0) {
            matchedDocs = this.findMatchingDocuments(attachedFiles);
            console.log('Research Copilot: Matched docs:', matchedDocs);
        }

        // Handle case where no documents are indexed
        if (docCount === 0) {
            if (attachedFiles.length > 0) {
                // User attached a file but nothing is indexed
                stream.markdown('📚 **The attached file needs to be indexed first.**\n\n');
                stream.markdown('Run **Research Copilot: Index All PDFs in Workspace** from the command palette, then try again.\n');
            } else {
                stream.markdown('📚 **No research documents indexed yet.**\n\n');
                stream.markdown('To get started:\n');
                stream.markdown('1. Add PDF files to your workspace\n');
                stream.markdown('2. Run **Research Copilot: Index All PDFs in Workspace** from the command palette\n');
                stream.markdown('3. Come back and ask me questions about your documents!\n');
            }
            return { metadata: { command: 'noDocuments' } };
        }

        // If files are attached, show which ones we're focusing on
        if (attachedFiles.length > 0) {
            if (matchedDocs.length > 0) {
                stream.markdown(`🎯 **Focusing on:** ${matchedDocs.map(d => d.name).join(', ')}\n\n`);
            } else {
                // Try to help the user by showing what we have indexed
                const allDocs = this.documentStore.getAllDocuments();
                const attachedNames = attachedFiles.map(f => f.split(/[/\\]/).pop()).join(', ');
                stream.markdown(`⚠️ **Could not find "${attachedNames}" in indexed documents.**\n\n`);
                stream.markdown(`Searching all ${allDocs.length} indexed documents instead.\n\n`);
            }
        }

        // Handle specific commands
        if (query.toLowerCase().startsWith('/list')) {
            return this.handleListCommand(stream);
        }

        if (query.toLowerCase().startsWith('/stats')) {
            return this.handleStatsCommand(stream);
        }

        if (query.toLowerCase().startsWith('/summarize')) {
            const docName = query.substring('/summarize'.length).trim();
            return this.handleSummarizeCommand(docName || this.getFirstAttachedDocName(attachedFiles), stream);
        }

        if (query.toLowerCase().startsWith('/citations')) {
            const docName = query.substring('/citations'.length).trim();
            return this.handleCitationsCommand(docName || this.getFirstAttachedDocName(attachedFiles), stream);
        }

        if (query.toLowerCase().startsWith('/highlights')) {
            return this.handleHighlightsCommand(stream);
        }

        if (query.toLowerCase().startsWith('/semantic')) {
            const searchQuery = query.substring('/semantic'.length).trim();
            return this.handleSemanticSearchQuery(searchQuery, stream, token, attachedFiles);
        }

        // New: /cited command for answers with clickable citations
        if (query.toLowerCase().startsWith('/cited')) {
            const searchQuery = query.substring('/cited'.length).trim();
            return this.handleCitedQuery(searchQuery || query, stream, token, attachedFiles);
        }

        // Default: search and answer (uses hybrid search) - pass attached files for filtering
        return this.handleSearchQuery(query, stream, token, attachedFiles);
    }

    /**
     * Extract file paths from chat request references
     */
    private extractAttachedFiles(request: vscode.ChatRequest): string[] {
        const files: string[] = [];
        
        if (request.references) {
            for (const ref of request.references) {
                // Check for file references
                if (ref.id === 'vscode.file' && ref.value) {
                    const uri = ref.value as vscode.Uri;
                    if (uri.fsPath) {
                        files.push(uri.fsPath);
                    }
                }
                // Also check for URI type values
                if (ref.value instanceof vscode.Uri) {
                    files.push(ref.value.fsPath);
                }
                // Handle location references (file + range)
                if (ref.value && typeof ref.value === 'object' && 'uri' in ref.value) {
                    const loc = ref.value as vscode.Location;
                    files.push(loc.uri.fsPath);
                }
            }
        }
        
        return files;
    }

    /**
     * Find indexed documents that match the attached files
     */
    private findMatchingDocuments(attachedFiles: string[]): { name: string; id: string; path: string }[] {
        const matched: { name: string; id: string; path: string }[] = [];
        const allDocs = this.documentStore.getAllDocuments();
        
        console.log('Research Copilot: Looking for matches among', allDocs.length, 'documents');
        
        for (const filePath of attachedFiles) {
            const normalizedPath = filePath.toLowerCase().replace(/\\/g, '/');
            const fileName = filePath.split(/[/\\]/).pop()?.toLowerCase() || '';
            const fileNameWithoutExt = fileName.replace(/\.[^.]+$/, '');
            
            console.log('Research Copilot: Trying to match:', fileName, 'or', fileNameWithoutExt);
            
            for (const doc of allDocs) {
                const docNameLower = doc.name.toLowerCase();
                const docNameWithoutExt = doc.name.replace(/\.[^.]+$/, '').toLowerCase();
                const docPathNormalized = doc.path.toLowerCase().replace(/\\/g, '/');
                const extractedPathNormalized = doc.extractedPath?.toLowerCase().replace(/\\/g, '/') || '';
                
                // Multiple matching strategies:
                // 1. Exact path match
                // 2. Filename match (with or without extension)
                // 3. Extracted markdown file match
                // 4. Partial path match (contains the filename)
                // 5. PDF to MD conversion match
                const matches = 
                    docPathNormalized === normalizedPath ||
                    docNameLower === fileName ||
                    docNameWithoutExt === fileNameWithoutExt ||
                    extractedPathNormalized === normalizedPath ||
                    normalizedPath.endsWith('/' + docNameLower) ||
                    normalizedPath.endsWith('/' + docNameWithoutExt + '.pdf') ||
                    normalizedPath.endsWith('/' + docNameWithoutExt + '.md') ||
                    // Handle case where .md file is attached but we indexed .pdf
                    (fileName.endsWith('.md') && docNameWithoutExt === fileNameWithoutExt);
                
                if (matches) {
                    console.log('Research Copilot: Found match!', doc.name);
                    matched.push({ name: doc.name, id: doc.id, path: doc.path });
                    break;
                }
            }
        }
        
        return matched;
    }

    /**
     * Get document filter pattern from attached files
     */
    private getDocumentFilter(attachedFiles: string[]): string | undefined {
        if (attachedFiles.length === 0) return undefined;
        
        const matchedDocs = this.findMatchingDocuments(attachedFiles);
        if (matchedDocs.length === 0) return undefined;
        
        // Return a filter that matches the document names
        return matchedDocs.map(d => d.name).join('|');
    }

    /**
     * Get the first attached document name for commands
     */
    private getFirstAttachedDocName(attachedFiles: string[]): string {
        const matched = this.findMatchingDocuments(attachedFiles);
        return matched.length > 0 ? matched[0].name : '';
    }

    private async handleListCommand(stream: vscode.ChatResponseStream): Promise<vscode.ChatResult> {
        const documents = this.documentStore.getAllDocuments();
        
        stream.markdown('## 📚 Indexed Research Documents\n\n');
        
        for (const doc of documents) {
            stream.markdown(`### ${doc.name}\n`);
            stream.markdown(`- **Pages:** ${doc.pageCount}\n`);
            stream.markdown(`- **Indexed:** ${new Date(doc.indexedAt).toLocaleDateString()}\n`);
            stream.markdown(`- **Chunks:** ${doc.chunks.length}\n`);
            stream.markdown(`- **Images:** ${doc.images.length}\n\n`);
        }

        return { metadata: { command: 'list' } };
    }

    private async handleStatsCommand(stream: vscode.ChatResponseStream): Promise<vscode.ChatResult> {
        const stats = this.documentStore.getStats();
        
        stream.markdown('## 📊 Research Copilot Statistics\n\n');
        stream.markdown(`| Metric | Value |\n`);
        stream.markdown(`|--------|-------|\n`);
        stream.markdown(`| Documents | ${stats.documentCount} |\n`);
        stream.markdown(`| Total Pages | ${stats.totalPages} |\n`);
        stream.markdown(`| Text Chunks | ${stats.totalChunks} |\n`);
        stream.markdown(`| Images | ${stats.totalImages} |\n`);
        stream.markdown(`| Total Size | ${(stats.totalSizeBytes / 1024 / 1024).toFixed(2)} MB |\n`);

        return { metadata: { command: 'stats' } };
    }

    private async handleSummarizeCommand(
        docName: string, 
        stream: vscode.ChatResponseStream
    ): Promise<vscode.ChatResult> {
        if (!docName) {
            // List all documents and ask which to summarize
            const docs = this.documentStore.getAllDocuments();
            stream.markdown('Please specify which document to summarize:\n\n');
            for (const doc of docs) {
                stream.markdown(`- ${doc.name}\n`);
            }
            return { metadata: { command: 'summarize', needsInput: true } };
        }

        const doc = this.documentStore.findDocumentByName(docName);
        if (!doc) {
            stream.markdown(`❌ Document "${docName}" not found.\n`);
            return { metadata: { command: 'summarize', error: 'notFound' } };
        }

        stream.markdown(`## Summary: ${doc.name}\n\n`);
        stream.markdown(doc.summary || 'No summary available.');
        
        return { metadata: { command: 'summarize' } };
    }

    private async handleSearchQuery(
        query: string,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken,
        attachedFiles: string[] = []
    ): Promise<vscode.ChatResult> {
        stream.progress('Searching through your research documents...');

        // Get document filter from attached files
        const documentFilter = this.getDocumentFilter(attachedFiles);
        
        // Search for relevant content (filtered if files are attached)
        const results = await this.searchService.search(query, 5, documentFilter);

        if (results.length === 0) {
            if (attachedFiles.length > 0) {
                stream.markdown('🔍 I couldn\'t find relevant information in the attached document(s) for this query.\n\n');
                stream.markdown('**Try:**\n');
                stream.markdown('- Using different keywords\n');
                stream.markdown('- Removing the file attachment to search all documents\n');
                stream.markdown('- Making sure the attached file is indexed\n');
            } else {
                stream.markdown('🔍 I couldn\'t find relevant information in your documents for this query.\n\n');
                stream.markdown('**Try:**\n');
                stream.markdown('- Using different keywords\n');
                stream.markdown('- Being more specific or more general\n');
                stream.markdown('- Checking if the relevant documents are indexed\n');
            }
            return { metadata: { command: 'search', resultCount: 0 } };
        }

        // Provide context about sources
        stream.markdown('📚 **Based on your research documents:**\n\n');

        // Build context from top results
        const contextParts: string[] = [];
        const citedDocs = new Set<string>();

        for (const result of results) {
            contextParts.push(`[From ${result.documentName}, Page ${result.pageNumber}]:\n${result.text}`);
            citedDocs.add(result.documentName);
        }

        // Use language model to synthesize answer with timeout protection
        try {
            // Try different model families for better compatibility
            let models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
            
            if (models.length === 0) {
                // Try without vendor specification
                models = await vscode.lm.selectChatModels({});
            }

            if (models.length > 0 && !token.isCancellationRequested) {
                const model = models[0];
                
                const systemPrompt = `You are a research assistant helping the user understand their research documents. 
Answer based ONLY on the provided context excerpts.
If the context doesn't contain enough information, say so.
Cite which document and page number your information comes from.
Be concise but thorough.`;

                const contextText = contextParts.join('\n\n---\n\n');
                
                // Limit context size to avoid timeouts
                const truncatedContext = contextText.length > 8000 
                    ? contextText.substring(0, 8000) + '\n\n[... content truncated for length ...]'
                    : contextText;
                
                const messages = [
                    vscode.LanguageModelChatMessage.User(
                        `${systemPrompt}\n\n## Context from Research Documents:\n\n${truncatedContext}\n\n## User Question:\n${query}`
                    )
                ];

                const response = await model.sendRequest(messages, {}, token);

                for await (const chunk of response.text) {
                    if (token.isCancellationRequested) break;
                    stream.markdown(chunk);
                }
            } else {
                // Fallback: just show the excerpts directly
                stream.markdown('*Showing relevant excerpts:*\n\n');
                for (const result of results) {
                    stream.markdown(`### From ${result.documentName} (Page ${result.pageNumber})\n\n`);
                    stream.markdown(`> ${result.excerpt}\n\n`);
                }
            }
        } catch (error: any) {
            console.error('Error using language model:', error);
            stream.markdown(`\n\n*Note: Could not generate AI summary. Showing excerpts instead.*\n\n`);
            // Fallback to showing excerpts
            for (const result of results) {
                stream.markdown(`### From ${result.documentName} (Page ${result.pageNumber})\n\n`);
                stream.markdown(`> ${result.excerpt}\n\n`);
            }
        }

        // Add source references
        stream.markdown('\n\n---\n**Sources:**\n');
        for (const docName of citedDocs) {
            stream.markdown(`- 📄 ${docName}\n`);
        }

        return { 
            metadata: { 
                command: 'search', 
                resultCount: results.length,
                documents: Array.from(citedDocs)
            } 
        };
    }

    /**
     * Handle query with per-sentence citations and clickable PDF links
     */
    private async handleCitedQuery(
        query: string,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken,
        attachedFiles: string[] = []
    ): Promise<vscode.ChatResult> {
        if (!this.citedAnswerGenerator) {
            // Fall back to regular search
            stream.markdown('*Note: Cited answer generator not available. Using standard search.*\n\n');
            return this.handleSearchQuery(query, stream, token, attachedFiles);
        }

        stream.progress('Generating answer with citations...');

        // Get document filter from attached files
        const matchedDocs = this.findMatchingDocuments(attachedFiles);
        const documentFilter = matchedDocs.length > 0 ? matchedDocs.map(d => d.id) : undefined;

        try {
            // Generate cited answer
            const answer = await this.citedAnswerGenerator.generateAnswer(
                query,
                10,  // max sources
                documentFilter
            );

            // Stream the answer with clickable citations
            stream.markdown('📚 **Answer with citations:**\n\n');
            
            for (const sentence of answer.sentences) {
                stream.markdown(sentence.text);

                if (sentence.citations.length > 0) {
                    const citationNumbers = [...new Set(sentence.citations.map(c => c.index))].sort((a, b) => a - b);
                    
                    for (const num of citationNumbers) {
                        const citation = answer.citations.find(c => c.index === num);
                        if (citation) {
                            // Create citation as a button that can be clicked
                            const citationText = ` [${num}]`;
                            stream.markdown(citationText);
                        }
                    }
                }
                stream.markdown(' ');
            }

            // Add clickable references section
            stream.markdown('\n\n---\n\n**📖 References** *(click to open in PDF)*:\n\n');

            for (const citation of answer.citations) {
                const pageInfo = citation.pageNumber > 0 ? `, p.${citation.pageNumber}` : '';
                
                // Create a button for each citation
                stream.button({
                    title: `[${citation.index}] ${citation.documentName}${pageInfo}`,
                    command: 'researchCopilot.openCitation',
                    arguments: [{
                        documentPath: citation.documentPath,
                        pageNumber: citation.pageNumber,
                        text: citation.text.substring(0, 200),
                        position: citation.position,
                        documentName: citation.documentName
                    }]
                });
                stream.markdown('\n');
            }

            // Add confidence info
            const avgConfidence = answer.metadata.averageConfidence;
            stream.markdown(`\n*${answer.metadata.sourcesUsed} sources used, ${(avgConfidence * 100).toFixed(0)}% avg. confidence*\n`);

            return {
                metadata: {
                    command: 'cited',
                    resultCount: answer.citations.length,
                    query: answer.metadata.query
                }
            };
        } catch (error) {
            console.error('Error generating cited answer:', error);
            stream.markdown(`\n\n*Error generating cited answer. Falling back to standard search.*\n\n`);
            return this.handleSearchQuery(query, stream, token, attachedFiles);
        }
    }

    private async handleCitationsCommand(
        docName: string,
        stream: vscode.ChatResponseStream
    ): Promise<vscode.ChatResult> {
        if (!this.citationExtractor) {
            stream.markdown('❌ Citation extractor not available.\n');
            return { metadata: { command: 'citations', error: 'unavailable' } };
        }

        let doc;
        if (docName) {
            doc = this.documentStore.findDocumentByName(docName);
        } else {
            const docs = this.documentStore.getAllDocuments();
            if (docs.length === 1) {
                doc = docs[0];
            } else {
                stream.markdown('Please specify which document to extract citations from:\n\n');
                for (const d of docs) {
                    stream.markdown(`- \`/citations ${d.name}\`\n`);
                }
                return { metadata: { command: 'citations', needsInput: true } };
            }
        }

        if (!doc) {
            stream.markdown(`❌ Document "${docName}" not found.\n`);
            return { metadata: { command: 'citations', error: 'notFound' } };
        }

        const content = this.documentStore.getDocumentContent(doc.id);
        const result = this.citationExtractor.extractCitations(content);

        stream.markdown(`## 📑 Citations from ${doc.name}\n\n`);
        stream.markdown(`**Citation Style:** ${result.citationStyle.toUpperCase()}\n\n`);
        stream.markdown(`| Metric | Count |\n`);
        stream.markdown(`|--------|-------|\n`);
        stream.markdown(`| In-text Citations | ${result.statistics.totalCitations} |\n`);
        stream.markdown(`| Unique References | ${result.statistics.uniqueReferences} |\n\n`);

        if (result.inTextCitations.length > 0) {
            stream.markdown('### In-Text Citations\n\n');
            const sample = result.inTextCitations.slice(0, 10);
            for (const cit of sample) {
                stream.markdown(`- ${this.citationExtractor.formatCitation(cit)}\n`);
            }
            if (result.inTextCitations.length > 10) {
                stream.markdown(`\n*...and ${result.inTextCitations.length - 10} more*\n`);
            }
        }

        if (result.references.length > 0) {
            stream.markdown('\n### References\n\n');
            const sample = result.references.slice(0, 10);
            for (const ref of sample) {
                stream.markdown(`- ${this.citationExtractor.formatCitation(ref)}\n`);
            }
            if (result.references.length > 10) {
                stream.markdown(`\n*...and ${result.references.length - 10} more*\n`);
            }
        }

        return { metadata: { command: 'citations' } };
    }

    private async handleHighlightsCommand(
        stream: vscode.ChatResponseStream
    ): Promise<vscode.ChatResult> {
        if (!this.highlightService) {
            stream.markdown('❌ Highlight service not available.\n');
            return { metadata: { command: 'highlights', error: 'unavailable' } };
        }

        const highlights = this.highlightService.getAllHighlights();

        if (highlights.length === 0) {
            stream.markdown('📌 **No highlights yet.**\n\n');
            stream.markdown('To create highlights:\n');
            stream.markdown('1. Open an extracted document (markdown file)\n');
            stream.markdown('2. Select text you want to highlight\n');
            stream.markdown('3. Run **Research Copilot: Create Highlight** from command palette\n');
            return { metadata: { command: 'highlights', count: 0 } };
        }

        const stats = this.highlightService.getStatistics();

        stream.markdown('## 📌 Your Highlights\n\n');
        stream.markdown(`**Total:** ${stats.total} highlights across ${stats.byDocument.size} documents\n\n`);

        // Group by document
        const grouped = this.highlightService.groupHighlights('document');

        for (const [docName, docHighlights] of grouped) {
            stream.markdown(`### 📄 ${docName}\n\n`);
            
            for (const h of docHighlights.slice(0, 5)) {
                const emoji = this.getColorEmoji(h.color);
                stream.markdown(`${emoji} **Page ${h.pageNumber}:**\n`);
                stream.markdown(`> ${h.text.substring(0, 150)}${h.text.length > 150 ? '...' : ''}\n\n`);
                if (h.note) {
                    stream.markdown(`*Note: ${h.note}*\n\n`);
                }
            }
            
            if (docHighlights.length > 5) {
                stream.markdown(`*...and ${docHighlights.length - 5} more highlights*\n\n`);
            }
        }

        return { metadata: { command: 'highlights', count: highlights.length } };
    }

    private async handleSemanticSearchQuery(
        query: string,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken,
        attachedFiles: string[] = []
    ): Promise<vscode.ChatResult> {
        if (!query) {
            stream.markdown('Please provide a search query after `/semantic`.\n');
            stream.markdown('Example: `/semantic neural network architectures`\n');
            return { metadata: { command: 'semantic', error: 'noQuery' } };
        }

        stream.progress('Performing semantic search...');

        // Get document filter from attached files
        const documentFilter = this.getDocumentFilter(attachedFiles);

        // Use hybrid search for best results (filtered if files are attached)
        const results = await this.searchService.hybridSearch(query, 5, documentFilter);

        if (results.length === 0) {
            if (attachedFiles.length > 0) {
                stream.markdown('🔍 No results found in the attached document(s).\n');
            } else {
                stream.markdown('🔍 No results found.\n');
            }
            return { metadata: { command: 'semantic', resultCount: 0 } };
        }

        stream.markdown('## 🧠 Semantic Search Results\n\n');
        if (attachedFiles.length > 0) {
            stream.markdown('*Searching within attached document(s)*\n\n');
        } else {
            stream.markdown('*Using AI embeddings for deep semantic understanding*\n\n');
        }

        for (const result of results) {
            const keywordBadge = result.keywordScore > 0.5 ? '🔤' : '';
            const semanticBadge = result.semanticScore > 0.5 ? '🧠' : '';
            
            stream.markdown(`### ${result.documentName} (Page ${result.pageNumber}) ${keywordBadge}${semanticBadge}\n\n`);
            stream.markdown(`**Relevance:** ${(result.score * 100).toFixed(1)}%\n\n`);
            stream.markdown(`> ${result.excerpt}\n\n`);
        }

        return { 
            metadata: { 
                command: 'semantic', 
                resultCount: results.length 
            } 
        };
    }

    private getColorEmoji(color: string): string {
        const emojis: Record<string, string> = {
            yellow: '🟡',
            green: '🟢',
            blue: '🔵',
            pink: '🩷',
            purple: '🟣',
            orange: '🟠'
        };
        return emojis[color] || '⚪';
    }
}
