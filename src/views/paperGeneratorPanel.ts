import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DocumentStore, DocumentMetadata } from '../services/documentStore';
import { TemplateManager, TemplateInfo, PaperContent } from '../services/templateManager';
import { ResearchWritingAssistant } from '../services/researchWritingAssistant';
import { SearchService } from '../services/searchService';

/**
 * PaperGeneratorPanel - WebView UI for generating research papers
 * 
 * Features:
 * - Template selection with preview
 * - Author/metadata configuration
 * - Section ordering and editing
 * - AI-assisted content generation
 * - Export to LaTeX/PDF
 */
export class PaperGeneratorPanel {
    public static currentPanel: PaperGeneratorPanel | undefined;
    
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    
    private documentStore: DocumentStore;
    private templateManager: TemplateManager;
    private writingAssistant: ResearchWritingAssistant;
    private searchService: SearchService;
    
    // Current paper state
    private currentPaper: Partial<PaperContent> = {
        title: '',
        authors: [],
        abstract: '',
        keywords: [],
        sections: [],
        references: []
    };
    private selectedTemplate: string = 'ieee-conference';

    public static createOrShow(
        extensionUri: vscode.Uri,
        documentStore: DocumentStore,
        templateManager: TemplateManager,
        writingAssistant: ResearchWritingAssistant,
        searchService: SearchService
    ) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (PaperGeneratorPanel.currentPanel) {
            PaperGeneratorPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'researchCopilotPaperGenerator',
            '📝 Research Paper Generator',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        PaperGeneratorPanel.currentPanel = new PaperGeneratorPanel(
            panel,
            extensionUri,
            documentStore,
            templateManager,
            writingAssistant,
            searchService
        );
    }

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        documentStore: DocumentStore,
        templateManager: TemplateManager,
        writingAssistant: ResearchWritingAssistant,
        searchService: SearchService
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this.documentStore = documentStore;
        this.templateManager = templateManager;
        this.writingAssistant = writingAssistant;
        this.searchService = searchService;

        this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Handle messages from webview
        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'selectTemplate':
                        this.selectedTemplate = message.templateId;
                        this._update();
                        break;

                    case 'updatePaper':
                        this.currentPaper = { ...this.currentPaper, ...message.paper };
                        break;

                    case 'generateSection':
                        await this.generateSection(message.sectionType, message.topic);
                        break;

                    case 'generateAbstract':
                        await this.generateAbstract();
                        break;

                    case 'generateFullPaper':
                        await this.generateFullPaper(message.topic);
                        break;

                    case 'exportLatex':
                        await this.exportLatex();
                        break;

                    case 'exportPdf':
                        await this.exportPdf();
                        break;

                    case 'saveDraft':
                        await this.saveDraft();
                        break;

                    case 'loadDraft':
                        await this.loadDraft();
                        break;

                    case 'addAuthor':
                        this.currentPaper.authors = [
                            ...(this.currentPaper.authors || []),
                            { name: '', affiliation: '', email: '' }
                        ];
                        this._update();
                        break;

                    case 'addSection':
                        this.currentPaper.sections = [
                            ...(this.currentPaper.sections || []),
                            { title: message.title || 'New Section', content: '' }
                        ];
                        this._update();
                        break;

                    case 'reorderSections':
                        if (this.currentPaper.sections) {
                            const sections = [...this.currentPaper.sections];
                            const [moved] = sections.splice(message.fromIndex, 1);
                            sections.splice(message.toIndex, 0, moved);
                            this.currentPaper.sections = sections;
                        }
                        this._update();
                        break;

                    case 'deleteSection':
                        if (this.currentPaper.sections) {
                            this.currentPaper.sections = this.currentPaper.sections.filter(
                                (_, i) => i !== message.index
                            );
                        }
                        this._update();
                        break;

