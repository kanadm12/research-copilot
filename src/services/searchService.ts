import { DocumentStore, DocumentChunk, SearchResult, DocumentMetadata } from './documentStore';
import { EmbeddingService, VectorStore } from './embeddingService';
import * as vscode from 'vscode';

interface TermFrequency {
    [term: string]: number;
}

interface DocumentFrequency {
    [term: string]: Set<string>;
}

export interface HybridSearchResult extends SearchResult {
    keywordScore: number;
    semanticScore: number;
    combinedScore: number;
}

export class SearchService {
    private documentStore: DocumentStore;
    private embeddingService: EmbeddingService | null = null;
    private vectorStore: VectorStore | null = null;
    private termFrequencies: Map<string, TermFrequency> = new Map();
    private documentFrequencies: DocumentFrequency = {};
    private totalDocuments: number = 0;
    private indexBuilt: boolean = false;
    private embeddingsBuilt: boolean = false;
    private buildingEmbeddings: boolean = false;
    private buildingPromise: Promise<void> | null = null;

    constructor(documentStore: DocumentStore, embeddingService?: EmbeddingService) {
        this.documentStore = documentStore;
        if (embeddingService) {
            this.embeddingService = embeddingService;
            this.vectorStore = new VectorStore(embeddingService);
        }
    }

    /**
     * Set embedding service (can be done after construction)
     */
    setEmbeddingService(embeddingService: EmbeddingService): void {
        this.embeddingService = embeddingService;
        this.vectorStore = new VectorStore(embeddingService);
        this.embeddingsBuilt = false;
    }

    /**
     * Build the TF-IDF keyword index
     */
    private buildIndex(): void {
        if (this.indexBuilt) return;

        const chunks = this.documentStore.getAllChunks();
        this.totalDocuments = chunks.length;
        this.termFrequencies.clear();
        this.documentFrequencies = {};

        for (const chunk of chunks) {
            const terms = this.tokenize(chunk.text);
            const tf: TermFrequency = {};
            const uniqueTerms = new Set<string>();

            for (const term of terms) {
                tf[term] = (tf[term] || 0) + 1;
                uniqueTerms.add(term);
            }

            // Normalize TF
            const maxTf = Math.max(...Object.values(tf));
            for (const term in tf) {
                tf[term] = tf[term] / maxTf;
            }

            this.termFrequencies.set(chunk.id, tf);

            // Update document frequencies
            for (const term of uniqueTerms) {
                if (!this.documentFrequencies[term]) {
                    this.documentFrequencies[term] = new Set();
                }
                this.documentFrequencies[term].add(chunk.id);
            }
        }

        this.indexBuilt = true;
    }

    private tokenize(text: string): string[] {
        return text
            .toLowerCase()
            .replace(/[^\w\s]/g, ' ')
            .split(/\s+/)
            .filter(token => token.length > 2)
            .filter(token => !this.isStopWord(token));
    }

    private isStopWord(word: string): boolean {
        const stopWords = new Set([
            'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
            'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
            'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
            'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need',
            'that', 'this', 'these', 'those', 'it', 'its', 'they', 'them', 'their',
            'we', 'our', 'you', 'your', 'he', 'she', 'his', 'her', 'him'
        ]);
        return stopWords.has(word);
    }

    private calculateTfIdf(term: string, chunkId: string): number {
        const tf = this.termFrequencies.get(chunkId)?.[term] || 0;
        const df = this.documentFrequencies[term]?.size || 0;
        
        if (tf === 0 || df === 0) return 0;
        
        const idf = Math.log(this.totalDocuments / df);
        return tf * idf;
    }

