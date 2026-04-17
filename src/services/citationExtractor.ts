/**
 * CitationExtractor - Extracts and parses academic citations from documents
 * 
 * Supports multiple citation formats:
 * - APA: (Author, Year) or (Author, Year, p. X)
 * - MLA: (Author Page)
 * - IEEE: [1], [2], [1-3]
 * - Harvard: (Author Year)
 * - Chicago: Footnotes or (Author Year)
 * - Vancouver: Superscript numbers or (1), (2)
 * 
 * Also extracts reference lists from the end of documents
 */

export interface Citation {
    id: string;
    type: CitationType;
    rawText: string;
    authors: string[];
    year?: number;
    title?: string;
    source?: string;  // Journal, book, etc.
    volume?: string;
    issue?: string;
    pages?: string;
    doi?: string;
    url?: string;
    position: {
        start: number;
        end: number;
        pageNumber?: number;
    };
    confidence: number;  // 0-1 confidence score
}

export type CitationType = 
    | 'apa'
    | 'mla' 
    | 'ieee'
    | 'harvard'
    | 'chicago'
    | 'vancouver'
    | 'reference'
    | 'unknown';

export interface CitationExtractionResult {
    inTextCitations: Citation[];
    references: Citation[];
    citationStyle: CitationType;
    statistics: {
        totalCitations: number;
        uniqueReferences: number;
        citationsByAuthor: Map<string, number>;
        citationsByYear: Map<number, number>;
    };
}

export class CitationExtractor {
    // Regex patterns for different citation formats
    private patterns = {
        // APA: (Smith, 2020) or (Smith & Jones, 2020) or (Smith et al., 2020)
        apa: /\(([A-Z][a-zA-Z\-']+(?:\s+(?:&|and)\s+[A-Z][a-zA-Z\-']+)?(?:\s+et\s+al\.)?),?\s*(\d{4})[a-z]?(?:,\s*pp?\.\s*[\d\-]+)?\)/g,
        
