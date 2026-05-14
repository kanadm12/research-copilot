import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * EmbeddingService - Uses Xenova/transformers.js with the all-MiniLM-L6-v2 model
 * for high-quality sentence embeddings. This model is:
 * - Fast and lightweight
 * - Excellent for semantic similarity
 * - Trained on 1B+ sentence pairs
 * - Produces 384-dimensional embeddings
 */
export class EmbeddingService {
    private pipeline: any = null;
    private modelName: string = 'Xenova/all-MiniLM-L6-v2';
    private isInitializing: boolean = false;
    private initPromise: Promise<void> | null = null;
    private context: vscode.ExtensionContext;
    private cacheDir: string;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.cacheDir = path.join(context.globalStorageUri.fsPath, 'models');
        
        // Ensure cache directory exists
        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
        }
    }

    async initialize(): Promise<void> {
        if (this.pipeline) return;
        if (this.initPromise) return this.initPromise;

        this.isInitializing = true;
        this.initPromise = this._initialize();

        try {
            await this.initPromise;
        } catch (error) {
            this.initPromise = null; // Allow retry on next call
            throw error;
        } finally {
            this.isInitializing = false;
        }
    }

    private async _initialize(): Promise<void> {
        try {
            console.log(`Loading embedding model: ${this.modelName}`);
            
            // Dynamic import of transformers.js
            const { pipeline, env } = await import('@xenova/transformers');
            
            // Set cache directory
            env.cacheDir = this.cacheDir;
            env.allowLocalModels = true;
            env.allowRemoteModels = true;

            // Show progress notification
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Research Copilot: Loading embedding model...',
                cancellable: false
            }, async (progress) => {
                progress.report({ message: 'Downloading model (first time only)...' });
                
                // Initialize the feature-extraction pipeline
                this.pipeline = await pipeline('feature-extraction', this.modelName, {
                    quantized: true, // Use quantized model for faster inference
                });
                
                progress.report({ message: 'Model loaded successfully!' });
            });

            console.log('Embedding model loaded successfully');
        } catch (error) {
            console.error('Failed to load embedding model:', error);
            throw error;
        }
    }

    /**
     * Generate embeddings for a single text
     */
    async embed(text: string): Promise<number[]> {
        await this.initialize();
        
        if (!this.pipeline) {
            throw new Error('Embedding pipeline not initialized');
        }

        // Truncate text if too long (model has 512 token limit)
        const truncatedText = this.truncateText(text, 500);
        
        const output = await this.pipeline(truncatedText, {
            pooling: 'mean',
            normalize: true
        });

        // Convert to regular array
        return Array.from(output.data);
    }

    /**
     * Generate embeddings for multiple texts (batch processing)
     */
    async embedBatch(texts: string[]): Promise<number[][]> {
        await this.initialize();
        
        if (!this.pipeline) {
            throw new Error('Embedding pipeline not initialized');
        }

        const embeddings: number[][] = [];
        
        // Process in batches to avoid memory issues
        const batchSize = 32;
        for (let i = 0; i < texts.length; i += batchSize) {
            const batch = texts.slice(i, i + batchSize);
            const truncatedBatch = batch.map(t => this.truncateText(t, 500));
            
            const outputs = await this.pipeline(truncatedBatch, {
                pooling: 'mean',
                normalize: true
            });

            // Extract embeddings from output
            for (let j = 0; j < batch.length; j++) {
                const embedding = outputs[j]?.data || outputs.data.slice(j * 384, (j + 1) * 384);
                embeddings.push(Array.from(embedding));
            }
        }

        return embeddings;
    }

    /**
     * Calculate cosine similarity between two embeddings
     */
    cosineSimilarity(a: number[], b: number[]): number {
        if (a.length !== b.length) {
            throw new Error('Embeddings must have the same dimension');
        }

        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }

        normA = Math.sqrt(normA);
        normB = Math.sqrt(normB);

        if (normA === 0 || normB === 0) return 0;
        
        return dotProduct / (normA * normB);
    }

    /**
     * Find top-k most similar embeddings
     */
    findMostSimilar(
        queryEmbedding: number[],
        candidateEmbeddings: { id: string; embedding: number[] }[],
        topK: number = 10
    ): { id: string; score: number }[] {
        const scores = candidateEmbeddings.map(candidate => ({
            id: candidate.id,
            score: this.cosineSimilarity(queryEmbedding, candidate.embedding)
        }));

        // Sort by score descending
        scores.sort((a, b) => b.score - a.score);

        return scores.slice(0, topK);
    }

    /**
     * Truncate text to approximately N words
     */
    private truncateText(text: string, maxWords: number): string {
        const words = text.split(/\s+/);
        if (words.length <= maxWords) return text;
        return words.slice(0, maxWords).join(' ');
    }

    /**
     * Get the embedding dimension (384 for MiniLM)
     */
    getDimension(): number {
        return 384;
    }

    /**
     * Check if model is loaded
     */
    isReady(): boolean {
        return this.pipeline !== null;
    }

    /**
     * Dispose of resources
     */
    dispose(): void {
        this.pipeline = null;
    }
}

/**
 * Vector store for efficient similarity search
 */
export class VectorStore {
    private vectors: Map<string, number[]> = new Map();
    private embeddingService: EmbeddingService;

    constructor(embeddingService: EmbeddingService) {
        this.embeddingService = embeddingService;
    }

    /**
     * Add a vector to the store
     */
    add(id: string, embedding: number[]): void {
        this.vectors.set(id, embedding);
    }

    /**
     * Add multiple vectors
     */
    addBatch(items: { id: string; embedding: number[] }[]): void {
        for (const item of items) {
            this.vectors.set(item.id, item.embedding);
        }
    }

    /**
     * Remove a vector
     */
    remove(id: string): boolean {
        return this.vectors.delete(id);
    }

    /**
     * Search for similar vectors
     */
    search(queryEmbedding: number[], topK: number = 10): { id: string; score: number }[] {
        const candidates = Array.from(this.vectors.entries()).map(([id, embedding]) => ({
            id,
            embedding
        }));

        return this.embeddingService.findMostSimilar(queryEmbedding, candidates, topK);
    }

    /**
     * Get a vector by ID
     */
    get(id: string): number[] | undefined {
        return this.vectors.get(id);
    }

    /**
     * Check if vector exists
     */
    has(id: string): boolean {
        return this.vectors.has(id);
    }

    /**
     * Get count
     */
    size(): number {
        return this.vectors.size;
    }

    /**
     * Clear all vectors
     */
    clear(): void {
        this.vectors.clear();
    }

    /**
     * Export vectors for persistence
     */
    export(): { id: string; embedding: number[] }[] {
        return Array.from(this.vectors.entries()).map(([id, embedding]) => ({
            id,
            embedding
        }));
    }

    /**
     * Import vectors from persistence
     */
    import(data: { id: string; embedding: number[] }[]): void {
        for (const item of data) {
            this.vectors.set(item.id, item.embedding);
        }
    }
}