    async search(
        query: string, 
        maxResults: number = 10,
        documentFilter?: string
    ): Promise<SearchResult[]> {
        this.buildIndex();

        const queryTerms = this.tokenize(query);
        if (queryTerms.length === 0) {
            return [];
        }

        const scores: Map<string, number> = new Map();
        const chunks = this.documentStore.getAllChunks();

        for (const chunk of chunks) {
            // Apply document filter if specified
            if (documentFilter) {
                const doc = this.documentStore.getDocument(chunk.documentId);
                if (!doc) continue;
                
                // Support pipe-separated filter for multiple documents
                const filterPatterns = documentFilter.toLowerCase().split('|').map(f => f.trim());
                const docNameLower = doc.name.toLowerCase();
                const matchesFilter = filterPatterns.some(pattern => 
                    docNameLower.includes(pattern) || docNameLower === pattern
                );
                
                if (!matchesFilter) {
                    continue;
                }
            }

            let score = 0;
            for (const term of queryTerms) {
                score += this.calculateTfIdf(term, chunk.id);
            }

            // Boost for exact phrase matches
            const lowerText = chunk.text.toLowerCase();
            const lowerQuery = query.toLowerCase();
            if (lowerText.includes(lowerQuery)) {
                score *= 2;
            }

            // Boost for multiple query terms appearing close together
            const proximityBoost = this.calculateProximityBoost(chunk.text, queryTerms);
            score *= (1 + proximityBoost);

            if (score > 0) {
                scores.set(chunk.id, score);
            }
        }

        // Sort by score and take top results
        const sortedChunkIds = Array.from(scores.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, maxResults)
            .map(([id, score]) => ({ id, score }));

        // Build search results
        const results: SearchResult[] = [];
        
        for (const { id, score } of sortedChunkIds) {
            const chunk = this.documentStore.findChunkById(id);
            if (!chunk) continue;

            const doc = this.documentStore.getDocument(chunk.documentId);
            if (!doc) continue;

            // Normalize score to 0-1 range
            const maxScore = sortedChunkIds[0]?.score || 1;
            const normalizedScore = score / maxScore;

            results.push({
                documentId: doc.id,
                documentName: doc.name,
                documentPath: doc.path,
                chunkId: chunk.id,
                text: chunk.text,
                pageNumber: chunk.pageNumber,
                score: normalizedScore,
                excerpt: this.createExcerpt(chunk.text, queryTerms)
            });
        }

        return results;
    }

    private calculateProximityBoost(text: string, terms: string[]): number {
        if (terms.length < 2) return 0;

        const lowerText = text.toLowerCase();
        let minDistance = Infinity;

        for (let i = 0; i < terms.length - 1; i++) {
            for (let j = i + 1; j < terms.length; j++) {
                const pos1 = lowerText.indexOf(terms[i]);
                const pos2 = lowerText.indexOf(terms[j]);
                
                if (pos1 >= 0 && pos2 >= 0) {
                    const distance = Math.abs(pos2 - pos1);
                    minDistance = Math.min(minDistance, distance);
                }
            }
        }

        if (minDistance === Infinity) return 0;
        
        // Closer terms = higher boost (max 0.5 boost for adjacent terms)
        return Math.max(0, 0.5 - (minDistance / 200));
    }

    private createExcerpt(text: string, queryTerms: string[], maxLength: number = 200): string {
        const lowerText = text.toLowerCase();
        
        // Find the best position to start the excerpt (where most query terms appear)
        let bestPosition = 0;
        let bestScore = 0;

        for (let i = 0; i < text.length - maxLength; i += 50) {
            const window = lowerText.substring(i, i + maxLength);
            let score = 0;
            for (const term of queryTerms) {
                if (window.includes(term)) {
                    score++;
                }
            }
            if (score > bestScore) {
                bestScore = score;
                bestPosition = i;
            }
        }

        // Extract excerpt
        let excerpt = text.substring(bestPosition, bestPosition + maxLength);
        
        // Clean up excerpt boundaries
        if (bestPosition > 0) {
            const firstSpace = excerpt.indexOf(' ');
            if (firstSpace > 0 && firstSpace < 20) {
                excerpt = '...' + excerpt.substring(firstSpace + 1);
            } else {
                excerpt = '...' + excerpt;
            }
        }
        
        if (bestPosition + maxLength < text.length) {
            const lastSpace = excerpt.lastIndexOf(' ');
            if (lastSpace > maxLength - 20) {
                excerpt = excerpt.substring(0, lastSpace) + '...';
            } else {
                excerpt = excerpt + '...';
            }
        }

        return excerpt.trim();
    }

    /**
     * Build embedding index for semantic search
     */
    async buildEmbeddingIndex(): Promise<void> {
        if (!this.embeddingService || !this.vectorStore) {
            console.log('Embedding service not available');
            return;
        }

        if (this.embeddingsBuilt) {
            return;
        }

        // Use promise-based mutex to prevent race condition
        if (this.buildingPromise) {
            return this.buildingPromise;
        }

        this.buildingPromise = this.doBuildEmbeddingIndex();
        try {
            await this.buildingPromise;
        } finally {
            this.buildingPromise = null;
        }
    }

