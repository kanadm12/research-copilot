import * as vscode from 'vscode';
import { DocumentChunk } from './documentStore';

export class TextChunker {
    private chunkSize: number;
    private chunkOverlap: number;

    constructor() {
        const config = vscode.workspace.getConfiguration('researchCopilot');
        this.chunkSize = config.get<number>('chunkSize', 1000);
        this.chunkOverlap = config.get<number>('chunkOverlap', 200);
    }

    chunkText(
        fullText: string, 
        pageTexts: Map<number, string>,
        documentId: string
    ): DocumentChunk[] {
        const chunks: DocumentChunk[] = [];
        
        // Strategy 1: Chunk by pages first, then split large pages
        for (const [pageNum, pageText] of pageTexts) {
            if (pageText.length <= this.chunkSize) {
                // Page fits in one chunk
                chunks.push({
                    id: this.generateChunkId(documentId, pageNum, 0),
                    documentId,
                    text: pageText,
                    pageNumber: pageNum,
                    startIndex: 0,
                    endIndex: pageText.length
                });
            } else {
                // Split page into multiple chunks
                const pageChunks = this.splitIntoChunks(pageText, documentId, pageNum);
                chunks.push(...pageChunks);
            }
        }

        return chunks;
    }

    private splitIntoChunks(
        text: string, 
        documentId: string, 
        pageNumber: number
    ): DocumentChunk[] {
        const chunks: DocumentChunk[] = [];
        
        // Try to split on sentence boundaries
        const sentences = this.splitIntoSentences(text);
        
        let currentChunk = '';
        let currentStart = 0;
        let chunkIndex = 0;

        for (const sentence of sentences) {
            if (currentChunk.length + sentence.length > this.chunkSize && currentChunk.length > 0) {
                // Save current chunk
                chunks.push({
                    id: this.generateChunkId(documentId, pageNumber, chunkIndex),
                    documentId,
                    text: currentChunk.trim(),
                    pageNumber,
                    startIndex: currentStart,
                    endIndex: currentStart + currentChunk.length
                });

                // Start new chunk with overlap
                const overlapText = this.getOverlapText(currentChunk);
                currentStart = currentStart + currentChunk.length - overlapText.length;
                currentChunk = overlapText;
                chunkIndex++;
            }
            
            currentChunk += sentence + ' ';
        }

        // Don't forget the last chunk
        if (currentChunk.trim().length > 0) {
            chunks.push({
                id: this.generateChunkId(documentId, pageNumber, chunkIndex),
                documentId,
                text: currentChunk.trim(),
                pageNumber,
                startIndex: currentStart,
                endIndex: currentStart + currentChunk.length
            });
        }

        return chunks;
    }

    private splitIntoSentences(text: string): string[] {
        // Split on sentence boundaries while preserving the delimiter
        const sentenceRegex = /[^.!?]*[.!?]+/g;
        const sentences: string[] = text.match(sentenceRegex) || [];
        
        // Handle any remaining text without sentence endings
        const lastMatch = sentences.join('');
        if (lastMatch.length < text.length) {
            sentences.push(text.substring(lastMatch.length));
        }

        return sentences.filter(s => s.trim().length > 0);
    }

    private getOverlapText(text: string): string {
        // Get the last N characters as overlap, but try to break on word boundaries
        if (text.length <= this.chunkOverlap) {
            return text;
        }

        let overlapText = text.substring(text.length - this.chunkOverlap);
        
        // Find the first space to start at a word boundary
        const firstSpace = overlapText.indexOf(' ');
        if (firstSpace > 0 && firstSpace < this.chunkOverlap / 2) {
            overlapText = overlapText.substring(firstSpace + 1);
        }

        return overlapText;
    }

    private generateChunkId(documentId: string, pageNumber: number, index: number): string {
        return `${documentId}_p${pageNumber}_c${index}`;
    }

    // Utility method to merge adjacent chunks if needed
    mergeChunks(chunks: DocumentChunk[]): DocumentChunk[] {
        if (chunks.length <= 1) return chunks;

        const merged: DocumentChunk[] = [];
        let current = { ...chunks[0] };

        for (let i = 1; i < chunks.length; i++) {
            const next = chunks[i];
            
            if (current.pageNumber === next.pageNumber && 
                current.text.length + next.text.length <= this.chunkSize * 1.5) {
                // Merge
                current.text = current.text + ' ' + next.text;
                current.endIndex = next.endIndex;
            } else {
                merged.push(current);
                current = { ...next };
            }
        }
        
        merged.push(current);
        return merged;
    }
}
