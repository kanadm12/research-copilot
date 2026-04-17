import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DocumentStore, DocumentMetadata, DocumentChunk } from './documentStore';
import { EmbeddingService } from './embeddingService';
import { CitationExtractor, Citation } from './citationExtractor';

export interface GraphNode {
    id: string;
    label: string;
    type: 'document' | 'concept' | 'author' | 'citation';
    size: number;
    metadata?: Record<string, any>;
}

export interface GraphEdge {
    source: string;
    target: string;
    type: 'cites' | 'related' | 'shares_concept' | 'same_author';
    weight: number;
    label?: string;
}

export interface KnowledgeGraph {
    nodes: GraphNode[];
    edges: GraphEdge[];
    metadata: {
        generatedAt: string;
        documentCount: number;
        conceptCount: number;
    };
}

export class KnowledgeGraphService {
    private context: vscode.ExtensionContext;
    private documentStore: DocumentStore;
    private embeddingService: EmbeddingService;
    private citationExtractor: CitationExtractor;

    constructor(
        context: vscode.ExtensionContext,
        documentStore: DocumentStore,
        embeddingService: EmbeddingService
    ) {
        this.context = context;
        this.documentStore = documentStore;
        this.embeddingService = embeddingService;
        this.citationExtractor = new CitationExtractor();
    }

    /**
     * Build a knowledge graph from all indexed documents
     */
    async buildGraph(
        progress?: vscode.Progress<{ message?: string; increment?: number }>
    ): Promise<KnowledgeGraph> {
        const documents = this.documentStore.getAllDocuments();
        
        if (documents.length === 0) {
            throw new Error('No documents indexed. Please index some PDFs first.');
        }

        const nodes: GraphNode[] = [];
        const edges: GraphEdge[] = [];
        const conceptMap = new Map<string, { count: number; documents: string[] }>();

        progress?.report({ message: 'Analyzing documents...', increment: 10 });

        // Add document nodes
        for (const doc of documents) {
            nodes.push({
                id: doc.id,
                label: doc.name.replace('.pdf', ''),
                type: 'document',
                size: Math.min(30, 10 + doc.chunks.length / 5),
                metadata: {
                    path: doc.path,
                    pages: doc.pageCount,
                    summary: doc.summary
                }
            });

            // Extract concepts from document
            const concepts = await this.extractConcepts(doc);
            for (const concept of concepts) {
                const existing = conceptMap.get(concept.toLowerCase());
                if (existing) {
                    existing.count++;
                    existing.documents.push(doc.id);
                } else {
                    conceptMap.set(concept.toLowerCase(), { count: 1, documents: [doc.id] });
                }
            }
        }

        progress?.report({ message: 'Building concept nodes...', increment: 20 });

        // Add concept nodes (only those appearing in multiple documents or very important)
        for (const [concept, data] of conceptMap) {
            if (data.count >= 2 || data.documents.length >= 2) {
                const nodeId = `concept_${concept.replace(/\s+/g, '_')}`;
                nodes.push({
                    id: nodeId,
                    label: concept,
                    type: 'concept',
                    size: Math.min(25, 5 + data.count * 2),
                    metadata: { frequency: data.count }
                });

                // Connect concept to documents
                for (const docId of data.documents) {
                    edges.push({
                        source: docId,
                        target: nodeId,
                        type: 'shares_concept',
                        weight: 1
                    });
                }
            }
        }

        progress?.report({ message: 'Computing document similarities...', increment: 30 });

        // Compute semantic similarity between documents
        const similarityThreshold = 0.5;
        for (let i = 0; i < documents.length; i++) {
            for (let j = i + 1; j < documents.length; j++) {
                const similarity = await this.computeDocumentSimilarity(documents[i], documents[j]);
                if (similarity > similarityThreshold) {
                    edges.push({
                        source: documents[i].id,
                        target: documents[j].id,
                        type: 'related',
                        weight: similarity,
                        label: `${(similarity * 100).toFixed(0)}% similar`
                    });
                }
            }
        }

        progress?.report({ message: 'Analyzing citations...', increment: 20 });

        // Extract and link citations
        for (const doc of documents) {
            const citations = await this.extractCitationsFromDoc(doc);
            for (const citation of citations) {
                // Check if citation matches another indexed document
                const matchedDoc = this.findMatchingDocument(citation, documents);
                if (matchedDoc && matchedDoc.id !== doc.id) {
                    edges.push({
                        source: doc.id,
                        target: matchedDoc.id,
                        type: 'cites',
                        weight: 1,
                        label: 'cites'
                    });
                }
            }
        }

        progress?.report({ message: 'Finalizing graph...', increment: 20 });

        return {
            nodes,
            edges,
            metadata: {
                generatedAt: new Date().toISOString(),
                documentCount: documents.length,
                conceptCount: conceptMap.size
            }
        };
    }

