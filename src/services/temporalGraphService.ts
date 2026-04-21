import * as vscode from 'vscode';
import { DocumentStore, DocumentMetadata } from './documentStore';
import { KnowledgeGraphService, GraphNode, GraphEdge, KnowledgeGraph } from './knowledgeGraphService';
import { CitationExtractor } from './citationExtractor';

/**
 * Temporal node extends GraphNode with time-related fields
 */
export interface TemporalNode extends GraphNode {
    // Publication/creation date
    publishedYear?: number;
    publishedDate?: string;  // ISO date string for precise ordering
    // When this node was cited by others
    citedByYears?: number[];
    // Temporal importance score (higher = more foundational/influential)
    temporalInfluence?: number;
}

/**
 * Temporal edge with timing information
 */
export interface TemporalEdge extends GraphEdge {
    // When the citation relationship was established
    year?: number;
    // Time difference between source and target (negative = source is older)
    yearDelta?: number;
}

/**
 * A snapshot of the knowledge graph at a specific point in time
 */
export interface GraphSnapshot {
    year: number;
    nodes: TemporalNode[];
    edges: TemporalEdge[];
    // Stats for this time period
    stats: {
        totalDocuments: number;
        newDocuments: number;  // Added in this year
        totalCitations: number;
        newCitations: number;  // New citations in this year
    };
}

/**
 * Timeline of graph evolution
 */
export interface GraphTimeline {
    startYear: number;
    endYear: number;
    snapshots: GraphSnapshot[];
    // Cumulative graph including all documents
    fullGraph: TemporalKnowledgeGraph;
}

/**
 * Extended knowledge graph with temporal awareness
 */
export interface TemporalKnowledgeGraph extends KnowledgeGraph {
    nodes: TemporalNode[];
    edges: TemporalEdge[];
    temporal: {
        // Year range
        minYear: number;
        maxYear: number;
        // Citation chains (chronological sequences)
        citationChains: CitationChain[];
        // Documents grouped by year
        documentsByYear: Map<number, string[]>;
    };
}

/**
 * A chain of citations over time (Paper A → Paper B → Paper C)
 */
export interface CitationChain {
    id: string;
    documents: Array<{
        documentId: string;
        documentName: string;
        year: number;
    }>;
    topic?: string;  // Common theme in the chain
    length: number;
}

/**
 * TemporalGraphService - Time-aware knowledge graph with citation evolution
 * 
 * Features:
 * - Track publication dates and citation chronology
 * - Generate timeline snapshots showing graph evolution
 * - Identify influential papers and citation chains
 * - Filter graph by time range
 */
export class TemporalGraphService {
    private context: vscode.ExtensionContext;
    private documentStore: DocumentStore;
    private knowledgeGraphService: KnowledgeGraphService;
    private citationExtractor: CitationExtractor;
    private cachedGraph: TemporalKnowledgeGraph | null = null;

    constructor(
        context: vscode.ExtensionContext,
        documentStore: DocumentStore,
        knowledgeGraphService: KnowledgeGraphService
    ) {
        this.context = context;
        this.documentStore = documentStore;
        this.knowledgeGraphService = knowledgeGraphService;
        this.citationExtractor = new CitationExtractor();
    }

