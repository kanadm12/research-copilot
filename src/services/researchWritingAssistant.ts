import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DocumentStore, DocumentMetadata, DocumentChunk } from './documentStore';
import { SearchService } from './searchService';
import { CitationExtractor, Citation } from './citationExtractor';

export interface WritingRequest {
    type: 'literature_review' | 'abstract' | 'introduction' | 'methodology' | 'discussion' | 'conclusion' | 'custom';
    topic: string;
    customPrompt?: string;
    citationStyle: 'apa' | 'mla' | 'chicago' | 'ieee' | 'bibtex';
    maxLength?: number;
    documentIds?: string[]; // Specific documents to use
    // Template support
    template?: 'ieee' | 'springer' | 'acm' | 'apa' | 'custom';
    customTemplatePath?: string;
}

export interface FullPaperRequest {
    title: string;
    authors: Array<{
        name: string;
        affiliation?: string;
        email?: string;
    }>;
    topic: string;
    template: 'ieee' | 'springer' | 'acm' | 'apa' | 'custom';
    customTemplatePath?: string;
    citationStyle: 'apa' | 'mla' | 'chicago' | 'ieee';
    sections: Array<'abstract' | 'introduction' | 'related_work' | 'methodology' | 'results' | 'discussion' | 'conclusion'>;
    documentIds?: string[];
    keywords?: string[];
}

export interface FullPaperResult {
    latex: string;
    bibtex: string;
    markdown: string;
    sections: Array<{
        title: string;
        content: string;
    }>;
    citations: UsedCitation[];
}

export interface WritingResult {
    content: string;
    citations: UsedCitation[];
    latex: string;
    bibtex: string;
    markdown: string;
}

export interface UsedCitation {
    key: string;
    documentId: string;
    documentName: string;
    text: string; // The text that was cited
    pageNumber?: number;
    formatted: string; // Formatted citation
}

export class ResearchWritingAssistant {
    private context: vscode.ExtensionContext;
    private documentStore: DocumentStore;
    private searchService: SearchService;
    private citationExtractor: CitationExtractor;
    private outputDir: string = '';

    constructor(
        context: vscode.ExtensionContext,
        documentStore: DocumentStore,
        searchService: SearchService
    ) {
        this.context = context;
        this.documentStore = documentStore;
        this.searchService = searchService;
        this.citationExtractor = new CitationExtractor();
        this.initializeOutputDir();
    }