    /**
     * Extract key concepts from a document using NLP
     */
    private async extractConcepts(doc: DocumentMetadata): Promise<string[]> {
        const concepts: string[] = [];
        const text = doc.chunks.map(c => c.text).join(' ');
        
        // Extract noun phrases and key terms
        // Simple extraction based on capitalization and frequency
        const words = text.split(/\s+/);
        const termFreq = new Map<string, number>();
        
        // Find capitalized phrases (likely proper nouns/terms)
        const capitalizedPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g;
        let match;
        while ((match = capitalizedPattern.exec(text)) !== null) {
            const term = match[1];
            if (term.length > 3 && !this.isCommonWord(term)) {
                termFreq.set(term, (termFreq.get(term) || 0) + 1);
            }
        }

        // Find technical terms (words with specific patterns)
        const technicalPattern = /\b([a-z]+(?:-[a-z]+)+|[a-z]*[A-Z]+[a-z]*)\b/g;
        while ((match = technicalPattern.exec(text)) !== null) {
            const term = match[1];
            if (term.length > 4) {
                termFreq.set(term, (termFreq.get(term) || 0) + 1);
            }
        }

        // Sort by frequency and take top terms
        const sortedTerms = [...termFreq.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([term]) => term);

        return sortedTerms;
    }

    /**
     * Check if a word is a common word (stop word)
     */
    private isCommonWord(word: string): boolean {
        const commonWords = new Set([
            'The', 'This', 'That', 'These', 'Those', 'There', 'Where', 'When',
            'What', 'Which', 'Who', 'How', 'Why', 'However', 'Therefore',
            'Figure', 'Table', 'Section', 'Chapter', 'Page', 'Reference',
            'Abstract', 'Introduction', 'Conclusion', 'Results', 'Discussion',
            'Methods', 'Materials', 'Data', 'Analysis', 'Study', 'Research'
        ]);
        return commonWords.has(word);
    }

    /**
     * Compute semantic similarity between two documents
     */
    private async computeDocumentSimilarity(doc1: DocumentMetadata, doc2: DocumentMetadata): Promise<number> {
        try {
            // Use summaries or first chunks for comparison
            const text1 = doc1.summary || doc1.chunks[0]?.text || '';
            const text2 = doc2.summary || doc2.chunks[0]?.text || '';

            if (!text1 || !text2) return 0;

            const embedding1 = await this.embeddingService.embed(text1);
            const embedding2 = await this.embeddingService.embed(text2);

            if (!embedding1 || !embedding2) return 0;

            return this.cosineSimilarity(embedding1, embedding2);
        } catch {
            return 0;
        }
    }

    /**
     * Compute cosine similarity between two vectors
     */
    private cosineSimilarity(a: number[], b: number[]): number {
        if (a.length !== b.length) return 0;
        
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        
        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        
        const denominator = Math.sqrt(normA) * Math.sqrt(normB);
        return denominator === 0 ? 0 : dotProduct / denominator;
    }