    /**
     * Build a temporal knowledge graph from all indexed documents
     */
    async buildTemporalGraph(
        progress?: vscode.Progress<{ message?: string; increment?: number }>
    ): Promise<TemporalKnowledgeGraph> {
        progress?.report({ message: 'Building base knowledge graph...', increment: 10 });

        // Start with the base knowledge graph
        const baseGraph = await this.knowledgeGraphService.buildGraph(progress);

        progress?.report({ message: 'Extracting temporal metadata...', increment: 20 });

        // Get all documents
        const documents = this.documentStore.getAllDocuments();

        // Extract publication years
        const documentYears = new Map<string, number>();
        const documentsByYear = new Map<number, string[]>();

        for (const doc of documents) {
            const year = await this.extractPublicationYear(doc);
            if (year) {
                documentYears.set(doc.id, year);
                
                if (!documentsByYear.has(year)) {
                    documentsByYear.set(year, []);
                }
                documentsByYear.get(year)!.push(doc.id);

                // Update document metadata
                doc.publishedYear = year;
            }
        }

        progress?.report({ message: 'Building temporal nodes...', increment: 20 });

        // Convert to temporal nodes
        const temporalNodes: TemporalNode[] = baseGraph.nodes.map(node => {
            const year = documentYears.get(node.id);
            const citedByYears: number[] = [];

            // Find all documents that cite this one
            for (const edge of baseGraph.edges) {
                if (edge.target === node.id && edge.type === 'cites') {
                    const sourceYear = documentYears.get(edge.source);
                    if (sourceYear) {
                        citedByYears.push(sourceYear);
                    }
                }
            }

            return {
                ...node,
                publishedYear: year,
                citedByYears: citedByYears.sort((a, b) => a - b),
                temporalInfluence: this.calculateTemporalInfluence(node.id, citedByYears, documentYears)
            };
        });

        progress?.report({ message: 'Building temporal edges...', increment: 20 });

        // Convert to temporal edges
        const temporalEdges: TemporalEdge[] = baseGraph.edges.map(edge => {
            const sourceYear = documentYears.get(edge.source);
            const targetYear = documentYears.get(edge.target);

            return {
                ...edge,
                year: sourceYear,
                yearDelta: sourceYear && targetYear ? sourceYear - targetYear : undefined
            };
        });

        progress?.report({ message: 'Detecting citation chains...', increment: 20 });

        // Build citation chains
        const citationChains = this.buildCitationChains(documents, temporalEdges, documentYears);

        // Calculate year range
        const years = Array.from(documentYears.values());
        const minYear = years.length > 0 ? Math.min(...years) : new Date().getFullYear();
        const maxYear = years.length > 0 ? Math.max(...years) : new Date().getFullYear();

        const temporalGraph: TemporalKnowledgeGraph = {
            nodes: temporalNodes,
            edges: temporalEdges,
            metadata: {
                ...baseGraph.metadata,
                generatedAt: new Date().toISOString()
            },
            temporal: {
                minYear,
                maxYear,
                citationChains,
                documentsByYear
            }
        };

        this.cachedGraph = temporalGraph;
        progress?.report({ message: 'Temporal graph complete', increment: 10 });

        return temporalGraph;
    }

    /**
     * Extract publication year from document
     */
    private async extractPublicationYear(doc: DocumentMetadata): Promise<number | undefined> {
        // Use existing metadata if available
        if (doc.publishedYear) {
            return doc.publishedYear;
        }

        // Try to extract from document text
        const content = this.documentStore.getDocumentContent(doc.id);
        if (!content) return undefined;

        // Look for year patterns near the beginning (usually in header/abstract)
        const firstChunk = content.substring(0, 2000);
        
        // Common patterns for academic papers
        const patterns = [
            // "(2023)" or "2023"
            /\b(19[89]\d|20[0-2]\d)\b/g,
            // "Published: 2023" or "Publication Date: 2023"
            /(?:published|publication date|date)[:\s]*(\d{4})/i,
            // Copyright patterns
            /©\s*(\d{4})/,
            /copyright\s*(\d{4})/i
        ];

        const foundYears: number[] = [];

        for (const pattern of patterns) {
            const matches = firstChunk.matchAll(pattern);
            for (const match of matches) {
                const year = parseInt(match[1] || match[0]);
                if (year >= 1980 && year <= new Date().getFullYear() + 1) {
                    foundYears.push(year);
                }
            }
        }

        // Return the most recent valid year (usually the publication year)
        if (foundYears.length > 0) {
            // Filter to reasonable years and take the most common/recent
            const validYears = foundYears.filter(y => y >= 2000 && y <= new Date().getFullYear());
            if (validYears.length > 0) {
                // Count occurrences and prefer more common years
                const yearCounts = new Map<number, number>();
                for (const y of validYears) {
                    yearCounts.set(y, (yearCounts.get(y) || 0) + 1);
                }
                
                // Return the year that appears most often
                let maxCount = 0;
                let bestYear = validYears[0];
                for (const [year, count] of yearCounts) {
                    if (count > maxCount) {
                        maxCount = count;
                        bestYear = year;
                    }
                }
                return bestYear;
            }
            return Math.max(...foundYears);
        }

        // Fallback to indexed date
        return new Date(doc.indexedAt).getFullYear();
    }