    private initializeOutputDir(): void {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            const config = vscode.workspace.getConfiguration('researchCopilot');
            const indexPath = config.get<string>('indexPath', '.research-copilot');
            this.outputDir = path.join(workspaceFolder.uri.fsPath, indexPath, 'writing');
        } else {
            this.outputDir = path.join(this.context.globalStorageUri.fsPath, 'writing');
        }

        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }
    }

    /**
     * Generate a research writing piece
     */
    async generate(
        request: WritingRequest,
        progress?: vscode.Progress<{ message?: string; increment?: number }>
    ): Promise<WritingResult> {
        progress?.report({ message: 'Searching relevant content...', increment: 10 });

        // Gather relevant content from documents
        const relevantContent = await this.gatherRelevantContent(request);

        progress?.report({ message: 'Generating draft...', increment: 30 });

        // Generate the writing piece
        const { content, citationMarkers } = await this.generateContent(request, relevantContent);

        progress?.report({ message: 'Processing citations...', increment: 20 });

        // Process citations
        const citations = this.processCitations(citationMarkers, relevantContent, request.citationStyle);

        progress?.report({ message: 'Generating LaTeX output...', increment: 20 });

        // Generate LaTeX version
        const latex = this.generateLaTeX(content, citations, request);

        // Generate BibTeX
        const bibtex = this.generateBibTeX(citations);

        // Generate Markdown
        const markdown = this.generateMarkdown(content, citations);

        progress?.report({ message: 'Saving output...', increment: 20 });

        // Save all outputs
        await this.saveOutputs(request, content, latex, bibtex, markdown);

        return {
            content,
            citations,
            latex,
            bibtex,
            markdown
        };
    }

    /**
     * Gather relevant content from documents based on the topic
     */
    private async gatherRelevantContent(request: WritingRequest): Promise<Map<string, DocumentChunk[]>> {
        const relevantChunks = new Map<string, DocumentChunk[]>();

        // If specific documents are requested, use those
        let documents: DocumentMetadata[];
        if (request.documentIds && request.documentIds.length > 0) {
            documents = request.documentIds
                .map(id => this.documentStore.getDocument(id))
                .filter((d): d is DocumentMetadata => d !== undefined);
        } else {
            documents = this.documentStore.getAllDocuments();
        }

        // Search for relevant chunks in each document
        const searchResults = await this.searchService.hybridSearch(request.topic, 30);

        for (const result of searchResults) {
            const docId = result.documentId;
            const doc = this.documentStore.getDocument(docId);
            if (!doc) continue;

            const chunk = doc.chunks.find(c => c.id === result.chunkId);
            if (!chunk) continue;

            if (!relevantChunks.has(docId)) {
                relevantChunks.set(docId, []);
            }
            relevantChunks.get(docId)!.push(chunk);
        }

        return relevantChunks;
    }

    /**
     * Generate the content using the language model
     */
    private async generateContent(
        request: WritingRequest,
        relevantContent: Map<string, DocumentChunk[]>
    ): Promise<{ content: string; citationMarkers: Map<string, { docId: string; chunkId: string }> }> {
        const citationMarkers = new Map<string, { docId: string; chunkId: string }>();

        // Build context from relevant content
        let context = '';
        let citationIndex = 1;
        const docNameMap = new Map<string, string>();

        for (const [docId, chunks] of relevantContent) {
            const doc = this.documentStore.getDocument(docId);
            if (!doc) continue;

            const citationKey = `cite${citationIndex}`;
            docNameMap.set(docId, doc.name);
            
            context += `\n\n[Source: ${doc.name}]\n`;
            for (const chunk of chunks.slice(0, 3)) { // Limit chunks per doc
                context += `${chunk.text}\n`;
                citationMarkers.set(citationKey, { docId, chunkId: chunk.id });
            }
            citationIndex++;
        }

        // Build the prompt based on writing type
        const prompts: Record<string, string> = {
            literature_review: `Write a comprehensive literature review on the following topic. 
                Synthesize the sources, identify themes and gaps, compare and contrast findings.
                Use academic language and cite sources using [cite#] markers.`,
            abstract: `Write a concise academic abstract summarizing the key points from these sources.
                Include background, methods, results, and conclusions. Use [cite#] markers for citations.`,
            introduction: `Write an introduction section for a research paper on this topic.
                Establish context, state the problem, and outline the scope. Use [cite#] markers.`,
            methodology: `Write a methodology section describing research approaches from these sources.
                Discuss methods, data collection, and analysis techniques. Use [cite#] markers.`,
            discussion: `Write a discussion section analyzing the findings from these sources.
                Interpret results, discuss implications, and compare with existing research. Use [cite#] markers.`,
            conclusion: `Write a conclusion summarizing key findings and future directions.
                Synthesize the main points and suggest areas for future research. Use [cite#] markers.`,
            custom: request.customPrompt || 'Write about the following topic using the provided sources.'
        };

        const systemPrompt = prompts[request.type];
        const maxLength = request.maxLength || 1000;

        const fullPrompt = `${systemPrompt}

Topic: ${request.topic}

Target length: approximately ${maxLength} words.

Available source material:
${context}

IMPORTANT:
- Cite sources using markers like [cite1], [cite2], etc.
- Write in clear, academic prose
- Synthesize information across sources
- Maintain a logical flow of ideas`;

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
            const messages = [vscode.LanguageModelChatMessage.User(fullPrompt)];
            
            const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
            
            let responseText = '';
            for await (const chunk of response.text) {
                responseText += chunk;
            }

            return { content: responseText, citationMarkers };
        } catch (error) {
            console.error('Error generating content:', error);
            return {
                content: `Error generating content. Please ensure you have access to a language model.\n\nTopic: ${request.topic}\n\nRelevant sources found: ${relevantContent.size}`,
                citationMarkers
            };
        }
    }

    /**
     * Process citation markers into formatted citations
     */
    private processCitations(
        markers: Map<string, { docId: string; chunkId: string }>,
        relevantContent: Map<string, DocumentChunk[]>,
        style: string
    ): UsedCitation[] {
        const citations: UsedCitation[] = [];

        for (const [key, { docId, chunkId }] of markers) {
            const doc = this.documentStore.getDocument(docId);
            if (!doc) continue;

            const chunk = doc.chunks.find(c => c.id === chunkId);
            const text = chunk?.text.substring(0, 100) || '';

            citations.push({
                key,
                documentId: docId,
                documentName: doc.name,
                text,
                pageNumber: chunk?.pageNumber,
                formatted: this.formatCitation(doc, style, chunk?.pageNumber)
            });
        }

        return citations;
    }

    /**
     * Format a citation according to the specified style
     */
    private formatCitation(doc: DocumentMetadata, style: string, pageNumber?: number): string {
        const name = doc.name.replace('.pdf', '');
        const year = new Date().getFullYear(); // Placeholder - would extract from doc
        const pageStr = pageNumber ? `, p. ${pageNumber}` : '';

        switch (style) {
            case 'apa':
                return `(${name}, ${year}${pageStr})`;
            case 'mla':
                return `(${name}${pageStr})`;
            case 'chicago':
                return `${name}, ${year}${pageStr}.`;
            case 'ieee':
                return `[${name}]`;
            default:
                return `(${name}, ${year})`;
        }
    }

    /**
     * Generate LaTeX output
     */
    private generateLaTeX(content: string, citations: UsedCitation[], request: WritingRequest): string {
        // Replace citation markers with LaTeX \cite commands
        let latexContent = content;
        for (const citation of citations) {
            const citeKey = citation.documentName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
            latexContent = latexContent.replace(
                new RegExp(`\\[${citation.key}\\]`, 'g'),
                `\\cite{${citeKey}}`
            );
        }

        // Escape special LaTeX characters
        latexContent = this.escapeLatex(latexContent);

        const sectionTitle = this.getSectionTitle(request.type);
        
        return `\\documentclass[12pt,a4paper]{article}

\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{hyperref}
\\usepackage{natbib}
\\usepackage{geometry}
\\geometry{margin=1in}

\\title{${this.escapeLatex(request.topic)}}
\\author{Generated by Research Copilot}
\\date{\\today}

\\begin{document}

\\maketitle

\\section{${sectionTitle}}

${latexContent}

\\bibliographystyle{${this.getBibStyle(request.citationStyle)}}
\\bibliography{references}

\\end{document}
`;
    }

    /**
     * Generate BibTeX bibliography
     */
    private generateBibTeX(citations: UsedCitation[]): string {
        let bibtex = '% BibTeX bibliography generated by Research Copilot\n\n';

        const seen = new Set<string>();
        for (const citation of citations) {
            const doc = this.documentStore.getDocument(citation.documentId);
            if (!doc) continue;

            const citeKey = citation.documentName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
            if (seen.has(citeKey)) continue;
            seen.add(citeKey);

            const title = citation.documentName.replace('.pdf', '');
            const year = new Date().getFullYear();

            bibtex += `@article{${citeKey},
  title = {${title}},
  author = {Unknown Author},
  year = {${year}},
  note = {Document: ${citation.documentName}}
}

`;
        }

        return bibtex;
    }

    /**
     * Generate Markdown output
     */
    private generateMarkdown(content: string, citations: UsedCitation[]): string {
        let markdown = content;

        // Replace citation markers with markdown footnotes
        let footnoteIndex = 1;
        for (const citation of citations) {
            markdown = markdown.replace(
                new RegExp(`\\[${citation.key}\\]`, 'g'),
                `[^${footnoteIndex}]`
            );
            footnoteIndex++;
        }

        markdown += '\n\n---\n\n## References\n\n';
        footnoteIndex = 1;
        for (const citation of citations) {
            markdown += `[^${footnoteIndex}]: ${citation.documentName}${citation.pageNumber ? `, p. ${citation.pageNumber}` : ''}\n`;
            footnoteIndex++;
        }

        return markdown;
    }

    /**
     * Save all outputs to files
     */
    private async saveOutputs(
        request: WritingRequest,
        content: string,
        latex: string,
        bibtex: string,
        markdown: string
    ): Promise<void> {
        const timestamp = Date.now();
        const baseName = `${request.type}_${timestamp}`;

        fs.writeFileSync(path.join(this.outputDir, `${baseName}.tex`), latex);
        fs.writeFileSync(path.join(this.outputDir, `${baseName}.bib`), bibtex);
        fs.writeFileSync(path.join(this.outputDir, `${baseName}.md`), markdown);
    }

    /**
     * Get section title based on writing type
     */
    private getSectionTitle(type: string): string {
        const titles: Record<string, string> = {
            literature_review: 'Literature Review',
            abstract: 'Abstract',
            introduction: 'Introduction',
            methodology: 'Methodology',
            discussion: 'Discussion',
            conclusion: 'Conclusion',
            custom: 'Content'
        };
        return titles[type] || 'Content';
    }

    /**
     * Get BibTeX style based on citation style
     */
    private getBibStyle(style: string): string {
        const styles: Record<string, string> = {
            apa: 'apalike',
            mla: 'plain',
            chicago: 'chicago',
            ieee: 'ieeetr',
            bibtex: 'plain'
        };
        return styles[style] || 'plain';
    }

    /**
     * Escape special LaTeX characters
     */
    private escapeLatex(text: string): string {
        return text
            .replace(/\\/g, '\\textbackslash{}')
            .replace(/[&%$#_{}]/g, '\\$&')
            .replace(/~/g, '\\textasciitilde{}')
            .replace(/\^/g, '\\textasciicircum{}')
            .replace(/</g, '\\textless{}')
            .replace(/>/g, '\\textgreater{}');
    }

    /**
     * Get available writing types
     */
    getWritingTypes(): { id: string; label: string; description: string }[] {
        return [
            { id: 'literature_review', label: 'Literature Review', description: 'Comprehensive synthesis of sources on a topic' },
            { id: 'abstract', label: 'Abstract', description: 'Concise summary of research' },
            { id: 'introduction', label: 'Introduction', description: 'Opening section establishing context' },
            { id: 'methodology', label: 'Methodology', description: 'Description of research methods' },
            { id: 'discussion', label: 'Discussion', description: 'Analysis and interpretation of findings' },
            { id: 'conclusion', label: 'Conclusion', description: 'Summary and future directions' },
            { id: 'custom', label: 'Custom', description: 'Write with a custom prompt' }
        ];
    }

    /**
     * Get available citation styles
     */
    getCitationStyles(): { id: string; label: string }[] {
        return [
            { id: 'apa', label: 'APA (7th Edition)' },
            { id: 'mla', label: 'MLA (9th Edition)' },
            { id: 'chicago', label: 'Chicago' },
            { id: 'ieee', label: 'IEEE' },
            { id: 'bibtex', label: 'BibTeX' }
        ];
    }

    /**
     * Get output directory
     */
    getOutputDir(): string {
        return this.outputDir;
    }

    /**
     * Generate a full research paper with all sections
     */
    async generateFullPaper(
        request: FullPaperRequest,
        progress?: vscode.Progress<{ message?: string; increment?: number }>
    ): Promise<FullPaperResult> {
        const sections: Array<{ title: string; content: string }> = [];
        const allCitations: UsedCitation[] = [];
        const totalSections = request.sections.length + 1; // +1 for abstract
        let currentStep = 0;

        // Generate abstract first
        progress?.report({ message: 'Generating abstract...', increment: 0 });
        const abstractResult = await this.generate({
            type: 'abstract',
            topic: request.topic,
            citationStyle: request.citationStyle,
            documentIds: request.documentIds,
            maxLength: 250
        });
        currentStep++;
        progress?.report({ 
            message: 'Abstract complete', 
            increment: (currentStep / totalSections) * 100 
        });

        // Generate each section
        for (const sectionType of request.sections) {
            if (sectionType === 'abstract') continue; // Already generated
            
            progress?.report({ message: `Generating ${sectionType}...`, increment: 0 });
            
            const result = await this.generate({
                type: sectionType as any,
                topic: request.topic,
                citationStyle: request.citationStyle,
                documentIds: request.documentIds
            });

            sections.push({
                title: this.getSectionTitle(sectionType),
                content: result.content
            });

            // Merge citations
            for (const citation of result.citations) {
                if (!allCitations.some(c => c.key === citation.key)) {
                    allCitations.push(citation);
                }
            }

            currentStep++;
            progress?.report({ 
                message: `${sectionType} complete`, 
                increment: (currentStep / totalSections) * 100 
            });
        }

        // Generate final LaTeX document
        const latex = this.generateFullPaperLatex(request, abstractResult.content, sections, allCitations);
        const bibtex = this.generateBibTeX(allCitations);
        const markdown = this.generateFullPaperMarkdown(request, abstractResult.content, sections, allCitations);

        // Save outputs
        const timestamp = Date.now();
        const baseName = `paper_${timestamp}`;
        fs.writeFileSync(path.join(this.outputDir, `${baseName}.tex`), latex);
        fs.writeFileSync(path.join(this.outputDir, `${baseName}.bib`), bibtex);
        fs.writeFileSync(path.join(this.outputDir, `${baseName}.md`), markdown);

        progress?.report({ message: 'Paper generation complete!', increment: 100 });

        return {
            latex,
            bibtex,
            markdown,
            sections,
            citations: allCitations
        };
    }

    /**
     * Generate full paper LaTeX based on template
     */
    private generateFullPaperLatex(
        request: FullPaperRequest,
        abstract: string,
        sections: Array<{ title: string; content: string }>,
        citations: UsedCitation[]
    ): string {
        const templateType = request.template || 'ieee';
        
        // Format authors based on template
        let authorsLatex = '';
        if (templateType === 'ieee') {
            authorsLatex = request.authors.map(a => {
                let str = a.name;
                if (a.affiliation) str += `\\\\${this.escapeLatex(a.affiliation)}`;
                if (a.email) str += `\\\\\\texttt{${a.email}}`;
                return str;
            }).join(' \\and ');
        } else {
            authorsLatex = request.authors.map(a => a.name).join(', ');
        }

        // Build sections content
        const sectionsLatex = sections.map(s => 
            `\\section{${this.escapeLatex(s.title)}}\n${s.content}\n`
        ).join('\n');

        // Process citations in content
        let processedSections = sectionsLatex;
        for (const citation of citations) {
            const citeKey = citation.documentName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
            processedSections = processedSections.replace(
                new RegExp(`\\[${citation.key}\\]`, 'g'),
                `\\cite{${citeKey}}`
            );
        }

        // Keywords
        const keywordsLatex = request.keywords?.length 
            ? request.keywords.map(k => this.escapeLatex(k)).join(', ')
            : '';

        // Select template
        let template = '';
        switch (templateType) {
            case 'ieee':
                template = `\\documentclass[conference]{IEEEtran}
\\usepackage{cite}
\\usepackage{amsmath,amssymb,amsfonts}
\\usepackage{graphicx}
\\usepackage{textcomp}
\\usepackage{xcolor}
\\usepackage{hyperref}

\\begin{document}

\\title{${this.escapeLatex(request.title)}}
\\author{${authorsLatex}}

\\maketitle

\\begin{abstract}
${abstract}
\\end{abstract}

\\begin{IEEEkeywords}
${keywordsLatex}
\\end{IEEEkeywords}

${processedSections}

\\bibliographystyle{ieeetr}
\\begin{thebibliography}{99}
${this.generateBibliographyItems(citations)}
\\end{thebibliography}

\\end{document}`;
                break;

            case 'springer':
                template = `\\documentclass[runningheads]{llncs}
\\usepackage{graphicx}
\\usepackage{hyperref}

\\begin{document}

\\title{${this.escapeLatex(request.title)}}
\\author{${request.authors.map((a, i) => `${a.name}\\inst{${i + 1}}`).join(' \\and ')}}
\\institute{${request.authors.map((a, i) => `${a.affiliation || 'Unknown'}`).join(' \\and ')}}

\\maketitle

\\begin{abstract}
${abstract}
\\keywords{${keywordsLatex}}
\\end{abstract}

${processedSections}

\\begin{thebibliography}{99}
${this.generateBibliographyItems(citations)}
\\end{thebibliography}

\\end{document}`;
                break;

            case 'acm':
                template = `\\documentclass[sigconf]{acmart}
\\setcopyright{none}

\\begin{document}

\\title{${this.escapeLatex(request.title)}}
${request.authors.map(a => `\\author{${a.name}}
\\affiliation{\\institution{${a.affiliation || 'Unknown'}}}
\\email{${a.email || ''}}`).join('\n')}

\\begin{abstract}
${abstract}
\\end{abstract}

\\keywords{${keywordsLatex}}

\\maketitle

${processedSections}

\\bibliographystyle{ACM-Reference-Format}
\\begin{thebibliography}{99}
${this.generateBibliographyItems(citations)}
\\end{thebibliography}

\\end{document}`;
                break;

            default:
                template = `\\documentclass[12pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage{hyperref}
\\usepackage{geometry}
\\geometry{margin=1in}

\\title{${this.escapeLatex(request.title)}}
\\author{${authorsLatex}}
\\date{\\today}

\\begin{document}

\\maketitle

\\begin{abstract}
${abstract}
\\end{abstract}

${processedSections}

\\begin{thebibliography}{99}
${this.generateBibliographyItems(citations)}
\\end{thebibliography}

\\end{document}`;
        }

        return template;
    }

    /**
     * Generate bibliography items for thebibliography environment
     */
    private generateBibliographyItems(citations: UsedCitation[]): string {
        return citations.map(c => {
            const citeKey = c.documentName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
            const title = c.documentName.replace('.pdf', '');
            return `\\bibitem{${citeKey}} ${title}, ${new Date().getFullYear()}.`;
        }).join('\n');
    }

    /**
     * Generate full paper in Markdown format
     */
    private generateFullPaperMarkdown(
        request: FullPaperRequest,
        abstract: string,
        sections: Array<{ title: string; content: string }>,
        citations: UsedCitation[]
    ): string {
        let md = `# ${request.title}\n\n`;
        md += `**Authors:** ${request.authors.map(a => a.name).join(', ')}\n\n`;
        
        if (request.keywords?.length) {
            md += `**Keywords:** ${request.keywords.join(', ')}\n\n`;
        }

        md += `## Abstract\n\n${abstract}\n\n`;

        for (const section of sections) {
            md += `## ${section.title}\n\n${section.content}\n\n`;
        }

        md += `## References\n\n`;
        citations.forEach((c, i) => {
            md += `[${i + 1}] ${c.documentName}${c.pageNumber ? `, p. ${c.pageNumber}` : ''}\n\n`;
        });

        return md;
    }

    /**
     * Get available paper templates
     */
    getAvailableTemplates(): { id: string; label: string; description: string }[] {
        return [
            { id: 'ieee', label: 'IEEE Conference', description: 'IEEE conference paper format' },
            { id: 'springer', label: 'Springer LNCS', description: 'Springer Lecture Notes format' },
            { id: 'acm', label: 'ACM SIGCONF', description: 'ACM conference proceedings' },
            { id: 'apa', label: 'APA Style', description: 'American Psychological Association format' },
            { id: 'custom', label: 'Custom', description: 'Use your own template' }
        ];
    }
}
