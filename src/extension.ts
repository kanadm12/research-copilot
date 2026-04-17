import * as vscode from 'vscode';
import { PdfIndexer } from './services/pdfIndexer';
import { SearchService } from './services/searchService';
import { DocumentStore } from './services/documentStore';
import { EmbeddingService } from './services/embeddingService';
import { HighlightService, HighlightColor } from './services/highlightService';
import { CitationExtractor } from './services/citationExtractor';
import { DocxConverter } from './services/docxConverter';
import { PodcastGenerator, PodcastConfig } from './services/podcastGenerator';
import { KnowledgeGraphService } from './services/knowledgeGraphService';
import { ResearchWritingAssistant, WritingRequest } from './services/researchWritingAssistant';
import { ResearchChatParticipant } from './chat/researchParticipant';
import { ResearchToolProvider } from './chat/toolProvider';
import { DocumentTreeProvider } from './views/documentTreeProvider';
import { DashboardPanel } from './views/dashboardPanel';

let pdfIndexer: PdfIndexer;
let searchService: SearchService;
let documentStore: DocumentStore;
let embeddingService: EmbeddingService;
let highlightService: HighlightService;
let citationExtractor: CitationExtractor;
let docxConverter: DocxConverter;
let podcastGenerator: PodcastGenerator;
let knowledgeGraphService: KnowledgeGraphService;
let writingAssistant: ResearchWritingAssistant;
let documentTreeProvider: DocumentTreeProvider;