    /**
     * Calculate temporal influence score
     * Higher score = paper cited by many later papers
     */
    private calculateTemporalInfluence(
        docId: string,
        citedByYears: number[],
        documentYears: Map<string, number>
    ): number {
        if (citedByYears.length === 0) return 0;

        const docYear = documentYears.get(docId);
        if (!docYear) return citedByYears.length;

        // Score based on:
        // 1. Number of citations
        // 2. Temporal span of citations (cited over many years = more influential)
        // 3. Recency of citations (still being cited = sustained influence)

        const citationCount = citedByYears.length;
        const yearSpan = citedByYears.length > 0 
            ? Math.max(...citedByYears) - Math.min(...citedByYears) + 1 
            : 0;
        const currentYear = new Date().getFullYear();
        const recentCitations = citedByYears.filter(y => y >= currentYear - 5).length;

        // Weighted score
        return (
            citationCount * 1.0 +
            yearSpan * 0.5 +
            recentCitations * 2.0
        );
    }

    /**
     * Build citation chains from edges
     */
    private buildCitationChains(
        documents: DocumentMetadata[],
        edges: TemporalEdge[],
        documentYears: Map<string, number>
    ): CitationChain[] {
        const chains: CitationChain[] = [];
        const citationEdges = edges.filter(e => e.type === 'cites' && e.yearDelta !== undefined);

        // Build adjacency list for citation graph
        const cites = new Map<string, string[]>();  // doc -> docs it cites
        const citedBy = new Map<string, string[]>();  // doc -> docs that cite it

        for (const edge of citationEdges) {
            if (!cites.has(edge.source)) cites.set(edge.source, []);
            if (!citedBy.has(edge.target)) citedBy.set(edge.target, []);
            
            cites.get(edge.source)!.push(edge.target);
            citedBy.get(edge.target)!.push(edge.source);
        }

        // Find root papers (cited but don't cite others in the collection)
        const roots: string[] = [];
        for (const doc of documents) {
            const citesOthers = cites.get(doc.id)?.length || 0;
            const citedByOthers = citedBy.get(doc.id)?.length || 0;
            
            if (citedByOthers > 0 && citesOthers === 0) {
                roots.push(doc.id);
            }
        }

        // Build chains from each root
        for (const root of roots) {
            const chain = this.buildChainFromRoot(root, citedBy, documentYears, documents);
            if (chain.length >= 2) {
                chains.push({
                    id: `chain_${chains.length + 1}`,
                    documents: chain,
                    length: chain.length
                });
            }
        }

        // Sort chains by length
        chains.sort((a, b) => b.length - a.length);

        return chains.slice(0, 20);  // Top 20 chains
    }

    /**
     * Build a citation chain starting from a root paper
     */
    private buildChainFromRoot(
        rootId: string,
        citedBy: Map<string, string[]>,
        documentYears: Map<string, number>,
        documents: DocumentMetadata[]
    ): Array<{ documentId: string; documentName: string; year: number }> {
        const chain: Array<{ documentId: string; documentName: string; year: number }> = [];
        const visited = new Set<string>();
        
        let current = rootId;
        while (current && !visited.has(current)) {
            visited.add(current);
            
            const doc = documents.find(d => d.id === current);
            const year = documentYears.get(current);
            
            if (doc && year) {
                chain.push({
                    documentId: current,
                    documentName: doc.name,
                    year
                });
            }

            // Find the next paper in the chain (most recent citing paper)
            const citers = citedBy.get(current) || [];
            if (citers.length === 0) break;

            // Pick the earliest citer to follow the chain
            let nextDoc: string | null = null;
            let nextYear = Infinity;

            for (const citerId of citers) {
                const citerYear = documentYears.get(citerId);
                if (citerYear && citerYear < nextYear) {
                    nextYear = citerYear;
                    nextDoc = citerId;
                }
            }

            current = nextDoc!;
        }

        return chain;
    }

