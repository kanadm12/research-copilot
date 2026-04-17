import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DocumentStore, DocumentMetadata, DocumentChunk, DocumentImage } from './documentStore';
import { ImageExtractor } from './imageExtractor';
import { TextChunker } from './textChunker';
import { DocxConverter, DocxConversionResult } from './docxConverter';

// Use pdf-parse for Node.js environment (simpler and doesn't require workers)
const pdfParse = require('pdf-parse');

export class PdfIndexer {
    private documentStore: DocumentStore;
    private imageExtractor: ImageExtractor;
    private textChunker: TextChunker;
    private docxConverter: DocxConverter;
    private context: vscode.ExtensionContext;

    constructor(documentStore: DocumentStore, context: vscode.ExtensionContext) {
        this.documentStore = documentStore;
        this.context = context;
        this.imageExtractor = new ImageExtractor(context);
        this.textChunker = new TextChunker();
        this.docxConverter = new DocxConverter(context);
    }

    async indexPdf(filePath: string): Promise<DocumentMetadata> {
        // Check file exists
        if (!fs.existsSync(filePath)) {
            throw new Error(`PDF file not found: ${filePath}`);
        }

        const config = vscode.workspace.getConfiguration('researchCopilot');
        const maxSizeMB = config.get<number>('maxPdfSizeMB', 50);

        // Check file size
        const stats = fs.statSync(filePath);
        const sizeMB = stats.size / (1024 * 1024);
        
        if (sizeMB > maxSizeMB) {
            throw new Error(`PDF file size (${sizeMB.toFixed(1)}MB) exceeds maximum allowed (${maxSizeMB}MB)`);
        }

        console.log(`Indexing PDF: ${filePath}`);

        // Check if we should use DOCX conversion (better for images and tables)
        const useDocxConversion = config.get<boolean>('useDocxConversion', false);
        if (useDocxConversion && await this.docxConverter.checkPdf2DocxAvailable()) {
            return this.indexPdfViaDocx(filePath, stats);
        }

        // Fallback to direct PDF parsing
        return this.indexPdfDirect(filePath, stats);
    }

    /**
     * Index PDF by first converting to DOCX (better for images and complex layouts)
     */
    private async indexPdfViaDocx(filePath: string, stats: fs.Stats): Promise<DocumentMetadata> {
        console.log(`Using DOCX conversion for: ${filePath}`);
        
        const conversionResult = await this.docxConverter.convertAndExtract(filePath);
        
        const metadata: DocumentMetadata = {
            id: this.generateId(),
            name: path.basename(filePath),
            path: filePath,
            pageCount: conversionResult.pageCount,
            indexedAt: new Date().toISOString(),
            fileSize: stats.size,
            chunks: [],
            images: [],
            summary: '',
            docxPath: conversionResult.docxPath
        };

        const fullText = this.cleanText(conversionResult.text);
        
        // Create page text map (estimated since DOCX doesn't have true pages)
        const pageTexts = this.estimatePageBreaks(fullText, metadata.pageCount);

        // Create text chunks for semantic search
        metadata.chunks = this.textChunker.chunkText(fullText, pageTexts, metadata.id);

        // Convert extracted images to DocumentImage format
        metadata.images = conversionResult.images.map((img, index) => ({
            id: `${metadata.id}_img_${index}`,
            documentId: metadata.id,
            pageNumber: img.pageNumber || 1,
            path: img.path,
            width: 0,  // Not available from DOCX extraction
            height: 0, // Not available from DOCX extraction
            description: img.altText,
            ocrText: ''
        }));

        // Generate summary
        metadata.summary = this.generateSmartSummary(fullText, {});

        // Save extracted content (now as DOCX-sourced markdown)
        await this.saveExtractedContent(metadata, fullText, pageTexts);

        // Store in document store
        await this.documentStore.addDocument(metadata);

        console.log(`Successfully indexed via DOCX: ${filePath} (${metadata.chunks.length} chunks, ${metadata.images.length} images)`);

        return metadata;
    }