export async function activate(context: vscode.ExtensionContext) {
    console.log('Research Copilot is now active!');

    // Initialize core services
    documentStore = new DocumentStore(context);
    await documentStore.initialize();

    // Initialize embedding service (MiniLM model for semantic search)
    embeddingService = new EmbeddingService(context);
    
    // Initialize search service with embedding support
    searchService = new SearchService(documentStore, embeddingService);
    
    // Initialize PDF indexer
    pdfIndexer = new PdfIndexer(documentStore, context);

    // Initialize highlight service
    highlightService = new HighlightService(context);
    
    // Initialize citation extractor
    citationExtractor = new CitationExtractor();

    // Initialize DOCX converter and auto-setup in background
    docxConverter = new DocxConverter(context);
    setupDocxConverter(docxConverter);

    // Initialize podcast generator
    podcastGenerator = new PodcastGenerator(context, documentStore);

    // Initialize knowledge graph service
    knowledgeGraphService = new KnowledgeGraphService(context, documentStore, embeddingService);

    // Initialize research writing assistant
    writingAssistant = new ResearchWritingAssistant(context, documentStore, searchService);

    // Set context for conditional UI
    const hasDocuments = documentStore.getDocumentCount() > 0;
    vscode.commands.executeCommand('setContext', 'researchCopilot.hasIndexedDocuments', hasDocuments);

    // Register tree view
    documentTreeProvider = new DocumentTreeProvider(documentStore);
    vscode.window.registerTreeDataProvider('researchCopilotDocuments', documentTreeProvider);

    // Register core commands
    context.subscriptions.push(
        vscode.commands.registerCommand('researchCopilot.indexWorkspace', async () => {
            await indexWorkspace();
        }),

        vscode.commands.registerCommand('researchCopilot.indexFile', async (uri?: vscode.Uri) => {
            if (uri) {
                await indexSingleFile(uri);
            } else {
                // Prompt user to select a file
                const files = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    filters: { 'PDF Files': ['pdf'] },
                    title: 'Select PDF to Index'
                });
                if (files && files[0]) {
                    await indexSingleFile(files[0]);
                }
            }
        }),

        vscode.commands.registerCommand('researchCopilot.showDashboard', () => {
            DashboardPanel.createOrShow(context.extensionUri, documentStore, searchService);
        }),

        vscode.commands.registerCommand('researchCopilot.searchDocuments', async () => {
            const query = await vscode.window.showInputBox({
                prompt: 'Enter search query',
                placeHolder: 'Search your research documents...'
            });
            if (query) {
                const results = await searchService.search(query);
                showSearchResults(results);
            }
        }),

        vscode.commands.registerCommand('researchCopilot.clearIndex', async () => {
            const confirm = await vscode.window.showWarningMessage(
                'Are you sure you want to clear the entire index? This cannot be undone.',
                'Yes, Clear Index',
                'Cancel'
            );
            if (confirm === 'Yes, Clear Index') {
                await documentStore.clearAll();
                vscode.window.showInformationMessage('Research Copilot index cleared.');
                documentTreeProvider.refresh();
            }
        }),

        vscode.commands.registerCommand('researchCopilot.exportNotes', async () => {
            await exportNotesToMarkdown();
        }),

        // Semantic search command
        vscode.commands.registerCommand('researchCopilot.semanticSearch', async () => {
            const query = await vscode.window.showInputBox({
                prompt: 'Semantic search query',
                placeHolder: 'Search using AI-powered semantic understanding...'
            });
            if (query) {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'Searching...',
                    cancellable: false
                }, async () => {
                    const results = await searchService.semanticSearch(query, 10);
                    showSearchResults(results);
                });
            }
        }),

        // Hybrid search command
        vscode.commands.registerCommand('researchCopilot.hybridSearch', async () => {
            const query = await vscode.window.showInputBox({
                prompt: 'Hybrid search query',
                placeHolder: 'Combines keyword and semantic search...'
            });
            if (query) {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'Searching...',
                    cancellable: false
                }, async () => {
                    const results = await searchService.hybridSearch(query, 10);
                    showSearchResults(results);
                });
            }
        }),

        // Build semantic index command
        vscode.commands.registerCommand('researchCopilot.buildSemanticIndex', async () => {
            await searchService.buildEmbeddingIndex();
            vscode.window.showInformationMessage('Semantic search index built successfully!');
        }),

        // Install Python dependencies for DOCX conversion (manual trigger)
        vscode.commands.registerCommand('researchCopilot.installPythonDeps', async () => {
            const success = await docxConverter.installPdf2Docx();
            if (success) {
                vscode.window.showInformationMessage(
                    'PDF conversion dependencies installed successfully!'
                );
            } else {
                vscode.window.showErrorMessage(
                    'Failed to install dependencies. Make sure Python is installed and in PATH.'
                );
            }
        }),

        // Highlight commands
        vscode.commands.registerCommand('researchCopilot.createHighlight', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No active editor');
                return;
            }

            const selection = editor.selection;
            if (selection.isEmpty) {
                vscode.window.showErrorMessage('Please select text to highlight');
                return;
            }

            const text = editor.document.getText(selection);
            
            // Ask for color
            const colorChoice = await vscode.window.showQuickPick(
                ['🟡 Yellow', '🟢 Green', '🔵 Blue', '🩷 Pink', '🟣 Purple', '🟠 Orange'],
                { placeHolder: 'Select highlight color' }
            );
            
            if (!colorChoice) return;
            
            const colorMap: Record<string, HighlightColor> = {
                '🟡 Yellow': 'yellow',
                '🟢 Green': 'green',
                '🔵 Blue': 'blue',
                '🩷 Pink': 'pink',
                '🟣 Purple': 'purple',
                '🟠 Orange': 'orange'
            };
            
            // Ask for optional note
            const note = await vscode.window.showInputBox({
                prompt: 'Add a note (optional)',
                placeHolder: 'Your annotation...'
            });

            // Ask for tags
            const tagsInput = await vscode.window.showInputBox({
                prompt: 'Add tags, comma-separated (optional)',
                placeHolder: 'important, review, methodology'
            });

            const tags = tagsInput 
                ? tagsInput.split(',').map(t => t.trim()).filter(t => t)
                : [];

            // Find document info
            const docPath = editor.document.uri.fsPath;
            const doc = documentStore.findDocumentByPath(docPath);

            highlightService.createHighlight({
                documentId: doc?.id || docPath,
                documentName: doc?.name || editor.document.fileName,
                pageNumber: 1, // Would need to calculate from position
                text,
                startOffset: editor.document.offsetAt(selection.start),
                endOffset: editor.document.offsetAt(selection.end),
                color: colorMap[colorChoice],
                note,
                tags
            });

            // Apply highlight decoration
            highlightService.applyHighlightsToEditor(editor, doc?.id || docPath);
            
            vscode.window.showInformationMessage('Highlight created!');
        }),

        vscode.commands.registerCommand('researchCopilot.viewHighlights', async () => {
            const highlights = highlightService.getAllHighlights();
            
            if (highlights.length === 0) {
                vscode.window.showInformationMessage('No highlights yet. Select text and use "Create Highlight" command.');
                return;
            }

            const items = highlights.map(h => ({
                label: `${highlightService['getColorEmoji'](h.color)} ${h.text.substring(0, 50)}...`,
                description: h.documentName,
                detail: h.note || `Page ${h.pageNumber}`,
                highlight: h
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a highlight to view'
            });

            if (selected) {
                // Show highlight details
                const h = selected.highlight;
                const panel = vscode.window.createWebviewPanel(
                    'highlightDetail',
                    'Highlight Detail',
                    vscode.ViewColumn.Beside,
                    {}
                );
                panel.webview.html = `
                    <h2>📌 Highlight</h2>
                    <p><strong>Document:</strong> ${h.documentName}</p>
                    <p><strong>Page:</strong> ${h.pageNumber}</p>
                    <blockquote style="background: ${h.color}; padding: 10px; border-radius: 5px;">
                        ${h.text}
                    </blockquote>
                    ${h.note ? `<p><strong>Note:</strong> ${h.note}</p>` : ''}
                    ${h.tags.length > 0 ? `<p><strong>Tags:</strong> ${h.tags.join(', ')}</p>` : ''}
                `;
            }
        }),

        vscode.commands.registerCommand('researchCopilot.exportHighlights', async () => {
            const format = await vscode.window.showQuickPick(
                ['Markdown', 'HTML', 'JSON'],
                { placeHolder: 'Select export format' }
            );
            
            if (!format) return;
            
            const content = highlightService.exportHighlights(
                format.toLowerCase() as 'markdown' | 'html' | 'json'
            );
            
            const ext = format === 'Markdown' ? 'md' : format.toLowerCase();
            const uri = await vscode.window.showSaveDialog({
                filters: { [format]: [ext] },
                defaultUri: vscode.Uri.file(`highlights.${ext}`)
            });
            
            if (uri) {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
                vscode.window.showInformationMessage(`Highlights exported to ${uri.fsPath}`);
            }
        }),

        // Citation commands
        vscode.commands.registerCommand('researchCopilot.extractCitations', async () => {
            const documents = documentStore.getAllDocuments();
            
            if (documents.length === 0) {
                vscode.window.showErrorMessage('No documents indexed. Please index PDFs first.');
                return;
            }

            const docChoice = await vscode.window.showQuickPick(
                documents.map(d => ({ label: d.name, document: d })),
                { placeHolder: 'Select document to extract citations from' }
            );

            if (!docChoice) return;

            const doc = docChoice.document;
            const content = documentStore.getDocumentContent(doc.id);
            
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Extracting citations from ${doc.name}...`,
                cancellable: false
            }, async () => {
                const result = citationExtractor.extractCitations(content);
                
                // Show results
                const outputChannel = vscode.window.createOutputChannel('Research Copilot - Citations');
                outputChannel.clear();
                outputChannel.appendLine(`# Citations from ${doc.name}`);
                outputChannel.appendLine(`Citation Style: ${result.citationStyle.toUpperCase()}`);
                outputChannel.appendLine(`Total Citations: ${result.statistics.totalCitations}`);
                outputChannel.appendLine(`Unique References: ${result.statistics.uniqueReferences}`);
                outputChannel.appendLine('');
                outputChannel.appendLine('## In-Text Citations');
                
                for (const cit of result.inTextCitations) {
                    outputChannel.appendLine(`- ${citationExtractor.formatCitation(cit)}`);
                }
                
                outputChannel.appendLine('');
                outputChannel.appendLine('## References');
                
                for (const ref of result.references) {
                    outputChannel.appendLine(`- ${citationExtractor.formatCitation(ref)}`);
                }
                
                outputChannel.show();
            });
        }),

        vscode.commands.registerCommand('researchCopilot.exportBibTeX', async () => {
            const documents = documentStore.getAllDocuments();
            
            if (documents.length === 0) {
                vscode.window.showErrorMessage('No documents indexed.');
                return;
            }

            let allReferences: any[] = [];

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Extracting citations...',
                cancellable: false
            }, async () => {
                for (const doc of documents) {
                    const content = documentStore.getDocumentContent(doc.id);
                    const result = citationExtractor.extractCitations(content);
                    allReferences.push(...result.references);
                }
            });

            const bibtex = citationExtractor.toBibTeX(allReferences);
            
            const uri = await vscode.window.showSaveDialog({
                filters: { 'BibTeX': ['bib'] },
                defaultUri: vscode.Uri.file('references.bib')
            });

            if (uri) {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(bibtex, 'utf8'));
                vscode.window.showInformationMessage(`BibTeX exported to ${uri.fsPath}`);
            }
        }),

        vscode.commands.registerCommand('researchCopilot.findSimilarPassages', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.selection.isEmpty) {
                vscode.window.showErrorMessage('Please select text to find similar passages');
                return;
            }

            const selectedText = editor.document.getText(editor.selection);
            
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Finding similar passages...',
                cancellable: false
            }, async () => {
                const results = await searchService.findSimilarPassages(selectedText, 5);
                showSearchResults(results);
            });
        }),

        // === NEW FEATURES ===

        // Generate Podcast from documents
        vscode.commands.registerCommand('researchCopilot.generatePodcast', async () => {
            const documents = documentStore.getAllDocuments();
            if (documents.length === 0) {
                vscode.window.showErrorMessage('No documents indexed. Please index some PDFs first.');
                return;
            }

            // Select documents
            const docPicks = documents.map(d => ({
                label: d.name,
                description: `${d.pageCount} pages`,
                id: d.id,
                picked: true
            }));

            const selectedDocs = await vscode.window.showQuickPick(docPicks, {
                canPickMany: true,
                placeHolder: 'Select documents for the podcast'
            });

            if (!selectedDocs || selectedDocs.length === 0) return;

            // Select style
            const style = await vscode.window.showQuickPick([
                { label: 'Conversation', description: 'Two people discussing the research', value: 'conversation' },
                { label: 'Lecture', description: 'Educational presentation', value: 'lecture' },
                { label: 'Debate', description: 'Friendly debate between perspectives', value: 'debate' },
                { label: 'Interview', description: 'Q&A format', value: 'interview' },
                { label: 'Summary', description: 'Brief overview', value: 'summary' }
            ], { placeHolder: 'Select podcast style' });

            if (!style) return;

            // Select duration
            const duration = await vscode.window.showQuickPick([
                { label: 'Short (~2 min)', value: 'short' },
                { label: 'Medium (~5 min)', value: 'medium' },
                { label: 'Long (~10 min)', value: 'long' }
            ], { placeHolder: 'Select podcast duration' });

            if (!duration) return;

            // Select voices
            const voices = podcastGenerator.getAvailableVoices();
            const hostVoice = await vscode.window.showQuickPick(
                voices.map(v => ({ label: v.name, description: v.description, value: v.id })),
                { placeHolder: 'Select host voice' }
            );

            if (!hostVoice) return;

            let guestVoice = { value: 'guy' };
            if (style.value !== 'lecture' && style.value !== 'summary') {
                const gv = await vscode.window.showQuickPick(
                    voices.map(v => ({ label: v.name, description: v.description, value: v.id })),
                    { placeHolder: 'Select guest voice' }
                );
                if (gv) guestVoice = gv;
            }

            // Generate podcast
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Generating podcast...',
                cancellable: false
            }, async (progress) => {
                try {
                    const config: PodcastConfig = {
                        style: style.value as any,
                        duration: duration.value as any,
                        voices: {
                            host: hostVoice.value,
                            guest: guestVoice.value
                        }
                    };

                    const result = await podcastGenerator.generatePodcast(
                        selectedDocs.map(d => d.id),
                        config,
                        progress
                    );

                    // Open the transcript and play audio
                    const doc = await vscode.workspace.openTextDocument(result.transcriptPath);
                    await vscode.window.showTextDocument(doc);

                    const playAction = await vscode.window.showInformationMessage(
                        `Podcast generated! Audio saved to ${result.audioPath}`,
                        'Open Audio File',
                        'Open Folder'
                    );

                    if (playAction === 'Open Audio File') {
                        vscode.env.openExternal(vscode.Uri.file(result.audioPath));
                    } else if (playAction === 'Open Folder') {
                        vscode.env.openExternal(vscode.Uri.file(podcastGenerator.getOutputDir()));
                    }
                } catch (error: any) {
                    vscode.window.showErrorMessage(`Failed to generate podcast: ${error.message}`);
                }
            });
        }),

        // Show Knowledge Graph
        vscode.commands.registerCommand('researchCopilot.showKnowledgeGraph', async () => {
            const documents = documentStore.getAllDocuments();
            if (documents.length === 0) {
                vscode.window.showErrorMessage('No documents indexed. Please index some PDFs first.');
                return;
            }

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Building knowledge graph...',
                cancellable: false
            }, async (progress) => {
                try {
                    await knowledgeGraphService.showGraph(progress);
                } catch (error: any) {
                    vscode.window.showErrorMessage(`Failed to build knowledge graph: ${error.message}`);
                }
            });
        }),

        // Export Knowledge Graph
        vscode.commands.registerCommand('researchCopilot.exportKnowledgeGraph', async () => {
            const format = await vscode.window.showQuickPick([
                { label: 'JSON', description: 'Standard JSON format', value: 'json' },
                { label: 'GraphML', description: 'For Gephi, yEd, etc.', value: 'graphml' },
                { label: 'GEXF', description: 'For Gephi', value: 'gexf' }
            ], { placeHolder: 'Select export format' });

            if (!format) return;

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Exporting knowledge graph...',
                cancellable: false
            }, async () => {
                try {
                    const outputPath = await knowledgeGraphService.exportGraph(format.value as any);
                    vscode.window.showInformationMessage(`Knowledge graph exported to ${outputPath}`);
                } catch (error: any) {
                    vscode.window.showErrorMessage(`Failed to export: ${error.message}`);
                }
            });
        }),

        // Research Writing Assistant
        vscode.commands.registerCommand('researchCopilot.writeResearch', async () => {
            const documents = documentStore.getAllDocuments();
            if (documents.length === 0) {
                vscode.window.showErrorMessage('No documents indexed. Please index some PDFs first.');
                return;
            }

            // Select writing type
            const types = writingAssistant.getWritingTypes();
            const writingType = await vscode.window.showQuickPick(
                types.map(t => ({ label: t.label, description: t.description, value: t.id })),
                { placeHolder: 'What would you like to write?' }
            );

            if (!writingType) return;

            // Enter topic
            const topic = await vscode.window.showInputBox({
                prompt: 'Enter the topic or focus for your writing',
                placeHolder: 'e.g., Machine learning applications in healthcare'
            });

            if (!topic) return;

            // Custom prompt for custom type
            let customPrompt: string | undefined;
            if (writingType.value === 'custom') {
                customPrompt = await vscode.window.showInputBox({
                    prompt: 'Enter your custom writing instructions',
                    placeHolder: 'e.g., Write a comparison of the methodologies used in...'
                });
                if (!customPrompt) return;
            }

            // Select citation style
            const styles = writingAssistant.getCitationStyles();
            const citationStyle = await vscode.window.showQuickPick(
                styles.map(s => ({ label: s.label, value: s.id })),
                { placeHolder: 'Select citation style' }
            );

            if (!citationStyle) return;

            // Select documents (optional)
            const useAllDocs = await vscode.window.showQuickPick([
                { label: 'Use all indexed documents', value: 'all' },
                { label: 'Select specific documents', value: 'select' }
            ], { placeHolder: 'Which documents to use?' });

            let selectedDocIds: string[] | undefined;
            if (useAllDocs?.value === 'select') {
                const docPicks = documents.map(d => ({
                    label: d.name,
                    description: `${d.pageCount} pages`,
                    id: d.id,
                    picked: false
                }));

                const selectedDocs = await vscode.window.showQuickPick(docPicks, {
                    canPickMany: true,
                    placeHolder: 'Select documents to use'
                });

                if (selectedDocs && selectedDocs.length > 0) {
                    selectedDocIds = selectedDocs.map(d => d.id);
                }
            }

            // Generate content
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Writing research content...',
                cancellable: false
            }, async (progress) => {
                try {
                    const request: WritingRequest = {
                        type: writingType.value as any,
                        topic,
                        customPrompt,
                        citationStyle: citationStyle.value as any,
                        documentIds: selectedDocIds
                    };

                    const result = await writingAssistant.generate(request, progress);

                    // Ask which format to open
                    const format = await vscode.window.showQuickPick([
                        { label: 'Markdown', description: 'Easy to read and edit', value: 'markdown' },
                        { label: 'LaTeX', description: 'Ready for academic submission', value: 'latex' }
                    ], { placeHolder: 'Which format would you like to open?' });

                    // Create and open the file
                    const content = format?.value === 'latex' ? result.latex : result.markdown;
                    const ext = format?.value === 'latex' ? 'tex' : 'md';
                    
                    const doc = await vscode.workspace.openTextDocument({
                        content,
                        language: ext === 'tex' ? 'latex' : 'markdown'
                    });
                    await vscode.window.showTextDocument(doc);

                    vscode.window.showInformationMessage(
                        `Generated ${writingType.label} with ${result.citations.length} citations. BibTeX saved to writing folder.`
                    );
                } catch (error: any) {
                    vscode.window.showErrorMessage(`Failed to generate content: ${error.message}`);
                }
            });
        })
    );

    // Register Chat Participant with enhanced search
    const chatParticipant = new ResearchChatParticipant(documentStore, searchService, citationExtractor, highlightService);
    context.subscriptions.push(
        vscode.chat.createChatParticipant('researchCopilot.research', chatParticipant.handleRequest.bind(chatParticipant))
    );

    // Register Language Model Tools for Copilot (enhanced)
    const toolProvider = new ResearchToolProvider(documentStore, searchService, citationExtractor, highlightService);
    context.subscriptions.push(
        vscode.lm.registerTool('researchCopilot_searchDocuments', toolProvider.searchDocumentsTool()),
        vscode.lm.registerTool('researchCopilot_getDocumentContent', toolProvider.getDocumentContentTool()),
        vscode.lm.registerTool('researchCopilot_listDocuments', toolProvider.listDocumentsTool()),
        vscode.lm.registerTool('researchCopilot_getDocumentImages', toolProvider.getDocumentImagesTool()),
        vscode.lm.registerTool('researchCopilot_summarizeDocument', toolProvider.summarizeDocumentTool()),
        vscode.lm.registerTool('researchCopilot_semanticSearch', toolProvider.semanticSearchTool()),
        vscode.lm.registerTool('researchCopilot_getCitations', toolProvider.getCitationsTool()),
        vscode.lm.registerTool('researchCopilot_getHighlights', toolProvider.getHighlightsTool())
    );

    // Watch for PDF file changes
    const pdfWatcher = vscode.workspace.createFileSystemWatcher('**/*.pdf');
    const config = vscode.workspace.getConfiguration('researchCopilot');

    if (config.get('autoIndex')) {
        pdfWatcher.onDidCreate(async (uri) => {
            try {
                vscode.window.showInformationMessage(`New PDF detected: ${uri.fsPath}. Indexing...`);
                await indexSingleFile(uri);
                documentTreeProvider.refresh();
            } catch (error) {
                console.error('Error auto-indexing new PDF:', error);
            }
        });

        pdfWatcher.onDidChange(async (uri) => {
            try {
                await indexSingleFile(uri);
                documentTreeProvider.refresh();
            } catch (error) {
                console.error('Error re-indexing changed PDF:', error);
            }
        });

        pdfWatcher.onDidDelete((uri) => {
            try {
                documentStore.removeDocument(uri.fsPath);
                documentTreeProvider.refresh();
            } catch (error) {
                console.error('Error removing deleted PDF:', error);
            }
        });
    }

    context.subscriptions.push(pdfWatcher);

    // Show welcome message on first activation
    const hasShownWelcome = context.globalState.get('researchCopilot.hasShownWelcome');
    if (!hasShownWelcome) {
        showWelcomeMessage();
        context.globalState.update('researchCopilot.hasShownWelcome', true);
    }

    // Auto-index on startup if enabled
    if (config.get('autoIndex')) {
        const pdfs = await vscode.workspace.findFiles('**/*.pdf', '**/node_modules/**');
        if (pdfs.length > 0) {
            const shouldIndex = await vscode.window.showInformationMessage(
                `Found ${pdfs.length} PDF files in workspace. Would you like to index them?`,
                'Index All',
                'Not Now'
            );
            if (shouldIndex === 'Index All') {
                await indexWorkspace();
                documentTreeProvider.refresh();
            }
        }
    }

    return {
        documentStore,
        searchService,
        pdfIndexer
    };
}