    /**
     * Generate timeline snapshots for visualization
     */
    async generateTimeline(
        startYear?: number,
        endYear?: number
    ): Promise<GraphTimeline> {
        if (!this.cachedGraph) {
            await this.buildTemporalGraph();
        }

        const graph = this.cachedGraph!;
        const minYear = startYear || graph.temporal.minYear;
        const maxYear = endYear || graph.temporal.maxYear;

        const snapshots: GraphSnapshot[] = [];

        for (let year = minYear; year <= maxYear; year++) {
            const snapshot = this.createSnapshotForYear(graph, year);
            snapshots.push(snapshot);
        }

        return {
            startYear: minYear,
            endYear: maxYear,
            snapshots,
            fullGraph: graph
        };
    }

    /**
     * Create a graph snapshot for a specific year
     */
    private createSnapshotForYear(graph: TemporalKnowledgeGraph, year: number): GraphSnapshot {
        // Include all documents published up to this year
        const includedNodes = graph.nodes.filter(n => 
            n.publishedYear !== undefined && n.publishedYear <= year
        );

        const includedNodeIds = new Set(includedNodes.map(n => n.id));

        // Include edges where both source and target are included
        const includedEdges = graph.edges.filter(e =>
            includedNodeIds.has(e.source) && includedNodeIds.has(e.target)
        );

        // Calculate stats
        const newDocuments = graph.nodes.filter(n => n.publishedYear === year).length;
        const newCitations = graph.edges.filter(e => e.year === year && e.type === 'cites').length;

        return {
            year,
            nodes: includedNodes,
            edges: includedEdges,
            stats: {
                totalDocuments: includedNodes.filter(n => n.type === 'document').length,
                newDocuments,
                totalCitations: includedEdges.filter(e => e.type === 'cites').length,
                newCitations
            }
        };
    }

    /**
     * Filter the graph to a specific time range
     */
    filterByTimeRange(startYear: number, endYear: number): TemporalKnowledgeGraph | null {
        if (!this.cachedGraph) return null;

        const filteredNodes = this.cachedGraph.nodes.filter(n =>
            n.publishedYear !== undefined &&
            n.publishedYear >= startYear &&
            n.publishedYear <= endYear
        );

        const nodeIds = new Set(filteredNodes.map(n => n.id));

        const filteredEdges = this.cachedGraph.edges.filter(e =>
            nodeIds.has(e.source) && nodeIds.has(e.target)
        );

        return {
            ...this.cachedGraph,
            nodes: filteredNodes,
            edges: filteredEdges,
            temporal: {
                ...this.cachedGraph.temporal,
                minYear: startYear,
                maxYear: endYear
            }
        };
    }

    /**
     * Get most influential papers (highest temporal influence score)
     */
    getMostInfluentialPapers(limit: number = 10): TemporalNode[] {
        if (!this.cachedGraph) return [];

        return [...this.cachedGraph.nodes]
            .filter(n => n.type === 'document')
            .sort((a, b) => (b.temporalInfluence || 0) - (a.temporalInfluence || 0))
            .slice(0, limit);
    }

    /**
     * Get papers from a specific year
     */
    getPapersByYear(year: number): TemporalNode[] {
        if (!this.cachedGraph) return [];

        return this.cachedGraph.nodes.filter(n =>
            n.type === 'document' && n.publishedYear === year
        );
    }

    /**
     * Get citation statistics over time
     */
    getCitationStats(): Array<{ year: number; papers: number; citations: number }> {
        if (!this.cachedGraph) return [];

        const stats = new Map<number, { papers: number; citations: number }>();

        for (const node of this.cachedGraph.nodes) {
            if (node.type === 'document' && node.publishedYear) {
                const year = node.publishedYear;
                if (!stats.has(year)) {
                    stats.set(year, { papers: 0, citations: 0 });
                }
                stats.get(year)!.papers++;
            }
        }

        for (const edge of this.cachedGraph.edges) {
            if (edge.type === 'cites' && edge.year) {
                if (!stats.has(edge.year)) {
                    stats.set(edge.year, { papers: 0, citations: 0 });
                }
                stats.get(edge.year)!.citations++;
            }
        }

        return Array.from(stats.entries())
            .map(([year, data]) => ({ year, ...data }))
            .sort((a, b) => a.year - b.year);
    }

    /**
     * Clear cached graph
     */
    clearCache(): void {
        this.cachedGraph = null;
    }

    /**
     * Get the cached temporal graph
     */
    getCachedGraph(): TemporalKnowledgeGraph | null {
        return this.cachedGraph;
    }
}
