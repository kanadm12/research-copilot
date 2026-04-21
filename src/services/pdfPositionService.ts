import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Represents a bounding box rectangle in PDF coordinate space
 */
export interface BoundingRect {
    x: number;      // Left position (PDF units)
    y: number;      // Top position (PDF units)
    width: number;  // Width (PDF units)
    height: number; // Height (PDF units)
}

/**
 * Text span with its position in the PDF
 */
export interface PositionedText {
    text: string;
    pageNumber: number;
    rects: BoundingRect[];
    // Character-level positioning for precise citation highlighting
    charPositions?: Array<{
        char: string;
        rect: BoundingRect;
    }>;
}

/**
 * A text item from PDF.js with positioning data
 */
interface PDFTextItem {
    str: string;
    dir: string;
    transform: number[];  // [scaleX, skewX, skewY, scaleY, translateX, translateY]
    width: number;
    height: number;
    fontName?: string;
}

/**
 * Page dimensions for coordinate normalization
 */
export interface PageDimensions {
    width: number;
    height: number;
    rotation: number;
}

/**
 * Mapping between text chunks and their PDF positions
 */
export interface ChunkPositionMap {
    chunkId: string;
    documentId: string;
    pageNumber: number;
    textContent: string;
    boundingRects: BoundingRect[];
    // Start/end character indices in the full page text
    startIndex: number;
    endIndex: number;
}

/**
 * PdfPositionService - Extracts text with bounding box coordinates from PDFs
 * 
 * Uses pdf.js TextContent API to get precise character/word positions,
 * enabling visual highlighting of cited passages in PDF viewers.
 */
export class PdfPositionService {
    private context: vscode.ExtensionContext;
    private pdfjsLib: any = null;
    private pageCache: Map<string, Map<number, PositionedText[]>> = new Map();
    private dimensionsCache: Map<string, Map<number, PageDimensions>> = new Map();

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    /**
     * Initialize pdf.js library
     */
    private async initPdfJs(): Promise<void> {
        if (this.pdfjsLib) return;

        try {
            // Dynamic import of pdfjs-dist
            const pdfjs = await import('pdfjs-dist');
            this.pdfjsLib = pdfjs;

            // Set worker source - using legacy build for Node.js compatibility
            const pdfjsWorker = require('pdfjs-dist/build/pdf.worker.entry');
            pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker;
        } catch (error) {
            console.error('Failed to initialize pdf.js:', error);
            throw new Error('PDF.js initialization failed');
        }
    }

    /**
     * Extract all text with positions from a PDF file
     */
    async extractTextWithPositions(pdfPath: string): Promise<Map<number, PositionedText[]>> {
        await this.initPdfJs();

        // Check cache first
        if (this.pageCache.has(pdfPath)) {
            return this.pageCache.get(pdfPath)!;
        }

        if (!fs.existsSync(pdfPath)) {
            throw new Error(`PDF file not found: ${pdfPath}`);
        }

        const data = new Uint8Array(fs.readFileSync(pdfPath));
        const loadingTask = this.pdfjsLib.getDocument({ data });
        const pdfDoc = await loadingTask.promise;

        const pageMap = new Map<number, PositionedText[]>();
        const dimensionsMap = new Map<number, PageDimensions>();

        for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
            const page = await pdfDoc.getPage(pageNum);
            const viewport = page.getViewport({ scale: 1.0 });
            
            // Store page dimensions
            dimensionsMap.set(pageNum, {
                width: viewport.width,
                height: viewport.height,
                rotation: viewport.rotation
            });

            const textContent = await page.getTextContent({
                normalizeWhitespace: true,
                disableCombineTextItems: false
            });

            const positionedTexts: PositionedText[] = [];

            for (const item of textContent.items as PDFTextItem[]) {
                if (!item.str || item.str.trim() === '') continue;

                // Extract position from transform matrix
                // transform = [scaleX, skewX, skewY, scaleY, translateX, translateY]
                const transform = item.transform;
                const x = transform[4];
                const y = transform[5];
                
                // Calculate dimensions considering scale
                const scaleX = Math.abs(transform[0]);
                const scaleY = Math.abs(transform[3]);
                const width = item.width * scaleX;
                const height = item.height || (12 * scaleY); // Default font size if not provided

                // Convert to top-left origin (PDF uses bottom-left)
                const rect: BoundingRect = {
                    x: x,
                    y: viewport.height - y - height,
                    width: width,
                    height: height
                };

                positionedTexts.push({
                    text: item.str,
                    pageNumber: pageNum,
                    rects: [rect]
                });
            }

            pageMap.set(pageNum, positionedTexts);
        }

