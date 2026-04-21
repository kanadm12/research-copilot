import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Available template types
 */
export type TemplateType = 'ieee' | 'springer' | 'acm' | 'apa' | 'custom';

/**
 * Template metadata
 */
export interface TemplateInfo {
    id: string;
    name: string;
    type: TemplateType;
    description: string;
    path: string;
    isBuiltIn: boolean;
    // Required sections for this template
    requiredSections: string[];
    // Optional sections
    optionalSections: string[];
    // Citation style
    citationStyle: 'numeric' | 'author-year' | 'footnote';
    // Preview image path
    previewImage?: string;
}

/**
 * Paper content to be filled into template
 */
export interface PaperContent {
    title: string;
    authors: Array<{
        name: string;
        affiliation?: string;
        email?: string;
    }>;
    abstract: string;
    keywords?: string[];
    sections: Array<{
        title: string;
        content: string;
        subsections?: Array<{
            title: string;
            content: string;
        }>;
    }>;
    acknowledgments?: string;
    references: Array<{
        key: string;
        type: 'article' | 'book' | 'inproceedings' | 'misc';
        title: string;
        authors: string[];
        year: number;
        venue?: string;
        volume?: string;
        pages?: string;
        doi?: string;
        url?: string;
    }>;
    // Custom fields for specific templates
    customFields?: Record<string, string>;
}

/**
 * Template variable substitution
 */
interface TemplateVariable {
    name: string;           // e.g., "TITLE", "ABSTRACT"
    pattern: RegExp;        // Pattern to match in template
    required: boolean;
    transform?: (value: string) => string;  // Optional transformation
}

/**
 * TemplateManager - Manages LaTeX templates for research paper generation
 * 
 * Supports:
 * - Built-in IEEE, Springer, ACM templates
 * - Custom templates from workspace
 * - Variable substitution
 * - Section ordering
 */
export class TemplateManager {
    private context: vscode.ExtensionContext;
    private templatesDir: string;
    private customTemplatesDir: string;
    private templates: Map<string, TemplateInfo> = new Map();

    // Standard template variables
    private readonly variables: TemplateVariable[] = [
        { name: 'TITLE', pattern: /\{\{TITLE\}\}/g, required: true },
        { name: 'AUTHORS', pattern: /\{\{AUTHORS\}\}/g, required: true },
        { name: 'ABSTRACT', pattern: /\{\{ABSTRACT\}\}/g, required: true },
        { name: 'KEYWORDS', pattern: /\{\{KEYWORDS\}\}/g, required: false },
        { name: 'CONTENT', pattern: /\{\{CONTENT\}\}/g, required: true },
        { name: 'SECTIONS', pattern: /\{\{SECTIONS\}\}/g, required: false },
        { name: 'ACKNOWLEDGMENTS', pattern: /\{\{ACKNOWLEDGMENTS\}\}/g, required: false },
        { name: 'BIBLIOGRAPHY', pattern: /\{\{BIBLIOGRAPHY\}\}/g, required: true },
        { name: 'DATE', pattern: /\{\{DATE\}\}/g, required: false },
        { name: 'AFFILIATION', pattern: /\{\{AFFILIATION\}\}/g, required: false },
    ];

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.templatesDir = path.join(context.extensionUri.fsPath, 'resources', 'templates');
        
        // Custom templates in workspace
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        this.customTemplatesDir = workspaceFolder 
            ? path.join(workspaceFolder.uri.fsPath, '.research-copilot', 'templates')
            : path.join(context.globalStorageUri.fsPath, 'templates');