async function indexWorkspace() {
    // Check if workspace is open
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('Please open a workspace folder first.');
        return;
    }

    console.log('Searching for PDF files in workspace...');
    const pdfs = await vscode.workspace.findFiles('**/*.pdf', '**/node_modules/**');
    console.log(`Found ${pdfs.length} PDF files`);
    
    if (pdfs.length === 0) {
        vscode.window.showInformationMessage('No PDF files found in workspace.');
        return;
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Research Copilot: Indexing PDFs',
        cancellable: true
    }, async (progress, token) => {
        let processed = 0;
        let failed = 0;
        const total = pdfs.length;

        for (const pdf of pdfs) {
            if (token.isCancellationRequested) {
                break;
            }

            progress.report({
                message: `Processing ${pdf.fsPath} (${processed + 1}/${total})`,
                increment: (1 / total) * 100
            });

            try {
                console.log(`Indexing: ${pdf.fsPath}`);
                await pdfIndexer.indexPdf(pdf.fsPath);
                processed++;
                console.log(`Successfully indexed: ${pdf.fsPath}`);
            } catch (error) {
                failed++;
                console.error(`Failed to index ${pdf.fsPath}:`, error);
                vscode.window.showErrorMessage(`Failed to index ${pdf.fsPath}: ${error}`);
            }
        }

        if (failed > 0) {
            vscode.window.showWarningMessage(`Indexed ${processed} PDF files. ${failed} failed.`);
        } else {
            vscode.window.showInformationMessage(`Successfully indexed ${processed} PDF files.`);
        }
        
        vscode.commands.executeCommand('setContext', 'researchCopilot.hasIndexedDocuments', processed > 0);
        
        // Refresh the tree view
        documentTreeProvider.refresh();
    });
}

