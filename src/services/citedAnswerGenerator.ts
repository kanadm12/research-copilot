import * as vscode from 'vscode';
import { DocumentStore, DocumentMetadata, DocumentChunk, ChunkPosition, SearchResult } from './documentStore';
import { SearchService, HybridSearchResult } from './searchService';
import { PdfPositionService } from './pdfPositionService';

/**
 * A citation reference in the generated answer
 */
export interface InlineCitation {
    id: string;                    // Unique citation ID (e.g., "cite1")
    index: number;                 // Citation number for display [1]
    documentId: string;
    documentName: string;
    documentPath: string;
    pageNumber: number;
    chunkId: string;
    text: string;                  // The source text that was cited
    excerpt: string;               // Short excerpt for tooltip
    position?: ChunkPosition;      // PDF position for highlighting
    confidence: number;            // How confident we are this is the source (0-1)
}

/**
 * A sentence in the generated answer with its citations
 */
export interface CitedSentence {
    text: string;
    citations: InlineCitation[];
    startOffset: number;           // Position in the full answer
    endOffset: number;
}

/**
 * The complete answer with all citations
 */
export interface CitedAnswer {
    // The full answer text with citation markers like [1], [2]
    formattedAnswer: string;
    // The raw answer without citation markers
    rawAnswer: string;
    // All citations used
    citations: InlineCitation[];
    // Answer broken down by sentence with citation mapping
    sentences: CitedSentence[];
    // Metadata
    metadata: {
        query: string;
        generatedAt: string;
        sourcesUsed: number;
        averageConfidence: number;
    };
}

/**
 * Context chunk used for answer generation
 */
interface ContextChunk {
    chunkId: string;
    documentId: string;
    documentName: string;
    documentPath: string;
    pageNumber: number;
    text: string;
    score: number;
    position?: ChunkPosition;
}

/**
 * CitedAnswerGenerator - Generates RAG answers with per-sentence citations
 * 
 * Every statement in the generated answer is traced back to a source chunk,
 * with PDF position data for visual highlighting.
 */
export class CitedAnswerGenerator {
    private context: vscode.ExtensionContext;
    private documentStore: DocumentStore;
    private searchService: SearchService;
    private positionService: PdfPositionService;

    constructor(
        context: vscode.ExtensionContext,
        documentStore: DocumentStore,
        searchService: SearchService,
        positionService: PdfPositionService
    ) {
        this.context = context;
        this.documentStore = documentStore;
        this.searchService = searchService;
        this.positionService = positionService;
    }

    /**
     * Generate an answer with inline citations
     */
    async generateAnswer(
        query: string,
        maxSources: number = 10,
        documentFilter?: string[],
        progress?: vscode.Progress<{ message?: string; increment?: number }>
    ): Promise<CitedAnswer> {
        progress?.report({ message: 'Searching for relevant sources...', increment: 10 });

        // Search for relevant content
        const searchResults = await this.searchService.hybridSearch(query, maxSources * 2);

        // Filter by documents if specified
        let filteredResults = searchResults;
        if (documentFilter && documentFilter.length > 0) {
            filteredResults = searchResults.filter(r => documentFilter.includes(r.documentId));
        }

        // Convert to context chunks with position data
        const contextChunks = await this.prepareContextChunks(filteredResults.slice(0, maxSources));

        progress?.report({ message: 'Generating answer with citations...', increment: 30 });

        // Generate the answer using LLM
        const { rawAnswer, chunkUsage } = await this.generateWithLLM(query, contextChunks);

        progress?.report({ message: 'Processing citations...', increment: 30 });

        // Map sentences to citations
        const { sentences, citations } = await this.mapSentencesToCitations(
            rawAnswer,
            contextChunks,
            chunkUsage
        );

        progress?.report({ message: 'Formatting answer...', increment: 20 });

        // Format the final answer with citation markers
        const formattedAnswer = this.formatAnswerWithCitations(sentences);

        // Calculate average confidence
        const avgConfidence = citations.length > 0
            ? citations.reduce((sum, c) => sum + c.confidence, 0) / citations.length
            : 0;

        progress?.report({ message: 'Complete', increment: 10 });

        return {
            formattedAnswer,
            rawAnswer,
            citations,
            sentences,
            metadata: {
                query,
                generatedAt: new Date().toISOString(),
                sourcesUsed: new Set(citations.map(c => c.documentId)).size,
                averageConfidence: avgConfidence
            }
        };
    }

    /**
     * Prepare context chunks with position data
     */
    private async prepareContextChunks(searchResults: HybridSearchResult[]): Promise<ContextChunk[]> {
        const chunks: ContextChunk[] = [];

        for (const result of searchResults) {
            const doc = this.documentStore.getDocument(result.documentId);
            if (!doc) continue;

            const chunk = doc.chunks.find(c => c.id === result.chunkId);
            if (!chunk) continue;

            // Get or compute position data
            let position = chunk.position;
            if (!position) {
                try {
                    const positionMap = await this.positionService.mapChunkToPositions(
                        doc.path,
                        chunk.text.substring(0, 200),  // Use first 200 chars for matching
                        chunk.pageNumber,
                        chunk.id,
                        doc.id
                    );
                    if (positionMap) {
                        position = {
                            pageNumber: positionMap.pageNumber,
                            rects: positionMap.boundingRects
                        };
                    }
                } catch (error) {
                    console.warn('Could not get position for chunk:', chunk.id);
                }
            }

            chunks.push({
                chunkId: chunk.id,
                documentId: doc.id,
                documentName: doc.name,
                documentPath: doc.path,
                pageNumber: chunk.pageNumber,
                text: chunk.text,
                score: result.combinedScore || result.score,
                position
            });
        }

        return chunks;
    }