        this.loadTemplates();
    }

    /**
     * Load all available templates
     */
    private loadTemplates(): void {
        // Load built-in templates
        const builtInTemplates: TemplateInfo[] = [
            {
                id: 'ieee-conference',
                name: 'IEEE Conference',
                type: 'ieee',
                description: 'Standard IEEE conference paper format (two-column)',
                path: path.join(this.templatesDir, 'ieee-conference.tex'),
                isBuiltIn: true,
                requiredSections: ['abstract', 'introduction', 'conclusion'],
                optionalSections: ['related_work', 'methodology', 'results', 'discussion'],
                citationStyle: 'numeric'
            },
            {
                id: 'ieee-journal',
                name: 'IEEE Journal',
                type: 'ieee',
                description: 'IEEE Transactions journal format',
                path: path.join(this.templatesDir, 'ieee-journal.tex'),
                isBuiltIn: true,
                requiredSections: ['abstract', 'introduction', 'conclusion'],
                optionalSections: ['related_work', 'methodology', 'results', 'discussion'],
                citationStyle: 'numeric'
            },
            {
                id: 'springer-lncs',
                name: 'Springer LNCS',
                type: 'springer',
                description: 'Springer Lecture Notes in Computer Science format',
                path: path.join(this.templatesDir, 'springer-lncs.tex'),
                isBuiltIn: true,
                requiredSections: ['abstract', 'introduction', 'conclusion'],
                optionalSections: ['related_work', 'methodology', 'evaluation'],
                citationStyle: 'numeric'
            },
            {
                id: 'acm-sigconf',
                name: 'ACM SIGCONF',
                type: 'acm',
                description: 'ACM Conference Proceedings format',
                path: path.join(this.templatesDir, 'acm-sigconf.tex'),
                isBuiltIn: true,
                requiredSections: ['abstract', 'introduction', 'conclusion'],
                optionalSections: ['related_work', 'methodology', 'results'],
                citationStyle: 'author-year'
            },
            {
                id: 'apa-paper',
                name: 'APA Style',
                type: 'apa',
                description: 'American Psychological Association format',
                path: path.join(this.templatesDir, 'apa-paper.tex'),
                isBuiltIn: true,
                requiredSections: ['abstract', 'introduction', 'method', 'results', 'discussion'],
                optionalSections: ['literature_review'],
                citationStyle: 'author-year'
            }
        ];

        for (const template of builtInTemplates) {
            this.templates.set(template.id, template);
        }

        // Load custom templates from workspace
        this.loadCustomTemplates();
    }

    /**
     * Load custom templates from workspace
     */
    private loadCustomTemplates(): void {
        if (!fs.existsSync(this.customTemplatesDir)) {
            return;
        }

        try {
            const files = fs.readdirSync(this.customTemplatesDir);
            
            for (const file of files) {
                if (file.endsWith('.tex')) {
                    const templatePath = path.join(this.customTemplatesDir, file);
                    const id = `custom-${path.basename(file, '.tex')}`;
                    
                    // Try to load metadata from companion JSON file
                    const metadataPath = templatePath.replace('.tex', '.json');
                    let metadata: Partial<TemplateInfo> = {};
                    
                    if (fs.existsSync(metadataPath)) {
                        try {
                            metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
                        } catch (e) {
                            console.warn(`Could not load metadata for template ${file}`);
                        }
                    }

                    this.templates.set(id, {
                        id,
                        name: metadata.name || path.basename(file, '.tex'),
                        type: 'custom',
                        description: metadata.description || 'Custom template',
                        path: templatePath,
                        isBuiltIn: false,
                        requiredSections: metadata.requiredSections || ['abstract', 'introduction', 'conclusion'],
                        optionalSections: metadata.optionalSections || [],
                        citationStyle: metadata.citationStyle || 'numeric'
                    });
                }
            }
        } catch (error) {
            console.warn('Could not load custom templates:', error);
        }
    }

    /**
     * Get all available templates
     */
    getAvailableTemplates(): TemplateInfo[] {
        return Array.from(this.templates.values());
    }

    /**
     * Get a specific template by ID
     */
    getTemplate(id: string): TemplateInfo | undefined {
        return this.templates.get(id);
    }

    /**
     * Get templates by type
     */
    getTemplatesByType(type: TemplateType): TemplateInfo[] {
        return Array.from(this.templates.values()).filter(t => t.type === type);
    }

    /**
     * Load template content
     */
    loadTemplateContent(templateId: string): string | null {
        const template = this.templates.get(templateId);
        if (!template) return null;

        // Check if built-in template file exists, if not use embedded content
        if (template.isBuiltIn && !fs.existsSync(template.path)) {
            return this.getEmbeddedTemplate(templateId);
        }

        try {
            return fs.readFileSync(template.path, 'utf8');
        } catch (error) {
            console.error(`Could not load template ${templateId}:`, error);
            return this.getEmbeddedTemplate(templateId);
        }
    }

    /**
     * Get embedded template content for built-in templates
     */
    private getEmbeddedTemplate(templateId: string): string {
        // Return embedded templates as fallback
        const embedded: Record<string, string> = {
            'ieee-conference': this.getIEEEConferenceTemplate(),
            'ieee-journal': this.getIEEEJournalTemplate(),
            'springer-lncs': this.getSpringerLNCSTemplate(),
            'acm-sigconf': this.getACMTemplate(),
            'apa-paper': this.getAPATemplate()
        };

        return embedded[templateId] || this.getGenericTemplate();
    }

    /**
     * Fill template with paper content
     */
    fillTemplate(templateId: string, content: PaperContent): string {
        let template = this.loadTemplateContent(templateId);
        if (!template) {
            throw new Error(`Template ${templateId} not found`);
        }

        const templateInfo = this.templates.get(templateId);
        const citationStyle = templateInfo?.citationStyle || 'numeric';

        // Replace variables
        template = template.replace(/\{\{TITLE\}\}/g, this.escapeLatex(content.title));
        template = template.replace(/\{\{AUTHORS\}\}/g, this.formatAuthors(content.authors, templateId));
        template = template.replace(/\{\{ABSTRACT\}\}/g, this.escapeLatex(content.abstract));
        template = template.replace(/\{\{KEYWORDS\}\}/g, 
            content.keywords ? this.escapeLatex(content.keywords.join(', ')) : '');
        template = template.replace(/\{\{DATE\}\}/g, new Date().toLocaleDateString('en-US', {
            year: 'numeric', month: 'long', day: 'numeric'
        }));

        // Format sections
        const sectionsLatex = this.formatSections(content.sections);
        template = template.replace(/\{\{CONTENT\}\}/g, sectionsLatex);
        template = template.replace(/\{\{SECTIONS\}\}/g, sectionsLatex);

        // Acknowledgments
        if (content.acknowledgments) {
            template = template.replace(/\{\{ACKNOWLEDGMENTS\}\}/g, 
                `\\section*{Acknowledgments}\n${this.escapeLatex(content.acknowledgments)}`);
        } else {
            template = template.replace(/\{\{ACKNOWLEDGMENTS\}\}/g, '');
        }

        // Bibliography
        const bibtex = this.generateBibTeX(content.references);
        template = template.replace(/\{\{BIBLIOGRAPHY\}\}/g, 
            this.formatBibliography(content.references, citationStyle));

        // Custom fields
        if (content.customFields) {
            for (const [key, value] of Object.entries(content.customFields)) {
                const pattern = new RegExp(`\\{\\{${key.toUpperCase()}\\}\\}`, 'g');
                template = template.replace(pattern, this.escapeLatex(value));
            }
        }

        return template;
    }

    /**
     * Format authors for LaTeX
     */
    private formatAuthors(authors: PaperContent['authors'], templateId: string): string {
        const template = this.templates.get(templateId);
        
        if (template?.type === 'ieee') {
            // IEEE format: \author{Name1 \and Name2}
            return authors.map(a => {
                let authorStr = a.name;
                if (a.affiliation) {
                    authorStr += `\\\\${a.affiliation}`;
                }
                if (a.email) {
                    authorStr += `\\\\\\texttt{${a.email}}`;
                }
                return authorStr;
            }).join(' \\and ');
        }

        if (template?.type === 'springer') {
            // Springer LNCS format
            return authors.map((a, i) => {
                let authorStr = `\\author{${a.name}`;
                if (a.affiliation) {
                    authorStr += `\\inst{${i + 1}}`;
                }
                return authorStr + '}';
            }).join('\n') + '\n' + authors.map((a, i) => 
                a.affiliation ? `\\institute{${a.affiliation}}` : ''
            ).filter(s => s).join('\n');
        }

        // Default format
        return authors.map(a => a.name).join(', ');
    }

    /**
     * Format sections for LaTeX
     */
    private formatSections(sections: PaperContent['sections']): string {
        let latex = '';

        for (const section of sections) {
            latex += `\\section{${this.escapeLatex(section.title)}}\n`;
            latex += `${section.content}\n\n`;

            if (section.subsections) {
                for (const subsection of section.subsections) {
                    latex += `\\subsection{${this.escapeLatex(subsection.title)}}\n`;
                    latex += `${subsection.content}\n\n`;
                }
            }
        }

        return latex;
    }

    /**
     * Format bibliography
     */
    private formatBibliography(references: PaperContent['references'], style: string): string {
        if (references.length === 0) return '';

        let latex = '\\begin{thebibliography}{99}\n\n';

        for (const ref of references) {
            latex += `\\bibitem{${ref.key}}\n`;
            latex += `${ref.authors.join(', ')}.\n`;
            latex += `\\textit{${this.escapeLatex(ref.title)}}.\n`;
            
            if (ref.venue) {
                latex += `${this.escapeLatex(ref.venue)}`;
                if (ref.volume) latex += `, ${ref.volume}`;
                if (ref.pages) latex += `, pp. ${ref.pages}`;
                latex += ', ';
            }
            
            latex += `${ref.year}.\n\n`;
        }

        latex += '\\end{thebibliography}';
        return latex;
    }

    /**
     * Generate BibTeX file content
     */
    generateBibTeX(references: PaperContent['references']): string {
        let bibtex = '% Generated by Research Copilot\n\n';

        for (const ref of references) {
            bibtex += `@${ref.type}{${ref.key},\n`;
            bibtex += `  author = {${ref.authors.join(' and ')}},\n`;
            bibtex += `  title = {${ref.title}},\n`;
            bibtex += `  year = {${ref.year}},\n`;
            
            if (ref.venue) bibtex += `  journal = {${ref.venue}},\n`;
            if (ref.volume) bibtex += `  volume = {${ref.volume}},\n`;
            if (ref.pages) bibtex += `  pages = {${ref.pages}},\n`;
            if (ref.doi) bibtex += `  doi = {${ref.doi}},\n`;
            if (ref.url) bibtex += `  url = {${ref.url}},\n`;
            
            bibtex += '}\n\n';
        }

        return bibtex;
    }

    /**
     * Escape special LaTeX characters
     */
    private escapeLatex(text: string): string {
        return text
            .replace(/\\/g, '\\textbackslash{}')
            .replace(/[&%$#_{}]/g, '\\$&')
            .replace(/\^/g, '\\textasciicircum{}')
            .replace(/~/g, '\\textasciitilde{}');
    }

    /**
     * Validate paper content against template requirements
     */
    validateContent(templateId: string, content: PaperContent): string[] {
        const errors: string[] = [];
        const template = this.templates.get(templateId);

        if (!template) {
            errors.push(`Template ${templateId} not found`);
            return errors;
        }

        // Check required fields
        if (!content.title) errors.push('Title is required');
        if (!content.authors || content.authors.length === 0) errors.push('At least one author is required');
        if (!content.abstract) errors.push('Abstract is required');

        // Check required sections
        const sectionTitles = new Set(content.sections.map(s => 
            s.title.toLowerCase().replace(/\s+/g, '_')
        ));

        for (const required of template.requiredSections) {
            if (!sectionTitles.has(required)) {
                errors.push(`Required section missing: ${required}`);
            }
        }

        return errors;
    }

    /**
     * Add a custom template
     */
    async addCustomTemplate(
        name: string,
        content: string,
        metadata?: Partial<TemplateInfo>
    ): Promise<string> {
        // Ensure custom templates directory exists
        if (!fs.existsSync(this.customTemplatesDir)) {
            fs.mkdirSync(this.customTemplatesDir, { recursive: true });
        }

        const id = `custom-${name.toLowerCase().replace(/\s+/g, '-')}`;
        const templatePath = path.join(this.customTemplatesDir, `${name}.tex`);
        const metadataPath = path.join(this.customTemplatesDir, `${name}.json`);

        // Write template file
        fs.writeFileSync(templatePath, content, 'utf8');

        // Write metadata file
        const fullMetadata: TemplateInfo = {
            id,
            name,
            type: 'custom',
            description: metadata?.description || 'Custom template',
            path: templatePath,
            isBuiltIn: false,
            requiredSections: metadata?.requiredSections || ['abstract', 'introduction', 'conclusion'],
            optionalSections: metadata?.optionalSections || [],
            citationStyle: metadata?.citationStyle || 'numeric'
        };

        fs.writeFileSync(metadataPath, JSON.stringify(fullMetadata, null, 2), 'utf8');

        // Add to templates map
        this.templates.set(id, fullMetadata);

        return id;
    }

    // ========== Embedded Templates ==========

    private getIEEEConferenceTemplate(): string {
        return `\\documentclass[conference]{IEEEtran}
\\usepackage{cite}
\\usepackage{amsmath,amssymb,amsfonts}
\\usepackage{algorithmic}
\\usepackage{graphicx}
\\usepackage{textcomp}
\\usepackage{xcolor}
\\usepackage{hyperref}

\\begin{document}

\\title{{{TITLE}}}

\\author{{{AUTHORS}}}

\\maketitle

\\begin{abstract}
{{ABSTRACT}}
\\end{abstract}

\\begin{IEEEkeywords}
{{KEYWORDS}}
\\end{IEEEkeywords}

{{CONTENT}}

{{ACKNOWLEDGMENTS}}

{{BIBLIOGRAPHY}}

\\end{document}
`;
    }

    private getIEEEJournalTemplate(): string {
        return `\\documentclass[journal]{IEEEtran}
\\usepackage{cite}
\\usepackage{amsmath,amssymb,amsfonts}
\\usepackage{algorithmic}
\\usepackage{graphicx}
\\usepackage{textcomp}
\\usepackage{xcolor}
\\usepackage{hyperref}

\\begin{document}

\\title{{{TITLE}}}

\\author{{{AUTHORS}}}

\\maketitle

\\begin{abstract}
{{ABSTRACT}}
\\end{abstract}

\\begin{IEEEkeywords}
{{KEYWORDS}}
\\end{IEEEkeywords}

{{CONTENT}}

{{ACKNOWLEDGMENTS}}

{{BIBLIOGRAPHY}}

\\end{document}
`;
    }

    private getSpringerLNCSTemplate(): string {
        return `\\documentclass[runningheads]{llncs}
\\usepackage{graphicx}
\\usepackage{hyperref}
\\usepackage{amsmath}

\\begin{document}

\\title{{{TITLE}}}

{{AUTHORS}}

\\maketitle

\\begin{abstract}
{{ABSTRACT}}

\\keywords{{{KEYWORDS}}}
\\end{abstract}

{{CONTENT}}

{{ACKNOWLEDGMENTS}}

{{BIBLIOGRAPHY}}

\\end{document}
`;
    }

    private getACMTemplate(): string {
        return `\\documentclass[sigconf,review]{acmart}

\\begin{document}

\\title{{{TITLE}}}

\\author{{{AUTHORS}}}

\\begin{abstract}
{{ABSTRACT}}
\\end{abstract}

\\keywords{{{KEYWORDS}}}

\\maketitle

{{CONTENT}}

{{ACKNOWLEDGMENTS}}

{{BIBLIOGRAPHY}}

\\end{document}
`;
    }

    private getAPATemplate(): string {
        return `\\documentclass[man,12pt]{apa7}
\\usepackage[american]{babel}
\\usepackage{csquotes}
\\usepackage[style=apa,sortcites=true,sorting=nyt,backend=biber]{biblatex}

\\title{{{TITLE}}}
\\author{{{AUTHORS}}}
\\affiliation{{{AFFILIATION}}}

\\abstract{{{ABSTRACT}}}

\\keywords{{{KEYWORDS}}}

\\begin{document}
\\maketitle

{{CONTENT}}

{{ACKNOWLEDGMENTS}}

{{BIBLIOGRAPHY}}

\\end{document}
`;
    }

    private getGenericTemplate(): string {
        return `\\documentclass[12pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{hyperref}
\\usepackage{geometry}
\\geometry{margin=1in}

\\title{{{TITLE}}}
\\author{{{AUTHORS}}}
\\date{{{DATE}}}

\\begin{document}

\\maketitle

\\begin{abstract}
{{ABSTRACT}}
\\end{abstract}

{{CONTENT}}

{{ACKNOWLEDGMENTS}}

{{BIBLIOGRAPHY}}

\\end{document}
`;
    }
}