async function indexSingleFile(uri: vscode.Uri) {
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Indexing ${uri.fsPath}...`,
        cancellable: false
    }, async () => {
        try {
            await pdfIndexer.indexPdf(uri.fsPath);
            vscode.window.showInformationMessage(`Successfully indexed: ${uri.fsPath}`);
            vscode.commands.executeCommand('setContext', 'researchCopilot.hasIndexedDocuments', true);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to index PDF: ${error}`);
        }
    });
}

function showSearchResults(results: any[]) {
    // Create a quick pick with search results
    const items = results.map(r => ({
        label: r.documentName,
        description: `Page ${r.pageNumber} - Score: ${(r.score * 100).toFixed(1)}%`,
        detail: r.excerpt,
        result: r
    }));

    vscode.window.showQuickPick(items, {
        placeHolder: 'Select a result to view',
        matchOnDescription: true,
        matchOnDetail: true
    }).then(selected => {
        if (selected) {
            // Open the extracted text file or show in preview
            vscode.commands.executeCommand('researchCopilot.showDocument', selected.result.documentPath);
        }
    });
}

async function exportNotesToMarkdown() {
    const documents = documentStore.getAllDocuments();
    
    if (documents.length === 0) {
        vscode.window.showInformationMessage('No documents to export.');
        return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder found.');
        return;
    }

    const exportPath = vscode.Uri.joinPath(workspaceFolder.uri, 'research-notes-export.md');
    
    let markdown = '# Research Notes Export\n\n';
    markdown += `*Exported on ${new Date().toISOString()}*\n\n`;
    markdown += '---\n\n';

    for (const doc of documents) {
        markdown += `## ${doc.name}\n\n`;
        markdown += `**Path:** ${doc.path}\n`;
        markdown += `**Pages:** ${doc.pageCount}\n`;
        markdown += `**Indexed:** ${doc.indexedAt}\n\n`;
        
        if (doc.summary) {
            markdown += `### Summary\n${doc.summary}\n\n`;
        }
        
        markdown += '---\n\n';
    }

    await vscode.workspace.fs.writeFile(exportPath, Buffer.from(markdown, 'utf8'));
    vscode.window.showInformationMessage(`Exported to ${exportPath.fsPath}`);
    
    const doc = await vscode.workspace.openTextDocument(exportPath);
    await vscode.window.showTextDocument(doc);
}