    /**
     * Estimate page breaks in text based on expected page count
     */
    private estimatePageBreaks(text: string, pageCount: number): Map<number, string> {
        const pageTexts = new Map<number, string>();
        const avgCharsPerPage = Math.max(text.length / pageCount, 100);
        
        for (let i = 1; i <= pageCount; i++) {
            const start = Math.floor((i - 1) * avgCharsPerPage);
            const end = Math.floor(i * avgCharsPerPage);
            pageTexts.set(i, text.substring(start, end));
        }
        
        return pageTexts;
    }

    /**
     * Index PDF directly using pdf-parse (original method)
     */
    private async indexPdfDirect(filePath: string, stats: fs.Stats): Promise<DocumentMetadata> {
        // Load and parse the PDF using pdf-parse with custom page render
        const dataBuffer = fs.readFileSync(filePath);
        
        // Collect text per page
        const pageTexts: Map<number, string> = new Map();
        let currentPage = 0;
        
        // Custom render function to capture page-by-page text
        const renderPage = (pageData: any) => {
            return pageData.getTextContent({
                normalizeWhitespace: true,
                disableCombineTextItems: false
            }).then((textContent: any) => {
                currentPage++;
                let pageText = '';
                let lastY = -1;
                
                for (const item of textContent.items) {
                    // Add newline when Y position changes significantly (new line)
                    if (lastY !== -1 && Math.abs(item.transform[5] - lastY) > 5) {
                        pageText += '\n';
                    }
                    pageText += item.str;
                    // Add space between items on the same line
                    if (item.str && !item.str.endsWith(' ')) {
                        pageText += ' ';
                    }
                    lastY = item.transform[5];
                }
                
                pageTexts.set(currentPage, this.cleanText(pageText));
                return pageText;
            });
        };

        const pdfData = await pdfParse(dataBuffer, {
            pagerender: renderPage,
            max: 0 // no limit on pages
        });

        const metadata: DocumentMetadata = {
            id: this.generateId(),
            name: path.basename(filePath),
            path: filePath,
            pageCount: pdfData.numpages,
            indexedAt: new Date().toISOString(),
            fileSize: stats.size,
            chunks: [],
            images: [],
            summary: ''
        };

        // Get full cleaned text
        const fullText = this.cleanText(pdfData.text || '');
        
        // If page-by-page extraction failed, do a simple split
        if (pageTexts.size === 0 || pageTexts.size < pdfData.numpages) {
            const avgCharsPerPage = Math.max(fullText.length / pdfData.numpages, 100);
            for (let i = 1; i <= pdfData.numpages; i++) {
                const start = Math.floor((i - 1) * avgCharsPerPage);
                const end = Math.floor(i * avgCharsPerPage);
                pageTexts.set(i, fullText.substring(start, end));
            }
        }

        // Create text chunks for semantic search
        metadata.chunks = this.textChunker.chunkText(fullText, pageTexts, metadata.id);

        // Generate a better summary
        metadata.summary = this.generateSmartSummary(fullText, pdfData.info);

        // Save extracted content to a markdown file for easy viewing
        await this.saveExtractedContent(metadata, fullText, pageTexts);

        // Store in document store
        await this.documentStore.addDocument(metadata);

        console.log(`Successfully indexed: ${filePath} (${metadata.chunks.length} chunks, ${pageTexts.size} pages)`);

        return metadata;
    }

    /**
     * Clean extracted text by fixing common PDF extraction issues
     */
    private cleanText(text: string): string {
        return text
            // Fix hyphenated words at line breaks
            .replace(/(\w)-\n(\w)/g, '$1$2')
            // Replace multiple newlines with double newline (paragraph break)
            .replace(/\n{3,}/g, '\n\n')
            // Replace single newlines within paragraphs with spaces
            .replace(/([^\n])\n([^\n])/g, '$1 $2')
            // Fix multiple spaces
            .replace(/[ \t]+/g, ' ')
            // Fix ligatures
            .replace(/ﬁ/g, 'fi')
            .replace(/ﬂ/g, 'fl')
            .replace(/ﬀ/g, 'ff')
            .replace(/ﬃ/g, 'ffi')
            .replace(/ﬄ/g, 'ffl')
            // Remove page numbers that appear alone
            .replace(/^\s*\d+\s*$/gm, '')
            // Trim each line
            .split('\n').map(line => line.trim()).join('\n')
            // Final trim
            .trim();
    }