                    case 'getSourceDocuments':
                        const docs = this.documentStore.getAllDocuments();
                        this._panel.webview.postMessage({
                            command: 'sourceDocuments',
                            documents: docs.map(d => ({
                                id: d.id,
                                name: d.name,
                                pageCount: d.pageCount
                            }))
                        });
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    private async generateSection(sectionType: string, topic: string): Promise<void> {
        try {
            this._panel.webview.postMessage({ command: 'generating', section: sectionType });

            const result = await this.writingAssistant.generate({
                type: sectionType as any,
                topic: topic || this.currentPaper.title || 'Research',
                citationStyle: 'ieee'
            });

            // Add section to paper
            const sectionTitle = sectionType.charAt(0).toUpperCase() + sectionType.slice(1).replace(/_/g, ' ');
            
            if (!this.currentPaper.sections) {
                this.currentPaper.sections = [];
            }

            const existingIndex = this.currentPaper.sections.findIndex(
                s => s.title.toLowerCase() === sectionTitle.toLowerCase()
            );

            if (existingIndex >= 0) {
                this.currentPaper.sections[existingIndex].content = result.content;
            } else {
                this.currentPaper.sections.push({
                    title: sectionTitle,
                    content: result.content
                });
            }

            // Add citations as references
            for (const citation of result.citations) {
                const exists = this.currentPaper.references?.some(r => r.key === citation.key);
                if (!exists) {
                    this.currentPaper.references = [
                        ...(this.currentPaper.references || []),
                        {
                            key: citation.key,
                            type: 'article',
                            title: citation.documentName.replace('.pdf', ''),
                            authors: ['Unknown'],
                            year: new Date().getFullYear()
                        }
                    ];
                }
            }

            this._panel.webview.postMessage({ command: 'generated', section: sectionType });
            this._update();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to generate ${sectionType}: ${error}`);
            this._panel.webview.postMessage({ command: 'generateError', section: sectionType });
        }
    }

    private async generateAbstract(): Promise<void> {
        try {
            this._panel.webview.postMessage({ command: 'generating', section: 'abstract' });

            const result = await this.writingAssistant.generate({
                type: 'abstract',
                topic: this.currentPaper.title || 'Research',
                citationStyle: 'ieee',
                maxLength: 250
            });

            this.currentPaper.abstract = result.content;

            this._panel.webview.postMessage({ command: 'generated', section: 'abstract' });
            this._update();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to generate abstract: ${error}`);
        }
    }

    private async generateFullPaper(topic: string): Promise<void> {
        const template = this.templateManager.getTemplate(this.selectedTemplate);
        if (!template) return;

        const sections = [...template.requiredSections, ...template.optionalSections.slice(0, 2)];

        this._panel.webview.postMessage({ command: 'fullPaperStart', totalSections: sections.length + 1 });

        // Generate abstract first
        await this.generateAbstract();

        // Generate each section
        for (let i = 0; i < sections.length; i++) {
            this._panel.webview.postMessage({ 
                command: 'fullPaperProgress', 
                current: i + 1, 
                section: sections[i] 
            });
            await this.generateSection(sections[i], topic);
        }

        this._panel.webview.postMessage({ command: 'fullPaperComplete' });
    }

    private async exportLatex(): Promise<void> {
        try {
            const latex = this.templateManager.fillTemplate(
                this.selectedTemplate,
                this.currentPaper as PaperContent
            );

            // Create output directory
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            const outputDir = workspaceFolder
                ? path.join(workspaceFolder.uri.fsPath, '.research-copilot', 'papers')
                : path.join(this._extensionUri.fsPath, 'output');

            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
            }

            const timestamp = Date.now();
            const filename = `paper_${timestamp}.tex`;
            const filepath = path.join(outputDir, filename);

            fs.writeFileSync(filepath, latex, 'utf8');

            // Also generate BibTeX
            const bibtex = this.templateManager.generateBibTeX(this.currentPaper.references || []);
            const bibFilepath = path.join(outputDir, `paper_${timestamp}.bib`);
            fs.writeFileSync(bibFilepath, bibtex, 'utf8');

            // Open the generated file
            const doc = await vscode.workspace.openTextDocument(filepath);
            await vscode.window.showTextDocument(doc);

            vscode.window.showInformationMessage(`Paper exported to ${filename}`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to export LaTeX: ${error}`);
        }
    }

    private async exportPdf(): Promise<void> {
        // First export LaTeX
        await this.exportLatex();
        
        // Inform user about PDF compilation
        const action = await vscode.window.showInformationMessage(
            'LaTeX file exported. To generate PDF, compile the .tex file using LaTeX (e.g., pdflatex or latexmk).',
            'Open Terminal'
        );

        if (action === 'Open Terminal') {
            vscode.commands.executeCommand('workbench.action.terminal.new');
        }
    }

    private async saveDraft(): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const outputDir = workspaceFolder
            ? path.join(workspaceFolder.uri.fsPath, '.research-copilot', 'drafts')
            : path.join(this._extensionUri.fsPath, 'drafts');

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const draft = {
            template: this.selectedTemplate,
            paper: this.currentPaper,
            savedAt: new Date().toISOString()
        };

        const filename = `draft_${Date.now()}.json`;
        const filepath = path.join(outputDir, filename);

        fs.writeFileSync(filepath, JSON.stringify(draft, null, 2), 'utf8');
        vscode.window.showInformationMessage(`Draft saved: ${filename}`);
    }

    private async loadDraft(): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const draftsDir = workspaceFolder
            ? path.join(workspaceFolder.uri.fsPath, '.research-copilot', 'drafts')
            : path.join(this._extensionUri.fsPath, 'drafts');

        if (!fs.existsSync(draftsDir)) {
            vscode.window.showInformationMessage('No drafts found');
            return;
        }

        const files = fs.readdirSync(draftsDir).filter(f => f.endsWith('.json'));
        if (files.length === 0) {
            vscode.window.showInformationMessage('No drafts found');
            return;
        }

        const selected = await vscode.window.showQuickPick(
            files.map(f => ({
                label: f,
                description: new Date(parseInt(f.split('_')[1])).toLocaleString()
            })),
            { placeHolder: 'Select a draft to load' }
        );

        if (selected) {
            const filepath = path.join(draftsDir, selected.label);
            const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
            
            this.selectedTemplate = data.template;
            this.currentPaper = data.paper;
            this._update();
            
            vscode.window.showInformationMessage('Draft loaded');
        }
    }

    public dispose() {
        PaperGeneratorPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) x.dispose();
        }
    }

    private _update() {
        this._panel.webview.html = this._getHtmlContent();
    }

    private _getHtmlContent(): string {
        const templates = this.templateManager.getAvailableTemplates();
        const selectedTemplateInfo = this.templateManager.getTemplate(this.selectedTemplate);

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Research Paper Generator</title>
    <style>
        :root {
            --bg-primary: var(--vscode-editor-background);
            --bg-secondary: var(--vscode-sideBar-background);
            --bg-card: var(--vscode-editorWidget-background);
            --text-primary: var(--vscode-editor-foreground);
            --text-secondary: var(--vscode-descriptionForeground);
            --accent: var(--vscode-button-background);
            --accent-hover: var(--vscode-button-hoverBackground);
            --border: var(--vscode-panel-border);
            --input-bg: var(--vscode-input-background);
            --input-border: var(--vscode-input-border);
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            background: var(--bg-primary);
            color: var(--text-primary);
            font-family: var(--vscode-font-family);
            padding: 20px;
            line-height: 1.6;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
        }

        h1 {
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        h2 {
            margin: 20px 0 10px;
            font-size: 1.2em;
            color: var(--text-secondary);
        }

        .tabs {
            display: flex;
            gap: 5px;
            border-bottom: 1px solid var(--border);
            margin-bottom: 20px;
        }

        .tab {
            padding: 10px 20px;
            background: transparent;
            border: none;
            color: var(--text-secondary);
            cursor: pointer;
            border-bottom: 2px solid transparent;
            transition: all 0.2s;
        }

        .tab:hover {
            color: var(--text-primary);
        }

        .tab.active {
            color: var(--accent);
            border-bottom-color: var(--accent);
        }

        .tab-content {
            display: none;
        }

        .tab-content.active {
            display: block;
        }

        .template-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
            gap: 15px;
        }

        .template-card {
            background: var(--bg-card);
            border: 2px solid var(--border);
            border-radius: 8px;
            padding: 15px;
            cursor: pointer;
            transition: all 0.2s;
        }

        .template-card:hover {
            border-color: var(--accent);
        }

        .template-card.selected {
            border-color: var(--accent);
            background: color-mix(in srgb, var(--accent) 10%, var(--bg-card));
        }

        .template-card h3 {
            margin-bottom: 5px;
        }

        .template-card p {
            font-size: 0.9em;
            color: var(--text-secondary);
        }

        .form-group {
            margin-bottom: 15px;
        }

        label {
            display: block;
            margin-bottom: 5px;
            font-weight: 500;
        }

        input, textarea, select {
            width: 100%;
            padding: 8px 12px;
            background: var(--input-bg);
            border: 1px solid var(--input-border);
            border-radius: 4px;
            color: var(--text-primary);
            font-family: inherit;
        }

        textarea {
            min-height: 100px;
            resize: vertical;
        }

        button {
            padding: 8px 16px;
            background: var(--accent);
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-family: inherit;
            transition: background 0.2s;
        }

        button:hover {
            background: var(--accent-hover);
        }

        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        button.secondary {
            background: transparent;
            border: 1px solid var(--border);
            color: var(--text-primary);
        }

        button.secondary:hover {
            background: var(--bg-secondary);
        }

        .button-group {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
        }

        .author-card {
            background: var(--bg-secondary);
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 10px;
        }

        .author-card .form-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
        }

        .section-card {
            background: var(--bg-secondary);
            border-radius: 8px;
            margin-bottom: 10px;
            overflow: hidden;
        }

        .section-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 15px;
            background: var(--bg-card);
            cursor: grab;
        }

        .section-header:active {
            cursor: grabbing;
        }

        .section-body {
            padding: 15px;
        }

        .section-actions {
            display: flex;
            gap: 5px;
        }

        .section-actions button {
            padding: 4px 8px;
            font-size: 0.9em;
        }

        .progress-bar {
            width: 100%;
            height: 8px;
            background: var(--bg-secondary);
            border-radius: 4px;
            overflow: hidden;
            margin: 10px 0;
        }

        .progress-bar .fill {
            height: 100%;
            background: var(--accent);
            transition: width 0.3s;
        }

        .status {
            padding: 10px;
            background: var(--bg-secondary);
            border-radius: 4px;
            margin: 10px 0;
            font-size: 0.9em;
        }

        .status.generating {
            border-left: 3px solid var(--accent);
        }

        .export-section {
            display: flex;
            gap: 10px;
            padding: 20px;
            background: var(--bg-secondary);
            border-radius: 8px;
            margin-top: 20px;
        }

        .preview-panel {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 20px;
            max-height: 500px;
            overflow-y: auto;
            font-family: 'Times New Roman', serif;
        }

        .preview-panel h1 {
            font-size: 1.5em;
            text-align: center;
        }

        .preview-panel .author {
            text-align: center;
            margin: 10px 0;
        }

        .preview-panel .abstract {
            font-style: italic;
            margin: 20px 0;
            padding: 10px;
            background: var(--bg-secondary);
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }

        .generating-indicator {
            animation: pulse 1.5s infinite;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>📝 Research Paper Generator</h1>

        <div class="tabs">
            <button class="tab active" data-tab="template">1. Template</button>
            <button class="tab" data-tab="metadata">2. Metadata</button>
            <button class="tab" data-tab="content">3. Content</button>
            <button class="tab" data-tab="preview">4. Preview</button>
        </div>

        <!-- Template Selection -->
        <div id="template-tab" class="tab-content active">
            <h2>Select a Template</h2>
            <div class="template-grid">
                ${templates.map(t => `
                    <div class="template-card ${t.id === this.selectedTemplate ? 'selected' : ''}" 
                         data-template="${t.id}">
                        <h3>${t.name}</h3>
                        <p>${t.description}</p>
                        <p><small>Citation style: ${t.citationStyle}</small></p>
                    </div>
                `).join('')}
            </div>
        </div>

        <!-- Metadata -->
        <div id="metadata-tab" class="tab-content">
            <h2>Paper Metadata</h2>
            
            <div class="form-group">
                <label>Title</label>
                <input type="text" id="title" value="${this.escapeHtml(this.currentPaper.title || '')}" 
                       placeholder="Enter paper title">
            </div>

            <h2>Authors</h2>
            <div id="authors-container">
                ${(this.currentPaper.authors || []).map((author, i) => `
                    <div class="author-card">
                        <div class="form-row">
                            <div class="form-group">
                                <label>Name</label>
                                <input type="text" class="author-name" data-index="${i}" 
                                       value="${this.escapeHtml(author.name)}" placeholder="Author name">
                            </div>
                            <div class="form-group">
                                <label>Email</label>
                                <input type="email" class="author-email" data-index="${i}" 
                                       value="${this.escapeHtml(author.email || '')}" placeholder="Email">
                            </div>
                        </div>
                        <div class="form-group">
                            <label>Affiliation</label>
                            <input type="text" class="author-affiliation" data-index="${i}" 
                                   value="${this.escapeHtml(author.affiliation || '')}" placeholder="University/Organization">
                        </div>
                    </div>
                `).join('')}
            </div>
            <button onclick="addAuthor()">+ Add Author</button>

            <div class="form-group" style="margin-top: 20px;">
                <label>Keywords (comma-separated)</label>
                <input type="text" id="keywords" 
                       value="${this.escapeHtml((this.currentPaper.keywords || []).join(', '))}"
                       placeholder="keyword1, keyword2, keyword3">
            </div>
        </div>

        <!-- Content -->
        <div id="content-tab" class="tab-content">
            <h2>Paper Content</h2>
            
            <div class="form-group">
                <label>Abstract</label>
                <textarea id="abstract" placeholder="Enter or generate abstract">${this.escapeHtml(this.currentPaper.abstract || '')}</textarea>
                <button onclick="generateAbstract()" style="margin-top: 5px;">🤖 Generate Abstract</button>
            </div>

            <h2>Sections</h2>
            <div id="sections-container">
                ${(this.currentPaper.sections || []).map((section, i) => `
                    <div class="section-card" data-index="${i}">
                        <div class="section-header">
                            <span>📄 ${this.escapeHtml(section.title)}</span>
                            <div class="section-actions">
                                <button onclick="generateSectionContent(${i})">🤖 Generate</button>
                                <button class="secondary" onclick="deleteSection(${i})">🗑️</button>
                            </div>
                        </div>
                        <div class="section-body">
                            <textarea class="section-content" data-index="${i}" 
                                      placeholder="Section content...">${this.escapeHtml(section.content)}</textarea>
                        </div>
                    </div>
                `).join('')}
            </div>
            
            <div class="button-group" style="margin-top: 15px;">
                <button onclick="addSection('Introduction')">+ Introduction</button>
                <button onclick="addSection('Related Work')">+ Related Work</button>
                <button onclick="addSection('Methodology')">+ Methodology</button>
                <button onclick="addSection('Results')">+ Results</button>
                <button onclick="addSection('Discussion')">+ Discussion</button>
                <button onclick="addSection('Conclusion')">+ Conclusion</button>
            </div>

            <div id="generation-status" class="status" style="display: none;">
                <span class="generating-indicator">⏳ Generating...</span>
                <div class="progress-bar"><div class="fill" style="width: 0%"></div></div>
            </div>

            <div class="button-group" style="margin-top: 20px;">
                <button onclick="generateFullPaper()">🚀 Generate Full Paper</button>
            </div>
        </div>

        <!-- Preview -->
        <div id="preview-tab" class="tab-content">
            <h2>Preview</h2>
            <div class="preview-panel">
                <h1>${this.escapeHtml(this.currentPaper.title || 'Untitled Paper')}</h1>
                ${(this.currentPaper.authors || []).map(a => 
                    `<p class="author">${this.escapeHtml(a.name)}${a.affiliation ? ` - ${this.escapeHtml(a.affiliation)}` : ''}</p>`
                ).join('')}
                ${this.currentPaper.abstract ? `
                    <div class="abstract">
                        <strong>Abstract:</strong> ${this.escapeHtml(this.currentPaper.abstract)}
                    </div>
                ` : ''}
                ${this.currentPaper.keywords?.length ? `
                    <p><strong>Keywords:</strong> ${this.escapeHtml(this.currentPaper.keywords.join(', '))}</p>
                ` : ''}
                ${(this.currentPaper.sections || []).map(s => `
                    <h2>${this.escapeHtml(s.title)}</h2>
                    <p>${this.escapeHtml(s.content).substring(0, 500)}${s.content.length > 500 ? '...' : ''}</p>
                `).join('')}
            </div>

            <div class="export-section">
                <button onclick="exportLatex()">📄 Export LaTeX</button>
                <button onclick="exportPdf()">📑 Export PDF</button>
                <button class="secondary" onclick="saveDraft()">💾 Save Draft</button>
                <button class="secondary" onclick="loadDraft()">📂 Load Draft</button>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        // Tab switching
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById(tab.dataset.tab + '-tab').classList.add('active');
            });
        });

        // Template selection
        document.querySelectorAll('.template-card').forEach(card => {
            card.addEventListener('click', () => {
                document.querySelectorAll('.template-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                vscode.postMessage({ command: 'selectTemplate', templateId: card.dataset.template });
            });
        });

        // Input handlers
        document.getElementById('title').addEventListener('input', updatePaper);
        document.getElementById('abstract').addEventListener('input', updatePaper);
        document.getElementById('keywords').addEventListener('input', updatePaper);

        document.querySelectorAll('.author-name, .author-email, .author-affiliation').forEach(input => {
            input.addEventListener('input', updatePaper);
        });

        document.querySelectorAll('.section-content').forEach(textarea => {
            textarea.addEventListener('input', updatePaper);
        });

        function updatePaper() {
            const paper = {
                title: document.getElementById('title').value,
                abstract: document.getElementById('abstract').value,
                keywords: document.getElementById('keywords').value.split(',').map(k => k.trim()).filter(k => k),
                authors: [],
                sections: []
            };

            document.querySelectorAll('.author-card').forEach((card, i) => {
                paper.authors.push({
                    name: card.querySelector('.author-name').value,
                    email: card.querySelector('.author-email').value,
                    affiliation: card.querySelector('.author-affiliation').value
                });
            });

            document.querySelectorAll('.section-card').forEach((card, i) => {
                paper.sections.push({
                    title: card.querySelector('.section-header span').textContent.replace('📄 ', ''),
                    content: card.querySelector('.section-content').value
                });
            });

            vscode.postMessage({ command: 'updatePaper', paper });
        }

        function addAuthor() {
            vscode.postMessage({ command: 'addAuthor' });
        }

        function addSection(title) {
            vscode.postMessage({ command: 'addSection', title });
        }

        function deleteSection(index) {
            vscode.postMessage({ command: 'deleteSection', index });
        }

        function generateAbstract() {
            vscode.postMessage({ command: 'generateAbstract' });
        }

        function generateSectionContent(index) {
            const section = document.querySelectorAll('.section-card')[index];
            const title = section.querySelector('.section-header span').textContent.replace('📄 ', '');
            vscode.postMessage({ 
                command: 'generateSection', 
                sectionType: title.toLowerCase().replace(/\\s+/g, '_'),
                topic: document.getElementById('title').value
            });
        }

        function generateFullPaper() {
            const topic = document.getElementById('title').value || 'Research';
            vscode.postMessage({ command: 'generateFullPaper', topic });
        }

        function exportLatex() {
            updatePaper();
            vscode.postMessage({ command: 'exportLatex' });
        }

        function exportPdf() {
            updatePaper();
            vscode.postMessage({ command: 'exportPdf' });
        }

        function saveDraft() {
            updatePaper();
            vscode.postMessage({ command: 'saveDraft' });
        }

        function loadDraft() {
            vscode.postMessage({ command: 'loadDraft' });
        }

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            const status = document.getElementById('generation-status');

            switch (message.command) {
                case 'generating':
                    status.style.display = 'block';
                    status.querySelector('.generating-indicator').textContent = 
                        '⏳ Generating ' + message.section + '...';
                    break;

                case 'generated':
                    status.style.display = 'none';
                    break;

                case 'fullPaperStart':
                    status.style.display = 'block';
                    break;

                case 'fullPaperProgress':
                    const progress = (message.current / (message.totalSections || 1)) * 100;
                    status.querySelector('.fill').style.width = progress + '%';
                    status.querySelector('.generating-indicator').textContent = 
                        '⏳ Generating ' + message.section + '...';
                    break;

                case 'fullPaperComplete':
                    status.style.display = 'none';
                    break;

                case 'generateError':
                    status.style.display = 'none';
                    break;
            }
        });
    </script>
</body>
</html>`;
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}