    /**
     * Extract citations from a document
     */
    private async extractCitationsFromDoc(doc: DocumentMetadata): Promise<Citation[]> {
        const text = doc.chunks.map(c => c.text).join(' ');
        const result = this.citationExtractor.extractCitations(text);
        // Combine in-text citations and references
        return [...result.inTextCitations, ...result.references];
    }

    /**
     * Find a matching document for a citation
     */
    private findMatchingDocument(citation: Citation, documents: DocumentMetadata[]): DocumentMetadata | undefined {
        for (const doc of documents) {
            const docName = doc.name.toLowerCase();
            
            // Check if document name contains author name or title keywords
            if (citation.authors && citation.authors.length > 0) {
                const firstAuthor = citation.authors[0];
                const authorLastName = firstAuthor.split(' ').pop()?.toLowerCase();
                if (authorLastName && docName.includes(authorLastName)) {
                    return doc;
                }
            }
            
            if (citation.title) {
                const titleWords = citation.title.toLowerCase().split(' ').filter(w => w.length > 4);
                const matchCount = titleWords.filter(w => docName.includes(w)).length;
                if (matchCount >= 2) {
                    return doc;
                }
            }
        }
        return undefined;
    }

    /**
     * Generate interactive HTML visualization
     */
    generateVisualization(graph: KnowledgeGraph): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Research Knowledge Graph</title>
    <script src="https://d3js.org/d3.v7.min.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #1e1e1e;
            color: #fff;
            overflow: hidden;
        }
        #container { width: 100vw; height: 100vh; }
        
        .node { cursor: pointer; }
        .node circle { stroke: #fff; stroke-width: 1.5px; }
        .node.document circle { fill: #4fc3f7; }
        .node.concept circle { fill: #81c784; }
        .node.author circle { fill: #ffb74d; }
        .node.citation circle { fill: #ba68c8; }
        
        .node text {
            font-size: 10px;
            fill: #fff;
            pointer-events: none;
            text-shadow: 0 1px 2px rgba(0,0,0,0.8);
        }
        
        .link {
            stroke-opacity: 0.6;
            fill: none;
        }
        .link.cites { stroke: #f44336; }
        .link.related { stroke: #4fc3f7; }
        .link.shares_concept { stroke: #81c784; stroke-dasharray: 3,3; }
        .link.same_author { stroke: #ffb74d; }
        
        #tooltip {
            position: absolute;
            padding: 12px;
            background: rgba(30, 30, 30, 0.95);
            border: 1px solid #444;
            border-radius: 8px;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.2s;
            max-width: 300px;
            font-size: 13px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        }
        #tooltip h3 { margin-bottom: 8px; color: #4fc3f7; }
        #tooltip p { margin: 4px 0; color: #ccc; }
        
        #legend {
            position: absolute;
            top: 20px;
            left: 20px;
            background: rgba(30, 30, 30, 0.9);
            padding: 15px;
            border-radius: 8px;
            border: 1px solid #444;
        }
        #legend h3 { margin-bottom: 10px; font-size: 14px; }
        .legend-item { display: flex; align-items: center; margin: 5px 0; font-size: 12px; }
        .legend-dot { width: 12px; height: 12px; border-radius: 50%; margin-right: 8px; }
        
        #controls {
            position: absolute;
            top: 20px;
            right: 20px;
            background: rgba(30, 30, 30, 0.9);
            padding: 15px;
            border-radius: 8px;
            border: 1px solid #444;
        }
        #controls button {
            background: #4fc3f7;
            color: #000;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            margin: 4px;
            font-size: 12px;
        }
        #controls button:hover { background: #29b6f6; }
        
        #stats {
            position: absolute;
            bottom: 20px;
            left: 20px;
            background: rgba(30, 30, 30, 0.9);
            padding: 10px 15px;
            border-radius: 8px;
            border: 1px solid #444;
            font-size: 12px;
        }
    </style>
</head>
<body>
    <div id="container"></div>
    <div id="tooltip"></div>
    
    <div id="legend">
        <h3>Node Types</h3>
        <div class="legend-item"><div class="legend-dot" style="background:#4fc3f7"></div> Document</div>
        <div class="legend-item"><div class="legend-dot" style="background:#81c784"></div> Concept</div>
        <div class="legend-item"><div class="legend-dot" style="background:#ffb74d"></div> Author</div>
        <div class="legend-item"><div class="legend-dot" style="background:#ba68c8"></div> Citation</div>
    </div>
    
    <div id="controls">
        <button onclick="resetZoom()">Reset View</button>
        <button onclick="toggleLabels()">Toggle Labels</button>
        <button onclick="filterConcepts()">Toggle Concepts</button>
    </div>
    
    <div id="stats">
        Documents: ${graph.metadata.documentCount} | 
        Concepts: ${graph.metadata.conceptCount} |
        Connections: ${graph.edges.length}
    </div>
    
    <script>
        const data = ${JSON.stringify(graph)};
        
        const width = window.innerWidth;
        const height = window.innerHeight;
        
        let showLabels = true;
        let showConcepts = true;
        
        const svg = d3.select("#container")
            .append("svg")
            .attr("width", width)
            .attr("height", height);
        
        const g = svg.append("g");
        
        // Zoom behavior
        const zoom = d3.zoom()
            .scaleExtent([0.1, 4])
            .on("zoom", (event) => g.attr("transform", event.transform));
        
        svg.call(zoom);
        
        // Create force simulation
        const simulation = d3.forceSimulation(data.nodes)
            .force("link", d3.forceLink(data.edges)
                .id(d => d.id)
                .distance(d => 100 / (d.weight || 1)))
            .force("charge", d3.forceManyBody().strength(-200))
            .force("center", d3.forceCenter(width / 2, height / 2))
            .force("collision", d3.forceCollide().radius(d => d.size + 5));
        
        // Create links
        const link = g.append("g")
            .selectAll("line")
            .data(data.edges)
            .join("line")
            .attr("class", d => "link " + d.type)
            .attr("stroke-width", d => Math.sqrt(d.weight) * 2);
        
        // Create nodes
        const node = g.append("g")
            .selectAll("g")
            .data(data.nodes)
            .join("g")
            .attr("class", d => "node " + d.type)
            .call(d3.drag()
                .on("start", dragstarted)
                .on("drag", dragged)
                .on("end", dragended));
        
        node.append("circle")
            .attr("r", d => d.size);
        
        node.append("text")
            .attr("dx", d => d.size + 5)
            .attr("dy", 4)
            .text(d => d.label.length > 20 ? d.label.substring(0, 20) + '...' : d.label);
        
        // Tooltip
        const tooltip = d3.select("#tooltip");
        
        node.on("mouseover", (event, d) => {
            tooltip.style("opacity", 1)
                .style("left", (event.pageX + 10) + "px")
                .style("top", (event.pageY - 10) + "px")
                .html(\`
                    <h3>\${d.label}</h3>
                    <p><strong>Type:</strong> \${d.type}</p>
                    \${d.metadata?.summary ? '<p>' + d.metadata.summary.substring(0, 150) + '...</p>' : ''}
                    \${d.metadata?.pages ? '<p><strong>Pages:</strong> ' + d.metadata.pages + '</p>' : ''}
                \`);
        }).on("mouseout", () => {
            tooltip.style("opacity", 0);
        });
        
        // Update positions on tick
        simulation.on("tick", () => {
            link
                .attr("x1", d => d.source.x)
                .attr("y1", d => d.source.y)
                .attr("x2", d => d.target.x)
                .attr("y2", d => d.target.y);
            
            node.attr("transform", d => \`translate(\${d.x},\${d.y})\`);
        });
        
        function dragstarted(event, d) {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
        }
        
        function dragged(event, d) {
            d.fx = event.x;
            d.fy = event.y;
        }
        
        function dragended(event, d) {
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null;
            d.fy = null;
        }
        
        function resetZoom() {
            svg.transition().duration(750).call(zoom.transform, d3.zoomIdentity);
        }
        
        function toggleLabels() {
            showLabels = !showLabels;
            node.selectAll("text").style("opacity", showLabels ? 1 : 0);
        }
        
        function filterConcepts() {
            showConcepts = !showConcepts;
            node.filter(d => d.type === 'concept').style("opacity", showConcepts ? 1 : 0);
            link.filter(d => d.type === 'shares_concept').style("opacity", showConcepts ? 0.6 : 0);
        }
    </script>
</body>
</html>`;
    }

    /**
     * Show the knowledge graph in a webview panel
     */
    async showGraph(progress?: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> {
        const graph = await this.buildGraph(progress);
        const html = this.generateVisualization(graph);

        const panel = vscode.window.createWebviewPanel(
            'knowledgeGraph',
            'Research Knowledge Graph',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        panel.webview.html = html;

        // Save graph data for export
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            const config = vscode.workspace.getConfiguration('researchCopilot');
            const indexPath = config.get<string>('indexPath', '.research-copilot');
            const graphPath = path.join(workspaceFolder.uri.fsPath, indexPath, 'knowledge_graph.json');
            fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2));
        }
    }

    /**
     * Export graph to various formats
     */
    async exportGraph(format: 'json' | 'graphml' | 'gexf'): Promise<string> {
        const graph = await this.buildGraph();
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) throw new Error('No workspace folder');

        const config = vscode.workspace.getConfiguration('researchCopilot');
        const indexPath = config.get<string>('indexPath', '.research-copilot');
        const outputDir = path.join(workspaceFolder.uri.fsPath, indexPath);

        let outputPath: string;
        let content: string;

        switch (format) {
            case 'json':
                outputPath = path.join(outputDir, 'knowledge_graph.json');
                content = JSON.stringify(graph, null, 2);
                break;
            case 'graphml':
                outputPath = path.join(outputDir, 'knowledge_graph.graphml');
                content = this.toGraphML(graph);
                break;
            case 'gexf':
                outputPath = path.join(outputDir, 'knowledge_graph.gexf');
                content = this.toGEXF(graph);
                break;
        }

        fs.writeFileSync(outputPath, content);
        return outputPath;
    }

    private toGraphML(graph: KnowledgeGraph): string {
        let xml = `<?xml version="1.0" encoding="UTF-8"?>
<graphml xmlns="http://graphml.graphdrawing.org/xmlns">
  <key id="label" for="node" attr.name="label" attr.type="string"/>
  <key id="type" for="node" attr.name="type" attr.type="string"/>
  <key id="weight" for="edge" attr.name="weight" attr.type="double"/>
  <graph id="G" edgedefault="directed">
`;
        for (const node of graph.nodes) {
            xml += `    <node id="${node.id}">
      <data key="label">${this.escapeXml(node.label)}</data>
      <data key="type">${node.type}</data>
    </node>\n`;
        }
        for (let i = 0; i < graph.edges.length; i++) {
            const edge = graph.edges[i];
            xml += `    <edge id="e${i}" source="${edge.source}" target="${edge.target}">
      <data key="weight">${edge.weight}</data>
    </edge>\n`;
        }
        xml += `  </graph>\n</graphml>`;
        return xml;
    }

    private toGEXF(graph: KnowledgeGraph): string {
        let xml = `<?xml version="1.0" encoding="UTF-8"?>
<gexf xmlns="http://www.gexf.net/1.2draft" version="1.2">
  <graph mode="static" defaultedgetype="directed">
    <nodes>
`;
        for (const node of graph.nodes) {
            xml += `      <node id="${node.id}" label="${this.escapeXml(node.label)}"/>\n`;
        }
        xml += `    </nodes>\n    <edges>\n`;
        for (let i = 0; i < graph.edges.length; i++) {
            const edge = graph.edges[i];
            xml += `      <edge id="${i}" source="${edge.source}" target="${edge.target}" weight="${edge.weight}"/>\n`;
        }
        xml += `    </edges>\n  </graph>\n</gexf>`;
        return xml;
    }

    private escapeXml(str: string): string {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }
}