function showWelcomeMessage() {
    vscode.window.showInformationMessage(
        'Welcome to Research Copilot! 📚 Add PDF files to your workspace and use @research in chat to query your documents.',
        'Index PDFs Now',
        'Open Dashboard',
        'Learn More'
    ).then(selection => {
        if (selection === 'Index PDFs Now') {
            vscode.commands.executeCommand('researchCopilot.indexWorkspace');
        } else if (selection === 'Open Dashboard') {
            vscode.commands.executeCommand('researchCopilot.showDashboard');
        } else if (selection === 'Learn More') {
            vscode.env.openExternal(vscode.Uri.parse('https://github.com/research-copilot/research-copilot'));
        }
    });
}

/**
 * Auto-setup DOCX converter in background
 * Installs Python dependencies if needed without blocking extension activation
 */
async function setupDocxConverter(converter: DocxConverter): Promise<void> {
    const config = vscode.workspace.getConfiguration('researchCopilot');
    const useDocxConversion = config.get<boolean>('useDocxConversion', true);
    
    if (!useDocxConversion) {
        console.log('DOCX conversion is disabled in settings');
        return;
    }

    // Run setup in background - don't block activation
    setTimeout(async () => {
        try {
            const pythonAvailable = await converter.checkPythonAvailable();
            if (!pythonAvailable) {
                // Show a non-intrusive message on first run
                const hasShownPythonNotice = await vscode.workspace.getConfiguration('researchCopilot').get('_pythonNoticeShown');
                if (!hasShownPythonNotice) {
                    const action = await vscode.window.showInformationMessage(
                        'Research Copilot: Python is required for enhanced PDF conversion (better images & tables). Install Python for the best experience.',
                        'Download Python',
                        'Remind Me Later',
                        'Use Basic Mode'
                    );
                    
                    if (action === 'Download Python') {
                        vscode.env.openExternal(vscode.Uri.parse('https://www.python.org/downloads/'));
                    } else if (action === 'Use Basic Mode') {
                        // Disable DOCX conversion
                        await vscode.workspace.getConfiguration('researchCopilot').update('useDocxConversion', false, vscode.ConfigurationTarget.Global);
                    }
                    
                    // Mark notice as shown
                    await vscode.workspace.getConfiguration('researchCopilot').update('_pythonNoticeShown', true, vscode.ConfigurationTarget.Global);
                }
                return;
            }

            // Check and install dependencies silently
            const depsInstalled = await converter.checkDependenciesInstalled();
            if (!depsInstalled) {
                console.log('Installing PDF conversion dependencies...');
                const success = await converter.autoSetup(true);
                if (success) {
                    console.log('PDF conversion dependencies installed successfully');
                }
            } else {
                console.log('PDF conversion dependencies already available');
            }
        } catch (error) {
            console.error('Error during DOCX converter setup:', error);
        }
    }, 2000); // Delay 2 seconds to not slow down activation
}

export function deactivate() {
    console.log('Research Copilot deactivating...');
    
    // Clean up services that hold resources
    try {
        if (embeddingService) {
            embeddingService.dispose();
        }
        if (highlightService) {
            highlightService.dispose();
        }
        // PdfIndexer internally manages imageExtractor cleanup
        if (pdfIndexer) {
            pdfIndexer.dispose();
        }
    } catch (error) {
        console.error('Error during cleanup:', error);
    }
    
    console.log('Research Copilot deactivated.');
}