    private async doBuildEmbeddingIndex(): Promise<void> {
        if (this.embeddingsBuilt) return;

        this.buildingEmbeddings = true;

        try {
            await this.embeddingService!.initialize();
            
            const chunks = this.documentStore.getAllChunks();
            console.log(`Building embeddings for ${chunks.length} chunks...`);

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Research Copilot: Building semantic index...',
                cancellable: false
            }, async (progress) => {
                const batchSize = 16;
                for (let i = 0; i < chunks.length; i += batchSize) {
                    const batch = chunks.slice(i, i + batchSize);
                    const texts = batch.map(c => c.text);
                    
                    progress.report({ 
                        message: `Processing ${i + batch.length}/${chunks.length} chunks`,
                        increment: (batch.length / chunks.length) * 100 
                    });

                    const embeddings = await this.embeddingService!.embedBatch(texts);
                    
                    for (let j = 0; j < batch.length; j++) {
                        this.vectorStore!.add(batch[j].id, embeddings[j]);
                    }
                }
            });

            this.embeddingsBuilt = true;
            console.log('Embedding index built successfully');
        } catch (error) {
            console.error('Failed to build embedding index:', error);
        } finally {
            this.buildingEmbeddings = false;
        }
    }

    /**
     * Semantic search using embeddings
     */
    async semanticSearch(
        query: string,
        maxResults: number = 10,
        documentFilter?: string
    ): Promise<SearchResult[]> {
        if (!this.embeddingService || !this.vectorStore) {
            console.log('Embedding service not available, falling back to keyword search');
            return this.search(query, maxResults, documentFilter);
        }

        // Build index if needed
        if (!this.embeddingsBuilt) {
            await this.buildEmbeddingIndex();
        }

        if (this.vectorStore.size() === 0) {
            return this.search(query, maxResults, documentFilter);
        }

        try {
            // Get query embedding
            const queryEmbedding = await this.embeddingService.embed(query);
            
            // Search vector store
            const vectorResults = this.vectorStore.search(queryEmbedding, maxResults * 2);
            
            // Build search results
            const results: SearchResult[] = [];
            
            for (const { id, score } of vectorResults) {
                const chunk = this.documentStore.findChunkById(id);
                if (!chunk) continue;

                const doc = this.documentStore.getDocument(chunk.documentId);
                if (!doc) continue;

                // Apply document filter (supports pipe-separated multiple documents)
                if (documentFilter) {
                    const filterPatterns = documentFilter.toLowerCase().split('|').map(f => f.trim());
                    const docNameLower = doc.name.toLowerCase();
                    const matchesFilter = filterPatterns.some(pattern => 
                        docNameLower.includes(pattern) || docNameLower === pattern
                    );
                    if (!matchesFilter) {
                        continue;
                    }
                }

                results.push({
                    documentId: doc.id,
                    documentName: doc.name,
                    documentPath: doc.path,
                    chunkId: chunk.id,
                    text: chunk.text,
                    pageNumber: chunk.pageNumber,
                    score,
                    excerpt: this.createExcerpt(chunk.text, this.tokenize(query))
                });

                if (results.length >= maxResults) break;
            }

            return results;
        } catch (error) {
            console.error('Semantic search failed, falling back to keyword search:', error);
            return this.search(query, maxResults, documentFilter);
        }
    }

    /**
     * Hybrid search combining keyword (TF-IDF) and semantic search
     * This provides the best of both worlds
     */
    async hybridSearch(
        query: string,
        maxResults: number = 10,
        documentFilter?: string,
        keywordWeight: number = 0.3,
        semanticWeight: number = 0.7
    ): Promise<HybridSearchResult[]> {
        // Run both searches in parallel
        const [keywordResults, semanticResults] = await Promise.all([
            this.search(query, maxResults * 2, documentFilter),
            this.semanticSearch(query, maxResults * 2, documentFilter)
        ]);

        // Combine scores
        const combinedScores = new Map<string, {
            keywordScore: number;
            semanticScore: number;
            result: SearchResult;
        }>();

        // Add keyword results
        for (const result of keywordResults) {
            combinedScores.set(result.chunkId, {
                keywordScore: result.score,
                semanticScore: 0,
                result
            });
        }

        // Add semantic results
        for (const result of semanticResults) {
            const existing = combinedScores.get(result.chunkId);
            if (existing) {
                existing.semanticScore = result.score;
            } else {
                combinedScores.set(result.chunkId, {
                    keywordScore: 0,
                    semanticScore: result.score,
                    result
                });
            }
        }

        // Calculate combined scores and sort
        const hybridResults: HybridSearchResult[] = [];
        
        for (const [chunkId, data] of combinedScores) {
            const combinedScore = 
                (data.keywordScore * keywordWeight) + 
                (data.semanticScore * semanticWeight);

            hybridResults.push({
                ...data.result,
                keywordScore: data.keywordScore,
                semanticScore: data.semanticScore,
                combinedScore,
                score: combinedScore
            });
        }

        // Sort by combined score
        hybridResults.sort((a, b) => b.combinedScore - a.combinedScore);

        return hybridResults.slice(0, maxResults);
    }

    /**
     * Find semantically similar passages to a given text
     */
    async findSimilarPassages(
        text: string,
        maxResults: number = 10,
        excludeChunkIds: string[] = []
    ): Promise<SearchResult[]> {
        if (!this.embeddingService || !this.vectorStore) {
            return [];
        }

        if (!this.embeddingsBuilt) {
            await this.buildEmbeddingIndex();
        }

        try {
            const embedding = await this.embeddingService.embed(text);
            const results = this.vectorStore.search(embedding, maxResults + excludeChunkIds.length);
            
            const searchResults: SearchResult[] = [];
            
            for (const { id, score } of results) {
                if (excludeChunkIds.includes(id)) continue;
                
                const chunk = this.documentStore.findChunkById(id);
                if (!chunk) continue;

                const doc = this.documentStore.getDocument(chunk.documentId);
                if (!doc) continue;

                searchResults.push({
                    documentId: doc.id,
                    documentName: doc.name,
                    documentPath: doc.path,
                    chunkId: chunk.id,
                    text: chunk.text,
                    pageNumber: chunk.pageNumber,
                    score,
                    excerpt: chunk.text.substring(0, 200) + '...'
                });

                if (searchResults.length >= maxResults) break;
            }

            return searchResults;
        } catch (error) {
            console.error('Failed to find similar passages:', error);
            return [];
        }
    }

    /**
     * Answer a question using retrieved context (RAG-style)
     */
    async retrieveContext(
        question: string,
        maxChunks: number = 5
    ): Promise<{ context: string; sources: SearchResult[] }> {
        // Use hybrid search for best results
        const results = await this.hybridSearch(question, maxChunks);
        
        // Build context from top results
        const contextParts: string[] = [];
        
        for (const result of results) {
            contextParts.push(
                `[Source: ${result.documentName}, Page ${result.pageNumber}]\n${result.text}`
            );
        }

        return {
            context: contextParts.join('\n\n---\n\n'),
            sources: results
        };
    }

    /**
     * Check if semantic search is available
     */
    isSemanticSearchAvailable(): boolean {
        return this.embeddingService !== null && this.embeddingsBuilt;
    }

    /**
     * Get embedding statistics
     */
    getEmbeddingStats(): { 
        available: boolean; 
        indexed: number; 
        dimension: number;
    } {
        return {
            available: this.embeddingService !== null,
            indexed: this.vectorStore?.size() || 0,
            dimension: this.embeddingService?.getDimension() || 0
        };
    }

    // Find related documents
    async findRelated(documentId: string, maxResults: number = 5): Promise<DocumentMetadata[]> {
        const doc = this.documentStore.getDocument(documentId);
        if (!doc) return [];

        // Use the document's summary as a query
        const results = await this.search(doc.summary, maxResults + 1);
        
        // Filter out the source document
        const relatedDocs = new Map<string, DocumentMetadata>();
        
        for (const result of results) {
            if (result.documentId !== documentId && !relatedDocs.has(result.documentId)) {
                const relatedDoc = this.documentStore.getDocument(result.documentId);
                if (relatedDoc) {
                    relatedDocs.set(result.documentId, relatedDoc);
                }
            }
            if (relatedDocs.size >= maxResults) break;
        }

        return Array.from(relatedDocs.values());
    }

    // Invalidate index when documents change
    invalidateIndex(): void {
        this.indexBuilt = false;
        this.termFrequencies.clear();
        this.documentFrequencies = {};
    }
}