    /**
     * Generate a smarter summary using the document structure
     */
    private generateSmartSummary(text: string, pdfInfo: any): string {
        // Try to find abstract
        const abstractMatch = text.match(/(?:abstract|summary)[:\s]*\n?([\s\S]{100,1000}?)(?:\n\n|introduction|keywords|1\.|1\s)/i);
        if (abstractMatch) {
            return this.cleanText(abstractMatch[1]).substring(0, 600);
        }

        // Try to find introduction first paragraph
        const introMatch = text.match(/(?:introduction|1\.?\s*introduction)[:\s]*\n?([\s\S]{100,800}?)(?:\n\n|\d+\.)/i);
        if (introMatch) {
            return this.cleanText(introMatch[1]).substring(0, 600);
        }

        // Fallback: extract first meaningful paragraph
        const cleaned = this.cleanText(text);
        const paragraphs = cleaned.split('\n\n').filter(p => p.length > 50);
        
        // Skip headers and short lines, find first substantial paragraph
        for (const para of paragraphs.slice(0, 5)) {
            if (para.length > 100 && !para.match(/^[\d\s.]+$/) && para.split(' ').length > 15) {
                return para.substring(0, 600) + (para.length > 600 ? '...' : '');
            }
        }

        // Last resort: just take the beginning
        return cleaned.substring(0, 500) + '...';
    }

    private generateBasicSummary(text: string): string {
        // Extract first meaningful paragraph or ~500 characters
        const cleaned = text.replace(/\s+/g, ' ').trim();
        const sentences = cleaned.split(/[.!?]+/).filter(s => s.trim().length > 20);
        
        let summary = '';
        for (const sentence of sentences) {
            if (summary.length + sentence.length > 500) break;
            summary += sentence.trim() + '. ';
        }
        
        return summary.trim() || cleaned.substring(0, 500) + '...';
    }

    private async saveExtractedContent(
        metadata: DocumentMetadata, 
        fullText: string, 
        pageTexts: Map<number, string>
    ): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return;

        const config = vscode.workspace.getConfiguration('researchCopilot');
        const indexPath = config.get<string>('indexPath', '.research-copilot');
        
        const outputDir = path.join(workspaceFolder.uri.fsPath, indexPath, 'extracted');
        
        // Ensure directory exists
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // Create markdown file with extracted content
        const mdFileName = metadata.name.replace('.pdf', '.md');
        const mdPath = path.join(outputDir, mdFileName);

        let content = `# ${metadata.name}\n\n`;
        content += `> **Indexed:** ${metadata.indexedAt}\n`;
        content += `> **Pages:** ${metadata.pageCount}\n`;
        content += `> **File Size:** ${(metadata.fileSize / 1024).toFixed(1)} KB\n\n`;
        content += `---\n\n`;
        content += `## Summary\n\n${metadata.summary}\n\n`;
        content += `---\n\n`;
        content += `## Full Content\n\n`;

        // Add content by page
        for (let pageNum = 1; pageNum <= metadata.pageCount; pageNum++) {
            const pageText = pageTexts.get(pageNum);
            if (pageText) {
                content += `### Page ${pageNum}\n\n${pageText}\n\n`;
            }
        }

        // Add image references
        if (metadata.images.length > 0) {
            content += `---\n\n## Images\n\n`;
            for (const img of metadata.images) {
                content += `### Image from Page ${img.pageNumber}\n\n`;
                content += `![${img.description || 'Image'}](${img.path})\n\n`;
                if (img.ocrText) {
                    content += `**OCR Text:** ${img.ocrText}\n\n`;
                }
            }
        }

        fs.writeFileSync(mdPath, content, 'utf8');
        metadata.extractedPath = mdPath;
    }

    private generateId(): string {
        return 'doc_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
    }

    async reindexDocument(documentId: string): Promise<DocumentMetadata | null> {
        const doc = this.documentStore.getDocument(documentId);
        if (!doc) return null;

        // Remove old data
        await this.documentStore.removeDocument(doc.path);

        // Re-index
        return this.indexPdf(doc.path);
    }

    /**
     * Dispose of resources
     */
    async dispose(): Promise<void> {
        try {
            await this.imageExtractor.cleanup();
        } catch (error) {
            console.error('Error disposing imageExtractor:', error);
        }
    }
}