        // MLA: (Smith 45) or (Smith and Jones 45-50)
        mla: /\(([A-Z][a-zA-Z\-']+(?:\s+and\s+[A-Z][a-zA-Z\-']+)?)\s+(\d+(?:-\d+)?)\)/g,
        
        // IEEE: [1] or [1, 2] or [1-5]
        ieee: /\[(\d+(?:[-,]\s*\d+)*)\]/g,
        
        // Harvard: (Smith 2020) or (Smith & Jones 2020)
        harvard: /\(([A-Z][a-zA-Z\-']+(?:\s*[&,]\s*[A-Z][a-zA-Z\-']+)*)\s+(\d{4})[a-z]?\)/g,
        
        // Vancouver: superscript or (1) format  
        vancouver: /(?:\^(\d+)|\((\d+)\)(?!\s*\())/g,

        // DOI pattern
        doi: /\b(10\.\d{4,}\/[^\s]+)\b/g,
        
        // URL pattern
        url: /https?:\/\/[^\s<>"\)]+/g
    };

    // Reference list patterns
    private referencePatterns = {
        // Numbered reference: 1. Author, A. (2020). Title...
        numbered: /^(\d+)[.\)]\s*(.+)$/gm,
        
        // APA reference: Author, A. A. (2020). Title. Journal, 1(2), 3-4.
        apaReference: /^([A-Z][a-zA-Z\-']+(?:,\s*[A-Z]\.(?:\s*[A-Z]\.)*)?(?:,?\s*(?:&|and)\s*[A-Z][a-zA-Z\-']+(?:,\s*[A-Z]\.(?:\s*[A-Z]\.)*)?)*(?:,?\s*et\s+al\.)?)\s*\((\d{4})\)\.\s*(.+?)(?:\.\s*([^.]+?))?(?:,\s*(\d+)(?:\((\d+)\))?)?(?:,\s*([\d\-]+))?\./gm,
        
        // MLA reference: Author. "Title." Source, vol. X, no. Y, Year, pp. Z.
        mlaReference: /^([A-Z][a-zA-Z\-']+(?:,\s*[A-Za-z]+)*)\.\s*["""](.+?)["""]\.\s*(.+?),\s*(?:vol\.\s*)?(\d+)?(?:,\s*no\.\s*(\d+))?,?\s*(\d{4})(?:,\s*pp?\.\s*([\d\-]+))?/gm
    };

    /**
     * Extract all citations from document text
     */
    extractCitations(text: string, pageNumber?: number): CitationExtractionResult {
        const inTextCitations: Citation[] = [];
        const references: Citation[] = [];
        
        // Detect citation style
        const citationStyle = this.detectCitationStyle(text);
        
        // Extract in-text citations based on detected style
        inTextCitations.push(...this.extractInTextCitations(text, citationStyle, pageNumber));
        
        // Extract reference list
        references.push(...this.extractReferences(text));
        
        // Extract DOIs and URLs from references
        this.enrichReferencesWithMetadata(references, text);
        
        // Build statistics
        const statistics = this.buildStatistics(inTextCitations, references);
        
        return {
            inTextCitations,
            references,
            citationStyle,
            statistics
        };
    }

    /**
     * Detect the predominant citation style in the document
     */
    detectCitationStyle(text: string): CitationType {
        const counts: Record<CitationType, number> = {
            apa: 0,
            mla: 0,
            ieee: 0,
            harvard: 0,
            chicago: 0,
            vancouver: 0,
            reference: 0,
            unknown: 0
        };

        // Count matches for each style
        counts.apa = (text.match(this.patterns.apa) || []).length;
        counts.ieee = (text.match(this.patterns.ieee) || []).length;
        counts.harvard = (text.match(this.patterns.harvard) || []).length;
        counts.mla = (text.match(this.patterns.mla) || []).length;
        
        // Find the style with most matches
        let maxCount = 0;
        let detectedStyle: CitationType = 'unknown';
        
        for (const [style, count] of Object.entries(counts)) {
            if (count > maxCount) {
                maxCount = count;
                detectedStyle = style as CitationType;
            }
        }

        return detectedStyle;
    }

    /**
     * Extract in-text citations
     */
    private extractInTextCitations(
        text: string, 
        style: CitationType,
        pageNumber?: number
    ): Citation[] {
        const citations: Citation[] = [];
        let pattern: RegExp;
        
        switch (style) {
            case 'apa':
            case 'harvard':
                pattern = this.patterns.apa;
                break;
            case 'ieee':
                pattern = this.patterns.ieee;
                break;
            case 'mla':
                pattern = this.patterns.mla;
                break;
            default:
                // Try all patterns
                citations.push(...this.extractWithPattern(text, this.patterns.apa, 'apa', pageNumber));
                citations.push(...this.extractWithPattern(text, this.patterns.ieee, 'ieee', pageNumber));
                return citations;
        }

        return this.extractWithPattern(text, pattern, style, pageNumber);
    }

    private extractWithPattern(
        text: string, 
        pattern: RegExp, 
        style: CitationType,
        pageNumber?: number
    ): Citation[] {
        const citations: Citation[] = [];
        let match;
        
        // Reset regex
        pattern.lastIndex = 0;
        
        while ((match = pattern.exec(text)) !== null) {
            const citation = this.parseCitation(match, style, pageNumber);
            if (citation) {
                citations.push(citation);
            }
        }

        return citations;
    }

    private parseCitation(
        match: RegExpExecArray, 
        style: CitationType,
        pageNumber?: number
    ): Citation | null {
        const rawText = match[0];
        const position = {
            start: match.index,
            end: match.index + rawText.length,
            pageNumber
        };

        switch (style) {
            case 'apa':
            case 'harvard': {
                const authorPart = match[1];
                const year = parseInt(match[2], 10);
                const authors = this.parseAuthors(authorPart);
                
                return {
                    id: this.generateId(),
                    type: style,
                    rawText,
                    authors,
                    year,
                    position,
                    confidence: 0.9
                };
            }
            
            case 'ieee': {
                // IEEE citations are just numbers, we link them to references later
                return {
                    id: this.generateId(),
                    type: 'ieee',
                    rawText,
                    authors: [],
                    position,
                    confidence: 0.95
                };
            }
            
            case 'mla': {
                const authorPart = match[1];
                const pages = match[2];
                const authors = this.parseAuthors(authorPart);
                
                return {
                    id: this.generateId(),
                    type: 'mla',
                    rawText,
                    authors,
                    pages,
                    position,
                    confidence: 0.85
                };
            }
            
            default:
                return null;
        }
    }

    /**
     * Extract reference list from document
     */
    private extractReferences(text: string): Citation[] {
        const references: Citation[] = [];
        
        // Find reference section
        const refSectionMatch = text.match(
            /(?:References|Bibliography|Works\s+Cited|Literature\s+Cited)\s*\n([\s\S]*?)(?:\n\n\n|\n(?=[A-Z][a-z]+\s+\d)|$)/i
        );
        
        const refSection = refSectionMatch ? refSectionMatch[1] : text;
        
        // Try numbered references
        let match;
        const numberedPattern = /^[\[\(]?(\d+)[\]\)\.]?\s*([A-Z][^.]*?\(\d{4}\)[^]*?)(?=\n[\[\(]?\d+[\]\)\.]|\n\n|$)/gm;
        
        while ((match = numberedPattern.exec(refSection)) !== null) {
            const ref = this.parseReference(match[2], parseInt(match[1]));
            if (ref) {
                references.push(ref);
            }
        }

        // Try APA-style references if no numbered ones found
        if (references.length === 0) {
            const apaPattern = /^([A-Z][a-zA-Z\-']+(?:,\s*[A-Z]\.(?:\s*[A-Z]\.)*)?(?:(?:,\s*&?\s*|\s+(?:&|and)\s+)[A-Z][a-zA-Z\-']+(?:,\s*[A-Z]\.(?:\s*[A-Z]\.)*)?)*)\s*\((\d{4})\)\.\s*([^.]+)\./gm;
            
            while ((match = apaPattern.exec(refSection)) !== null) {
                references.push({
                    id: this.generateId(),
                    type: 'reference',
                    rawText: match[0],
                    authors: this.parseAuthors(match[1]),
                    year: parseInt(match[2]),
                    title: match[3].trim(),
                    position: {
                        start: match.index,
                        end: match.index + match[0].length
                    },
                    confidence: 0.85
                });
            }
        }

        return references;
    }

    private parseReference(text: string, refNumber?: number): Citation | null {
        // Try to parse as APA format
        const apaMatch = text.match(
            /([A-Z][a-zA-Z\-']+(?:,\s*[A-Z]\.(?:\s*[A-Z]\.)*)?(?:[,&\s]+[A-Z][a-zA-Z\-']+(?:,\s*[A-Z]\.(?:\s*[A-Z]\.)*)?)*)\s*\((\d{4})\)\.\s*([^.]+)/
        );

        if (apaMatch) {
            return {
                id: this.generateId(),
                type: 'reference',
                rawText: text,
                authors: this.parseAuthors(apaMatch[1]),
                year: parseInt(apaMatch[2]),
                title: apaMatch[3].trim(),
                position: { start: 0, end: text.length },
                confidence: 0.8
            };
        }

        return null;
    }

    /**
     * Parse author names from citation text
     */
    private parseAuthors(authorText: string): string[] {
        // Remove "et al."
        let cleaned = authorText.replace(/\s*et\s+al\.?\s*/gi, '');
        
        // Split by common separators
        const authors = cleaned
            .split(/\s*(?:,|&|and)\s*/i)
            .map(a => a.trim())
            .filter(a => a.length > 0 && /^[A-Z]/.test(a));
        
        return authors;
    }

    /**
     * Enrich references with DOIs and URLs
     */
    private enrichReferencesWithMetadata(references: Citation[], fullText: string): void {
        // Find all DOIs
        const doiMatches = fullText.matchAll(this.patterns.doi);
        const dois = Array.from(doiMatches).map(m => m[1]);
        
        // Find all URLs
        const urlMatches = fullText.matchAll(this.patterns.url);
        const urls = Array.from(urlMatches).map(m => m[0]);
        
        // Try to match DOIs/URLs to references based on proximity
        for (const ref of references) {
            // Look for DOI in reference text
            const doiMatch = ref.rawText.match(this.patterns.doi);
            if (doiMatch) {
                ref.doi = doiMatch[1];
            }
            
            // Look for URL in reference text
            const urlMatch = ref.rawText.match(this.patterns.url);
            if (urlMatch) {
                ref.url = urlMatch[0];
            }
        }
    }

    /**
     * Build statistics about citations
     */
    private buildStatistics(
        inTextCitations: Citation[], 
        references: Citation[]
    ): CitationExtractionResult['statistics'] {
        const citationsByAuthor = new Map<string, number>();
        const citationsByYear = new Map<number, number>();
        
        for (const citation of inTextCitations) {
            // Count by author
            for (const author of citation.authors) {
                const count = citationsByAuthor.get(author) || 0;
                citationsByAuthor.set(author, count + 1);
            }
            
            // Count by year
            if (citation.year) {
                const count = citationsByYear.get(citation.year) || 0;
                citationsByYear.set(citation.year, count + 1);
            }
        }

        return {
            totalCitations: inTextCitations.length,
            uniqueReferences: references.length,
            citationsByAuthor,
            citationsByYear
        };
    }

    /**
     * Link in-text citations to their references
     */
    linkCitationsToReferences(
        citations: Citation[], 
        references: Citation[]
    ): Map<string, Citation> {
        const links = new Map<string, Citation>();
        
        for (const citation of citations) {
            // For IEEE style, match by number
            if (citation.type === 'ieee') {
                const nums = citation.rawText.match(/\d+/g);
                if (nums) {
                    for (const num of nums) {
                        const refIndex = parseInt(num) - 1;
                        if (refIndex >= 0 && refIndex < references.length) {
                            links.set(citation.id, references[refIndex]);
                        }
                    }
                }
                continue;
            }
            
            // For author-year styles, match by author and year
            for (const ref of references) {
                const authorMatch = citation.authors.some(a => 
                    ref.authors.some(ra => 
                        ra.toLowerCase().includes(a.toLowerCase()) ||
                        a.toLowerCase().includes(ra.split(',')[0].toLowerCase())
                    )
                );
                
                const yearMatch = citation.year === ref.year;
                
                if (authorMatch && yearMatch) {
                    links.set(citation.id, ref);
                    break;
                }
            }
        }

        return links;
    }

    /**
     * Format citation for display
     */
    formatCitation(citation: Citation): string {
        let formatted = '';
        
        if (citation.authors.length > 0) {
            if (citation.authors.length === 1) {
                formatted = citation.authors[0];
            } else if (citation.authors.length === 2) {
                formatted = `${citation.authors[0]} & ${citation.authors[1]}`;
            } else {
                formatted = `${citation.authors[0]} et al.`;
            }
        }
        
        if (citation.year) {
            formatted += ` (${citation.year})`;
        }
        
        if (citation.title) {
            formatted += `. ${citation.title}`;
        }
        
        return formatted || citation.rawText;
    }

    /**
     * Export citations to BibTeX format
     */
    toBibTeX(citations: Citation[]): string {
        let bibtex = '';
        
        for (const citation of citations) {
            if (citation.type !== 'reference') continue;
            
            const key = this.generateBibKey(citation);
            bibtex += `@article{${key},\n`;
            
            if (citation.authors.length > 0) {
                bibtex += `  author = {${citation.authors.join(' and ')}},\n`;
            }
            if (citation.title) {
                bibtex += `  title = {${citation.title}},\n`;
            }
            if (citation.year) {
                bibtex += `  year = {${citation.year}},\n`;
            }
            if (citation.source) {
                bibtex += `  journal = {${citation.source}},\n`;
            }
            if (citation.volume) {
                bibtex += `  volume = {${citation.volume}},\n`;
            }
            if (citation.pages) {
                bibtex += `  pages = {${citation.pages}},\n`;
            }
            if (citation.doi) {
                bibtex += `  doi = {${citation.doi}},\n`;
            }
            
            bibtex += '}\n\n';
        }

        return bibtex;
    }

    private generateBibKey(citation: Citation): string {
        const author = citation.authors[0]?.split(/[,\s]/)[0]?.toLowerCase() || 'unknown';
        const year = citation.year || 'nd';
        return `${author}${year}`;
    }

    private generateId(): string {
        return 'cit_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    }
}