        // Cache results
        this.pageCache.set(pdfPath, pageMap);
        this.dimensionsCache.set(pdfPath, dimensionsMap);

        return pageMap;
    }

    /**
     * Get page dimensions for a PDF
     */
    async getPageDimensions(pdfPath: string, pageNumber: number): Promise<PageDimensions | undefined> {
        if (!this.dimensionsCache.has(pdfPath)) {
            await this.extractTextWithPositions(pdfPath);
        }
        return this.dimensionsCache.get(pdfPath)?.get(pageNumber);
    }

    /**
     * Find bounding boxes for a specific text passage within a page
     */
    async findTextBoundingBoxes(
        pdfPath: string,
        pageNumber: number,
        searchText: string,
        fuzzyMatch: boolean = true
    ): Promise<BoundingRect[]> {
        const pageMap = await this.extractTextWithPositions(pdfPath);
        const pageTexts = pageMap.get(pageNumber);

        if (!pageTexts || pageTexts.length === 0) {
            return [];
        }

        const results: BoundingRect[] = [];
        const normalizedSearch = this.normalizeText(searchText);

        // Build full page text and track positions
        let fullText = '';
        const textSpans: Array<{ start: number; end: number; rect: BoundingRect }> = [];

        for (const item of pageTexts) {
            const start = fullText.length;
            fullText += item.text;
            const end = fullText.length;

            textSpans.push({
                start,
                end,
                rect: item.rects[0]
            });

            // Add space between items
            fullText += ' ';
        }

        const normalizedFullText = this.normalizeText(fullText);

        // Find matches
        let searchIndex = 0;
        while (true) {
            const matchIndex = fuzzyMatch
                ? this.fuzzyIndexOf(normalizedFullText, normalizedSearch, searchIndex)
                : normalizedFullText.indexOf(normalizedSearch, searchIndex);

            if (matchIndex === -1) break;

            const matchEnd = matchIndex + normalizedSearch.length;

            // Find all text spans that overlap with this match
            for (const span of textSpans) {
                if (span.start < matchEnd && span.end > matchIndex) {
                    results.push(span.rect);
                }
            }

            searchIndex = matchIndex + 1;
        }

        return this.mergeAdjacentRects(results);
    }

    /**
     * Map a document chunk to its PDF positions
     */
    async mapChunkToPositions(
        pdfPath: string,
        chunkText: string,
        pageNumber: number,
        chunkId: string,
        documentId: string
    ): Promise<ChunkPositionMap | null> {
        const boxes = await this.findTextBoundingBoxes(pdfPath, pageNumber, chunkText);

        if (boxes.length === 0) {
            // Try with a shorter snippet (first 100 chars)
            const snippet = chunkText.substring(0, 100);
            const snippetBoxes = await this.findTextBoundingBoxes(pdfPath, pageNumber, snippet);
            
            if (snippetBoxes.length === 0) {
                return null;
            }

            return {
                chunkId,
                documentId,
                pageNumber,
                textContent: chunkText,
                boundingRects: snippetBoxes,
                startIndex: 0,
                endIndex: chunkText.length
            };
        }

        return {
            chunkId,
            documentId,
            pageNumber,
            textContent: chunkText,
            boundingRects: boxes,
            startIndex: 0,
            endIndex: chunkText.length
        };
    }

    /**
     * Find the best matching page for a text chunk
     */
    async findBestMatchingPage(
        pdfPath: string,
        chunkText: string,
        hintPageNumber?: number
    ): Promise<{ pageNumber: number; score: number } | null> {
        const pageMap = await this.extractTextWithPositions(pdfPath);
        const normalizedChunk = this.normalizeText(chunkText.substring(0, 200));

        let bestPage = hintPageNumber || 1;
        let bestScore = 0;

        // If we have a hint, check that page first
        if (hintPageNumber) {
            const hintTexts = pageMap.get(hintPageNumber);
            if (hintTexts) {
                const pageText = this.normalizeText(hintTexts.map(t => t.text).join(' '));
                const score = this.calculateMatchScore(pageText, normalizedChunk);
                if (score > 0.8) {
                    return { pageNumber: hintPageNumber, score };
                }
                bestScore = score;
            }
        }

        // Search all pages
        for (const [pageNum, texts] of pageMap) {
            if (pageNum === hintPageNumber) continue;

            const pageText = this.normalizeText(texts.map(t => t.text).join(' '));
            const score = this.calculateMatchScore(pageText, normalizedChunk);

            if (score > bestScore) {
                bestScore = score;
                bestPage = pageNum;
            }
        }

        if (bestScore < 0.3) {
            return null;
        }

        return { pageNumber: bestPage, score: bestScore };
    }

    /**
     * Normalize text for comparison
     */
    private normalizeText(text: string): string {
        return text
            .toLowerCase()
            .replace(/[\r\n]+/g, ' ')
            .replace(/\s+/g, ' ')
            .replace(/[^\w\s]/g, '')
            .trim();
    }

    /**
     * Fuzzy string search that tolerates whitespace/punctuation differences
     */
    private fuzzyIndexOf(haystack: string, needle: string, startIndex: number): number {
        // Simple approach: try exact match first
        const exactIndex = haystack.indexOf(needle, startIndex);
        if (exactIndex !== -1) return exactIndex;

        // Try matching with tolerance for spacing
        const needleWords = needle.split(/\s+/).filter(w => w.length > 2);
        if (needleWords.length < 2) return -1;

        // Find first word
        const firstWord = needleWords[0];
        let searchPos = startIndex;

        while (searchPos < haystack.length) {
            const wordStart = haystack.indexOf(firstWord, searchPos);
            if (wordStart === -1) return -1;

            // Check if subsequent words follow reasonably close
            let matchPos = wordStart;
            let allFound = true;

            for (const word of needleWords) {
                const nextPos = haystack.indexOf(word, matchPos);
                if (nextPos === -1 || nextPos - matchPos > word.length + 50) {
                    allFound = false;
                    break;
                }
                matchPos = nextPos + word.length;
            }

            if (allFound) return wordStart;
            searchPos = wordStart + 1;
        }

        return -1;
    }

    /**
     * Calculate similarity score between two texts
     */
    private calculateMatchScore(text1: string, text2: string): number {
        const words1 = new Set(text1.split(/\s+/));
        const words2 = new Set(text2.split(/\s+/));

        let intersection = 0;
        for (const word of words2) {
            if (words1.has(word)) intersection++;
        }

        const union = new Set([...words1, ...words2]).size;
        return union > 0 ? intersection / union : 0;
    }

    /**
     * Merge adjacent/overlapping bounding rectangles
     */
    private mergeAdjacentRects(rects: BoundingRect[]): BoundingRect[] {
        if (rects.length <= 1) return rects;

        // Sort by y then x
        const sorted = [...rects].sort((a, b) => {
            const yDiff = a.y - b.y;
            return Math.abs(yDiff) < 5 ? a.x - b.x : yDiff;
        });

        const merged: BoundingRect[] = [];
        let current = { ...sorted[0] };

        for (let i = 1; i < sorted.length; i++) {
            const rect = sorted[i];

            // Check if on same line and adjacent
            const sameLine = Math.abs(rect.y - current.y) < 5;
            const adjacent = rect.x <= current.x + current.width + 10;

            if (sameLine && adjacent) {
                // Extend current rect
                const newRight = Math.max(current.x + current.width, rect.x + rect.width);
                current.width = newRight - current.x;
                current.height = Math.max(current.height, rect.height);
            } else {
                merged.push(current);
                current = { ...rect };
            }
        }
        merged.push(current);

        return merged;
    }

    /**
     * Clear cache for a specific document or all documents
     */
    clearCache(pdfPath?: string): void {
        if (pdfPath) {
            this.pageCache.delete(pdfPath);
            this.dimensionsCache.delete(pdfPath);
        } else {
            this.pageCache.clear();
            this.dimensionsCache.clear();
        }
    }

    /**
     * Convert PDF coordinates to normalized 0-1 range for viewer compatibility
     */
    normalizeCoordinates(rect: BoundingRect, pageWidth: number, pageHeight: number): BoundingRect {
        return {
            x: rect.x / pageWidth,
            y: rect.y / pageHeight,
            width: rect.width / pageWidth,
            height: rect.height / pageHeight
        };
    }

    /**
     * Get highlight annotation data for PDF viewer
     */
    async getHighlightAnnotation(
        pdfPath: string,
        pageNumber: number,
        text: string,
        color: string = 'yellow'
    ): Promise<{
        page: number;
        rects: BoundingRect[];
        normalizedRects: BoundingRect[];
        color: string;
    } | null> {
        const rects = await this.findTextBoundingBoxes(pdfPath, pageNumber, text);
        if (rects.length === 0) return null;

        const dimensions = await this.getPageDimensions(pdfPath, pageNumber);
        if (!dimensions) return null;

        const normalizedRects = rects.map(r => 
            this.normalizeCoordinates(r, dimensions.width, dimensions.height)
        );

        return {
            page: pageNumber,
            rects,
            normalizedRects,
            color
        };
    }
}