    /**
     * Generate answer using language model with citation tracking
     */
    private async generateWithLLM(
        query: string,
        chunks: ContextChunk[]
    ): Promise<{ rawAnswer: string; chunkUsage: Map<string, number[]> }> {
        // Build context with numbered sources
        let context = '';
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            context += `[SOURCE ${i + 1}] (${chunk.documentName}, p.${chunk.pageNumber})\n`;
            context += `${chunk.text.substring(0, 500)}\n\n`;
        }

        const prompt = `You are a research assistant. Answer the following question based ONLY on the provided sources. 
For EVERY claim or fact you state, you MUST indicate which source(s) it came from using the format [SOURCE N].

Question: ${query}

Sources:
${context}

Instructions:
1. Answer the question comprehensively using the sources
2. After each sentence or claim, cite the source(s) using [SOURCE N] format
3. If information comes from multiple sources, cite all of them
4. If you cannot answer from the sources, say so
5. Be specific and accurate

Answer:`;

        try {
            // Use VS Code's Language Model API
            const models = await vscode.lm.selectChatModels({ family: 'gpt-4' });
            if (models.length === 0) {
                const allModels = await vscode.lm.selectChatModels();
                if (allModels.length === 0) {
                    throw new Error('No language models available');
                }
                models.push(allModels[0]);
            }

            const model = models[0];
            const messages = [vscode.LanguageModelChatMessage.User(prompt)];
            
            const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
            
            let rawAnswer = '';
            for await (const chunk of response.text) {
                rawAnswer += chunk;
            }

            // Parse source references from the answer
            const chunkUsage = this.parseSourceReferences(rawAnswer, chunks.length);

            return { rawAnswer, chunkUsage };
        } catch (error) {
            console.error('Error generating answer:', error);

            // Fallback: raw excerpts only — no citation markers so no false citations are shown
            const fallbackAnswer = `*AI generation unavailable. Showing raw source excerpts:*\n\n${
                chunks.slice(0, 3).map(c => c.text.substring(0, 300)).join('\n\n---\n\n')
            }`;

            return { rawAnswer: fallbackAnswer, chunkUsage: new Map() };
        }
    }

    /**
     * Parse [SOURCE N] references from the answer
     */
    private parseSourceReferences(answer: string, maxSources: number): Map<string, number[]> {
        const usage = new Map<string, number[]>();
        const pattern = /\[SOURCE\s*(\d+)\]/gi;

        let match;
        while ((match = pattern.exec(answer)) !== null) {
            const sourceNum = parseInt(match[1]);
            if (sourceNum >= 1 && sourceNum <= maxSources) {
                const sourceKey = `source_${sourceNum}`;
                if (!usage.has(sourceKey)) {
                    usage.set(sourceKey, []);
                }
                usage.get(sourceKey)!.push(match.index);
            }
        }

        return usage;
    }

    /**
     * Map sentences to their citations
     */
    private async mapSentencesToCitations(
        answer: string,
        chunks: ContextChunk[],
        chunkUsage: Map<string, number[]>
    ): Promise<{ sentences: CitedSentence[]; citations: InlineCitation[] }> {
        const sentences: CitedSentence[] = [];
        const allCitations: InlineCitation[] = [];
        const citationMap = new Map<string, InlineCitation>();

        // Split answer into sentences
        const sentencePattern = /[^.!?]*[.!?]+/g;
        let match;
        let sentenceIndex = 0;

        while ((match = sentencePattern.exec(answer)) !== null) {
            const sentenceText = match[0].trim();
            if (!sentenceText) continue;

            const startOffset = match.index;
            const endOffset = match.index + match[0].length;

            // Find which sources are cited in or near this sentence
            const sentenceCitations: InlineCitation[] = [];
            const sourcePattern = /\[SOURCE\s*(\d+)\]/gi;
            let sourceMatch;

            // Check for source references within this sentence
            while ((sourceMatch = sourcePattern.exec(sentenceText)) !== null) {
                const sourceNum = parseInt(sourceMatch[1]) - 1;  // Convert to 0-indexed
                if (sourceNum >= 0 && sourceNum < chunks.length) {
                    const chunk = chunks[sourceNum];
                    const citationId = `cite_${chunk.chunkId}`;

                    // Create or reuse citation
                    if (!citationMap.has(citationId)) {
                        const citation: InlineCitation = {
                            id: citationId,
                            index: citationMap.size + 1,
                            documentId: chunk.documentId,
                            documentName: chunk.documentName,
                            documentPath: chunk.documentPath,
                            pageNumber: chunk.pageNumber,
                            chunkId: chunk.chunkId,
                            text: chunk.text,
                            excerpt: chunk.text.substring(0, 100) + '...',
                            position: chunk.position,
                            confidence: this.calculateCitationConfidence(sentenceText, chunk.text)
                        };
                        citationMap.set(citationId, citation);
                        allCitations.push(citation);
                    }

                    sentenceCitations.push(citationMap.get(citationId)!);
                }
            }

            // Clean the sentence text (remove source markers)
            const cleanText = sentenceText.replace(/\s*\[SOURCE\s*\d+\]\s*/gi, ' ').trim();

            sentences.push({
                text: cleanText,
                citations: sentenceCitations,
                startOffset,
                endOffset
            });

            sentenceIndex++;
        }

        return { sentences, citations: allCitations };
    }

    /**
     * Calculate confidence that a sentence is derived from a source chunk
     */
    private calculateCitationConfidence(sentence: string, sourceText: string): number {
        // Normalize texts
        const normSentence = sentence.toLowerCase().replace(/[^\w\s]/g, '');
        const normSource = sourceText.toLowerCase().replace(/[^\w\s]/g, '');

        // Calculate word overlap
        const sentenceWords = new Set(normSentence.split(/\s+/).filter(w => w.length > 3));
        const sourceWords = new Set(normSource.split(/\s+/).filter(w => w.length > 3));

        let overlap = 0;
        for (const word of sentenceWords) {
            if (sourceWords.has(word)) overlap++;
        }

        const confidence = sentenceWords.size > 0 
            ? overlap / sentenceWords.size 
            : 0;

        return Math.min(1, confidence * 1.5);  // Boost slightly, cap at 1
    }

    /**
     * Format the answer with citation markers
     */
    private formatAnswerWithCitations(sentences: CitedSentence[]): string {
        return sentences.map(sentence => {
            if (sentence.citations.length === 0) {
                return sentence.text;
            }

            const citationNumbers = [...new Set(sentence.citations.map(c => c.index))].sort((a, b) => a - b);
            const citationStr = citationNumbers.map(n => `[${n}]`).join('');
            
            return `${sentence.text} ${citationStr}`;
        }).join(' ');
    }

    /**
     * Generate markdown output with clickable citations
     */
    generateMarkdownOutput(answer: CitedAnswer): string {
        let markdown = answer.formattedAnswer + '\n\n---\n\n## References\n\n';

        for (const citation of answer.citations) {
            markdown += `[${citation.index}] **${citation.documentName}**, p.${citation.pageNumber}\n`;
            markdown += `> ${citation.excerpt}\n\n`;
        }

        return markdown;
    }

    /**
     * Generate chat response stream with clickable citations
     */
    async streamToChatResponse(
        answer: CitedAnswer,
        stream: vscode.ChatResponseStream
    ): Promise<void> {
        // Output the answer with citation markers
        for (const sentence of answer.sentences) {
            stream.markdown(sentence.text);

            if (sentence.citations.length > 0) {
                const citationNumbers = [...new Set(sentence.citations.map(c => c.index))].sort((a, b) => a - b);
                
                for (const num of citationNumbers) {
                    const citation = answer.citations.find(c => c.index === num);
                    if (citation) {
                        // Create a clickable citation using VS Code URI
                        const citationUri = vscode.Uri.parse(
                            `command:researchCopilot.openCitation?${encodeURIComponent(JSON.stringify({
                                documentPath: citation.documentPath,
                                pageNumber: citation.pageNumber,
                                text: citation.text.substring(0, 200),
                                position: citation.position
                            }))}`
                        );
                        
                        // Output as markdown link
                        stream.markdown(` [[${num}]](${citationUri})`);
                    }
                }
            }

            stream.markdown(' ');
        }

        // Add references section
        stream.markdown('\n\n---\n\n**📚 Sources:**\n\n');

        for (const citation of answer.citations) {
            const pageInfo = citation.pageNumber > 0 ? `, p.${citation.pageNumber}` : '';
            stream.markdown(`**[${citation.index}]** ${citation.documentName}${pageInfo}\n`);
        }
    }

    /**
     * Get a citation by ID
     */
    getCitation(answer: CitedAnswer, citationId: string): InlineCitation | undefined {
        return answer.citations.find(c => c.id === citationId);
    }

    /**
     * Get all citations for a specific document
     */
    getCitationsForDocument(answer: CitedAnswer, documentId: string): InlineCitation[] {
        return answer.citations.filter(c => c.documentId === documentId);
    }

    /**
     * Export answer as JSON for debugging/analysis
     */
    exportAsJson(answer: CitedAnswer): string {
        return JSON.stringify({
            formattedAnswer: answer.formattedAnswer,
            rawAnswer: answer.rawAnswer,
            citations: answer.citations.map(c => ({
                ...c,
                text: c.text.substring(0, 200) + '...'  // Truncate for readability
            })),
            sentences: answer.sentences.map(s => ({
                text: s.text,
                citationIndices: s.citations.map(c => c.index)
            })),
            metadata: answer.metadata
        }, null, 2);
    }
}
