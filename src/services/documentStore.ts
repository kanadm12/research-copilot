import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface DocumentChunk {
    id: string;
    documentId: string;
    text: string;
    pageNumber: number;
    startIndex: number;
    endIndex: number;
    embedding?: number[];
}

export interface DocumentImage {
    id: string;
    documentId: string;
    pageNumber: number;
    path: string;
    width: number;
    height: number;
    description?: string;
    ocrText?: string;
    embedding?: number[];
}

export interface DocumentMetadata {
    id: string;
    name: string;
    path: string;
    pageCount: number;
    indexedAt: string;
    fileSize: number;
    chunks: DocumentChunk[];
    images: DocumentImage[];
    summary: string;
    extractedPath?: string;
    docxPath?: string;  // Path to converted DOCX file (if using DOCX conversion)
    tags?: string[];
    customMetadata?: Record<string, any>;
}

export interface SearchResult {
    documentId: string;
    documentName: string;
    documentPath: string;
    chunkId: string;
    text: string;
    pageNumber: number;
    score: number;
    excerpt: string;
}

export class DocumentStore {
    private context: vscode.ExtensionContext;
    private documents: Map<string, DocumentMetadata> = new Map();
    private indexPath: string = '';
    private initialized: boolean = false;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            console.warn('No workspace folder found, using extension storage');
            this.indexPath = this.context.globalStorageUri.fsPath;
        } else {
            const config = vscode.workspace.getConfiguration('researchCopilot');
            const relativeIndexPath = config.get<string>('indexPath', '.research-copilot');
            this.indexPath = path.join(workspaceFolder.uri.fsPath, relativeIndexPath);
        }

        // Ensure index directory exists
        if (!fs.existsSync(this.indexPath)) {
            fs.mkdirSync(this.indexPath, { recursive: true });
        }

        // Load existing index
        await this.loadIndex();
        this.initialized = true;
    }

    private async loadIndex(): Promise<void> {
        const indexFile = path.join(this.indexPath, 'index.json');
        
        if (fs.existsSync(indexFile)) {
            try {
                const data = fs.readFileSync(indexFile, 'utf8');
                const parsed = JSON.parse(data);
                
                for (const doc of parsed.documents || []) {
                    this.documents.set(doc.id, doc);
                }
                
                console.log(`Loaded ${this.documents.size} documents from index`);
            } catch (error) {
                console.error('Failed to load index:', error);
            }
        }
    }

    private async saveIndex(): Promise<void> {
        const indexFile = path.join(this.indexPath, 'index.json');
        
        const data = {
            version: '1.0',
            lastUpdated: new Date().toISOString(),
            documents: Array.from(this.documents.values())
        };

        fs.writeFileSync(indexFile, JSON.stringify(data, null, 2), 'utf8');
    }

    async addDocument(metadata: DocumentMetadata): Promise<void> {
        // Check if document already exists (by path)
        const existing = this.findDocumentByPath(metadata.path);
        if (existing) {
            // Update existing document
            this.documents.delete(existing.id);
        }

        this.documents.set(metadata.id, metadata);
        await this.saveIndex();
    }

    getDocument(id: string): DocumentMetadata | undefined {
        return this.documents.get(id);
    }

    findDocumentByPath(filePath: string): DocumentMetadata | undefined {
        for (const doc of this.documents.values()) {
            if (doc.path === filePath) {
                return doc;
            }
        }
        return undefined;
    }

    findDocumentByName(name: string): DocumentMetadata | undefined {
        for (const doc of this.documents.values()) {
            if (doc.name.toLowerCase().includes(name.toLowerCase())) {
                return doc;
            }
        }
        return undefined;
    }

    getAllDocuments(): DocumentMetadata[] {
        return Array.from(this.documents.values());
    }

    getDocumentCount(): number {
        return this.documents.size;
    }

    async removeDocument(filePath: string): Promise<boolean> {
        const doc = this.findDocumentByPath(filePath);
        if (!doc) return false;

        // Remove extracted files
        if (doc.extractedPath && fs.existsSync(doc.extractedPath)) {
            fs.unlinkSync(doc.extractedPath);
        }

        // Remove images
        for (const img of doc.images) {
            if (fs.existsSync(img.path)) {
                fs.unlinkSync(img.path);
            }
        }

        this.documents.delete(doc.id);
        await this.saveIndex();
        return true;
    }

    async clearAll(): Promise<void> {
        // Remove all extracted content
        const extractedDir = path.join(this.indexPath, 'extracted');
        if (fs.existsSync(extractedDir)) {
            fs.rmSync(extractedDir, { recursive: true, force: true });
        }

        const imagesDir = path.join(this.indexPath, 'images');
        if (fs.existsSync(imagesDir)) {
            fs.rmSync(imagesDir, { recursive: true, force: true });
        }

        this.documents.clear();
        await this.saveIndex();
    }

    getAllChunks(): DocumentChunk[] {
        const chunks: DocumentChunk[] = [];
        for (const doc of this.documents.values()) {
            chunks.push(...doc.chunks);
        }
        return chunks;
    }

    getAllImages(): DocumentImage[] {
        const images: DocumentImage[] = [];
        for (const doc of this.documents.values()) {
            images.push(...doc.images);
        }
        return images;
    }

    getDocumentContent(documentId: string, pageRange?: string): string {
        const doc = this.documents.get(documentId);
        if (!doc) return '';

        if (!doc.extractedPath || !fs.existsSync(doc.extractedPath)) {
            // Return chunks as content
            return doc.chunks.map(c => c.text).join('\n\n');
        }

        const fullContent = fs.readFileSync(doc.extractedPath, 'utf8');
        
        if (!pageRange) {
            return fullContent;
        }

        // Parse page range and extract relevant content
        // TODO: Implement page range filtering
        return fullContent;
    }

    getDocumentImages(documentId: string, pageNumber?: number): DocumentImage[] {
        const doc = this.documents.get(documentId);
        if (!doc) return [];

        if (pageNumber !== undefined) {
            return doc.images.filter(img => img.pageNumber === pageNumber);
        }

        return doc.images;
    }

    async updateDocumentMetadata(
        documentId: string, 
        updates: Partial<DocumentMetadata>
    ): Promise<void> {
        const doc = this.documents.get(documentId);
        if (!doc) return;

        Object.assign(doc, updates);
        await this.saveIndex();
    }

    // Search-related helpers
    getChunksByDocument(documentId: string): DocumentChunk[] {
        const doc = this.documents.get(documentId);
        return doc?.chunks || [];
    }

    findChunkById(chunkId: string): DocumentChunk | undefined {
        for (const doc of this.documents.values()) {
            const chunk = doc.chunks.find(c => c.id === chunkId);
            if (chunk) return chunk;
        }
        return undefined;
    }

    // Statistics
    getStats(): {
        documentCount: number;
        totalPages: number;
        totalChunks: number;
        totalImages: number;
        totalSizeBytes: number;
    } {
        let totalPages = 0;
        let totalChunks = 0;
        let totalImages = 0;
        let totalSizeBytes = 0;

        for (const doc of this.documents.values()) {
            totalPages += doc.pageCount;
            totalChunks += doc.chunks.length;
            totalImages += doc.images.length;
            totalSizeBytes += doc.fileSize;
        }

        return {
            documentCount: this.documents.size,
            totalPages,
            totalChunks,
            totalImages,
            totalSizeBytes
        };
    }
}
