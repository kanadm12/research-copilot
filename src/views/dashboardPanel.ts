import * as vscode from 'vscode';
import { DocumentStore, DocumentMetadata } from '../services/documentStore';
import { SearchService } from '../services/searchService';

export class DashboardPanel {
    public static currentPanel: DashboardPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private documentStore: DocumentStore;
    private searchService: SearchService;

    public static createOrShow(
        extensionUri: vscode.Uri,
        documentStore: DocumentStore,
        searchService: SearchService
    ) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (DashboardPanel.currentPanel) {
            DashboardPanel.currentPanel._panel.reveal(column);
            DashboardPanel.currentPanel.update();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'researchCopilotDashboard',
            'Research Copilot',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        DashboardPanel.currentPanel = new DashboardPanel(
            panel, 
            extensionUri, 
            documentStore, 
            searchService
        );
    }

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        documentStore: DocumentStore,
        searchService: SearchService
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this.documentStore = documentStore;
        this.searchService = searchService;

        this.update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'search':
                        const results = await this.searchService.search(message.query, 20);
                        this._panel.webview.postMessage({ 
                            command: 'searchResults', 
                            results 
                        });
                        break;
                    case 'indexWorkspace':
                        vscode.commands.executeCommand('researchCopilot.indexWorkspace');
                        break;
                    case 'openDocument':
                        const doc = this.documentStore.getDocument(message.documentId);
                        if (doc?.extractedPath) {
                            vscode.window.showTextDocument(vscode.Uri.file(doc.extractedPath));
                        }
                        break;
                    case 'openPdf':
                        const pdfDoc = this.documentStore.getDocument(message.documentId);
                        if (pdfDoc) {
                            vscode.env.openExternal(vscode.Uri.file(pdfDoc.path));
                        }
                        break;
                    case 'deleteDocument':
                        const docToDelete = this.documentStore.getDocument(message.documentId);
                        if (docToDelete) {
                            await this.documentStore.removeDocument(docToDelete.path);
                            this.update();
                        }
                        break;
                    case 'refresh':
                        this.update();
                        break;
                    case 'openChat':
                        vscode.commands.executeCommand('workbench.action.chat.open');
                        break;
                    case 'buildSemanticIndex':
                        vscode.commands.executeCommand('researchCopilot.buildSemanticIndex');
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    public update() {
        this._panel.webview.html = this._getHtmlForWebview();
    }

    public dispose() {
        DashboardPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _getHtmlForWebview(): string {
        const stats = this.documentStore.getStats();
        const documents = this.documentStore.getAllDocuments();
        
        // Sort documents by indexed date (most recent first)
        const sortedDocs = [...documents].sort((a, b) => 
            new Date(b.indexedAt).getTime() - new Date(a.indexedAt).getTime()
        );

        const recentDocs = sortedDocs.slice(0, 5);
        const totalSize = documents.reduce((sum, d) => sum + d.fileSize, 0);

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Research Copilot</title>
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
            --success: #4ec9b0;
            --warning: #dcdcaa;
            --info: #9cdcfe;
            --gradient-1: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            --gradient-2: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            --gradient-3: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);
            --gradient-4: linear-gradient(135deg, #43e97b 0%, #38f9d7 100%);
        }
        
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        
        body {
            font-family: var(--vscode-font-family);
            background: var(--bg-primary);
            color: var(--text-primary);
            line-height: 1.6;
            overflow-x: hidden;
        }

        /* Sidebar */
        .layout {
            display: flex;
            min-height: 100vh;
        }

        .sidebar {
            width: 260px;
            background: var(--bg-secondary);
            border-right: 1px solid var(--border);
            padding: 20px;
            position: fixed;
            height: 100vh;
            overflow-y: auto;
        }

        .logo {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 10px 0 30px;
            border-bottom: 1px solid var(--border);
            margin-bottom: 20px;
        }

        .logo-icon {
            width: 40px;
            height: 40px;
            background: var(--gradient-1);
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 20px;
        }

        .logo-text {
            font-size: 16px;
            font-weight: 600;
        }

        .logo-subtitle {
            font-size: 11px;
            color: var(--text-secondary);
        }

        .nav-section {
            margin-bottom: 25px;
        }

        .nav-title {
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 1px;
            color: var(--text-secondary);
            margin-bottom: 10px;
        }

        .nav-item {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 12px;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.2s;
            margin-bottom: 4px;
            font-size: 13px;
        }

        .nav-item:hover {
            background: var(--bg-card);
        }

        .nav-item.active {
            background: var(--accent);
            color: white;
        }

        .nav-item-icon {
            font-size: 16px;
            width: 20px;
            text-align: center;
        }

        /* Main Content */
        .main {
            flex: 1;
            margin-left: 260px;
            padding: 30px;
        }

        /* Header */
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 30px;
        }

        .greeting h1 {
            font-size: 28px;
            font-weight: 600;
            margin-bottom: 5px;
        }

        .greeting p {
            color: var(--text-secondary);
            font-size: 14px;
        }

        .header-actions {
            display: flex;
            gap: 10px;
        }

        .btn {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 10px 18px;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s;
            border: none;
        }

        .btn-primary {
            background: var(--accent);
            color: white;
        }

        .btn-primary:hover {
            background: var(--accent-hover);
            transform: translateY(-1px);
        }

        .btn-secondary {
            background: var(--bg-card);
            color: var(--text-primary);
            border: 1px solid var(--border);
        }

        .btn-secondary:hover {
            background: var(--border);
        }

        /* Stats Cards */
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 20px;
            margin-bottom: 30px;
        }

        .stat-card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 20px;
            position: relative;
            overflow: hidden;
        }

        .stat-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 3px;
        }

        .stat-card:nth-child(1)::before { background: var(--gradient-1); }
        .stat-card:nth-child(2)::before { background: var(--gradient-2); }
        .stat-card:nth-child(3)::before { background: var(--gradient-3); }
        .stat-card:nth-child(4)::before { background: var(--gradient-4); }

        .stat-icon {
            width: 45px;
            height: 45px;
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 20px;
            margin-bottom: 15px;
        }

        .stat-card:nth-child(1) .stat-icon { background: rgba(102, 126, 234, 0.15); }
        .stat-card:nth-child(2) .stat-icon { background: rgba(240, 147, 251, 0.15); }
        .stat-card:nth-child(3) .stat-icon { background: rgba(79, 172, 254, 0.15); }
        .stat-card:nth-child(4) .stat-icon { background: rgba(67, 233, 123, 0.15); }

        .stat-value {
            font-size: 32px;
            font-weight: 700;
            margin-bottom: 5px;
        }

        .stat-label {
            font-size: 13px;
            color: var(--text-secondary);
        }

        /* Search Box */
        .search-box {
            position: relative;
            margin-bottom: 30px;
        }

        .search-input {
            width: 100%;
            padding: 16px 20px 16px 50px;
            font-size: 15px;
            border: 2px solid var(--border);
            border-radius: 12px;
            background: var(--bg-card);
            color: var(--text-primary);
            transition: all 0.2s;
        }

        .search-input:focus {
            outline: none;
            border-color: var(--accent);
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }

        .search-icon {
            position: absolute;
            left: 18px;
            top: 50%;
            transform: translateY(-50%);
            font-size: 18px;
            color: var(--text-secondary);
        }

        .search-hint {
            position: absolute;
            right: 18px;
            top: 50%;
            transform: translateY(-50%);
            font-size: 12px;
            color: var(--text-secondary);
            background: var(--bg-secondary);
            padding: 4px 8px;
            border-radius: 4px;
        }

        /* Content Grid */
        .content-grid {
            display: grid;
            grid-template-columns: 1fr 350px;
            gap: 25px;
        }

        /* Documents Section */
        .section {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 20px;
        }

        .section-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        }

        .section-title {
            font-size: 16px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .badge {
            background: var(--accent);
            color: white;
            font-size: 11px;
            padding: 2px 8px;
            border-radius: 10px;
        }

        /* Document Card */
        .doc-card {
            display: flex;
            gap: 15px;
            padding: 15px;
            border: 1px solid var(--border);
            border-radius: 10px;
            margin-bottom: 12px;
            cursor: pointer;
            transition: all 0.2s;
            position: relative;
        }

        .doc-card:hover {
            border-color: var(--accent);
            transform: translateX(5px);
        }

        .doc-icon {
            width: 50px;
            height: 60px;
            background: linear-gradient(135deg, #ff6b6b 0%, #ee5a5a 100%);
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
            flex-shrink: 0;
        }

        .doc-content {
            flex: 1;
            min-width: 0;
        }

        .doc-title {
            font-weight: 600;
            font-size: 14px;
            margin-bottom: 6px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .doc-meta {
            display: flex;
            gap: 15px;
            font-size: 12px;
            color: var(--text-secondary);
            margin-bottom: 8px;
        }

        .doc-meta span {
            display: flex;
            align-items: center;
            gap: 4px;
        }

        .doc-summary {
            font-size: 12px;
            color: var(--text-secondary);
            line-height: 1.5;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
        }

        .doc-actions {
            position: absolute;
            right: 10px;
            top: 10px;
            display: none;
            gap: 5px;
        }

        .doc-card:hover .doc-actions {
            display: flex;
        }

        .doc-action-btn {
            width: 28px;
            height: 28px;
            border-radius: 6px;
            border: none;
            background: var(--bg-secondary);
            color: var(--text-primary);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            transition: all 0.2s;
        }

        .doc-action-btn:hover {
            background: var(--accent);
            color: white;
        }

        /* Quick Actions */
        .quick-actions {
            display: grid;
            gap: 10px;
            margin-bottom: 20px;
        }

        .quick-action {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 14px;
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            border-radius: 10px;
            cursor: pointer;
            transition: all 0.2s;
        }

        .quick-action:hover {
            border-color: var(--accent);
            background: var(--bg-card);
        }

        .quick-action-icon {
            width: 40px;
            height: 40px;
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 18px;
        }

        .qa-chat .quick-action-icon { background: rgba(102, 126, 234, 0.15); }
        .qa-search .quick-action-icon { background: rgba(79, 172, 254, 0.15); }
        .qa-index .quick-action-icon { background: rgba(67, 233, 123, 0.15); }

        .quick-action-text h4 {
            font-size: 13px;
            font-weight: 600;
            margin-bottom: 2px;
        }

        .quick-action-text p {
            font-size: 11px;
            color: var(--text-secondary);
        }

        /* Tips Section */
        .tips-card {
            background: linear-gradient(135deg, rgba(102, 126, 234, 0.1) 0%, rgba(118, 75, 162, 0.1) 100%);
            border: 1px solid rgba(102, 126, 234, 0.3);
            border-radius: 10px;
            padding: 15px;
        }

        .tips-title {
            font-size: 13px;
            font-weight: 600;
            margin-bottom: 10px;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .tip-item {
            font-size: 12px;
            color: var(--text-secondary);
            margin-bottom: 8px;
            padding-left: 15px;
            position: relative;
        }

        .tip-item::before {
            content: '→';
            position: absolute;
            left: 0;
            color: var(--accent);
        }

        /* Search Results */
        .search-results {
            margin-bottom: 20px;
        }

        .search-result {
            padding: 15px;
            border: 1px solid var(--border);
            border-radius: 10px;
            margin-bottom: 10px;
            cursor: pointer;
            transition: all 0.2s;
        }

        .search-result:hover {
            border-color: var(--accent);
        }

        .search-result-header {
            display: flex;
            justify-content: space-between;
            margin-bottom: 8px;
        }

        .search-result-doc {
            font-weight: 600;
            font-size: 13px;
        }

        .search-result-score {
            font-size: 12px;
            color: var(--success);
            background: rgba(78, 201, 176, 0.15);
            padding: 2px 8px;
            border-radius: 4px;
        }

        .search-result-excerpt {
            font-size: 13px;
            color: var(--text-secondary);
            line-height: 1.5;
        }

        .search-result-excerpt mark {
            background: rgba(255, 213, 79, 0.3);
            color: inherit;
            padding: 0 2px;
            border-radius: 2px;
        }

        /* Empty State */
        .empty-state {
            text-align: center;
            padding: 50px 20px;
        }

        .empty-icon {
            font-size: 64px;
            margin-bottom: 20px;
        }

        .empty-state h3 {
            font-size: 18px;
            margin-bottom: 10px;
        }

        .empty-state p {
            color: var(--text-secondary);
            font-size: 14px;
            margin-bottom: 20px;
        }

        /* Animations */
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .doc-card, .stat-card, .section {
            animation: fadeIn 0.3s ease-out forwards;
        }

        /* Responsive */
        @media (max-width: 1200px) {
            .content-grid {
                grid-template-columns: 1fr;
            }
            .stats-grid {
                grid-template-columns: repeat(2, 1fr);
            }
        }

        @media (max-width: 800px) {
            .sidebar {
                display: none;
            }
            .main {
                margin-left: 0;
            }
        }
    </style>
</head>
<body>
    <div class="layout">
        <aside class="sidebar">
            <div class="logo">
                <div class="logo-icon">📚</div>
                <div>
                    <div class="logo-text">Research Copilot</div>
                    <div class="logo-subtitle">Your AI Research Assistant</div>
                </div>
            </div>

            <nav class="nav-section">
                <div class="nav-title">Navigation</div>
                <div class="nav-item active">
                    <span class="nav-item-icon">🏠</span>
                    <span>Dashboard</span>
                </div>
                <div class="nav-item" onclick="openChat()">
                    <span class="nav-item-icon">💬</span>
                    <span>Ask @research</span>
                </div>
            </nav>

            <nav class="nav-section">
                <div class="nav-title">Actions</div>
                <div class="nav-item" onclick="indexWorkspace()">
                    <span class="nav-item-icon">📥</span>
                    <span>Index PDFs</span>
                </div>
                <div class="nav-item" onclick="buildSemanticIndex()">
                    <span class="nav-item-icon">🧠</span>
                    <span>Build AI Index</span>
                </div>
                <div class="nav-item" onclick="refresh()">
                    <span class="nav-item-icon">🔄</span>
                    <span>Refresh</span>
                </div>
            </nav>

            <nav class="nav-section">
                <div class="nav-title">Resources</div>
                <div class="nav-item">
                    <span class="nav-item-icon">📖</span>
                    <span>Documentation</span>
                </div>
                <div class="nav-item">
                    <span class="nav-item-icon">⚙️</span>
                    <span>Settings</span>
                </div>
            </nav>
        </aside>

        <main class="main">
            <header class="header">
                <div class="greeting">
                    <h1>Welcome to Research Copilot</h1>
                    <p>Your AI-powered research knowledge base • ${documents.length} documents indexed</p>
                </div>
                <div class="header-actions">
                    <button class="btn btn-secondary" onclick="refresh()">
                        🔄 Refresh
                    </button>
                    <button class="btn btn-primary" onclick="indexWorkspace()">
                        📥 Index Workspace
                    </button>
                </div>
            </header>

            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-icon">📄</div>
                    <div class="stat-value">${stats.documentCount}</div>
                    <div class="stat-label">Documents</div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon">📑</div>
                    <div class="stat-value">${stats.totalPages}</div>
                    <div class="stat-label">Total Pages</div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon">🔤</div>
                    <div class="stat-value">${stats.totalChunks}</div>
                    <div class="stat-label">Text Chunks</div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon">💾</div>
                    <div class="stat-value">${this.formatSize(totalSize)}</div>
                    <div class="stat-label">Total Size</div>
                </div>
            </div>

            <div class="search-box">
                <span class="search-icon">🔍</span>
                <input 
                    type="text" 
                    class="search-input" 
                    placeholder="Search across all your research documents..."
                    onkeyup="handleSearch(event)"
                    id="searchInput"
                >
                <span class="search-hint">Press Enter to search</span>
            </div>

            <div id="searchResults" class="search-results"></div>

            <div class="content-grid">
                <div class="section">
                    <div class="section-header">
                        <div class="section-title">
                            📚 Your Research Library
                            <span class="badge">${documents.length}</span>
                        </div>
                    </div>
                    
                    ${documents.length > 0 ? sortedDocs.map(doc => `
                        <div class="doc-card" onclick="openDocument('${doc.id}')">
                            <div class="doc-icon">📄</div>
                            <div class="doc-content">
                                <div class="doc-title">${this.escapeHtml(doc.name)}</div>
                                <div class="doc-meta">
                                    <span>📑 ${doc.pageCount} pages</span>
                                    <span>🔤 ${doc.chunks.length} chunks</span>
                                    <span>💾 ${this.formatSize(doc.fileSize)}</span>
                                </div>
                                <div class="doc-summary">${this.escapeHtml(doc.summary || 'No summary available')}</div>
                            </div>
                            <div class="doc-actions">
                                <button class="doc-action-btn" onclick="event.stopPropagation(); openPdf('${doc.id}')" title="Open PDF">📂</button>
                                <button class="doc-action-btn" onclick="event.stopPropagation(); deleteDocument('${doc.id}')" title="Remove">🗑️</button>
                            </div>
                        </div>
                    `).join('') : `
                        <div class="empty-state">
                            <div class="empty-icon">📂</div>
                            <h3>No documents indexed yet</h3>
                            <p>Add PDF files to your workspace and click "Index Workspace" to build your research knowledge base.</p>
                            <button class="btn btn-primary" onclick="indexWorkspace()">
                                📥 Index PDFs Now
                            </button>
                        </div>
                    `}
                </div>

                <div>
                    <div class="section" style="margin-bottom: 20px;">
                        <div class="section-header">
                            <div class="section-title">⚡ Quick Actions</div>
                        </div>
                        <div class="quick-actions">
                            <div class="quick-action qa-chat" onclick="openChat()">
                                <div class="quick-action-icon">💬</div>
                                <div class="quick-action-text">
                                    <h4>Ask @research</h4>
                                    <p>Chat with your documents</p>
                                </div>
                            </div>
                            <div class="quick-action qa-search" onclick="document.getElementById('searchInput').focus()">
                                <div class="quick-action-icon">🔍</div>
                                <div class="quick-action-text">
                                    <h4>Search Documents</h4>
                                    <p>Find information fast</p>
                                </div>
                            </div>
                            <div class="quick-action qa-index" onclick="indexWorkspace()">
                                <div class="quick-action-icon">📥</div>
                                <div class="quick-action-text">
                                    <h4>Index New PDFs</h4>
                                    <p>Add more documents</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="section">
                        <div class="tips-card">
                            <div class="tips-title">💡 Pro Tips</div>
                            <div class="tip-item">Type <strong>@research</strong> in Copilot Chat to query your docs</div>
                            <div class="tip-item">Use semantic search for conceptual queries</div>
                            <div class="tip-item">PDFs are auto-indexed when added to workspace</div>
                            <div class="tip-item">Extracted text is saved as .md files</div>
                        </div>
                    </div>
                </div>
            </div>
        </main>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        
        function handleSearch(event) {
            if (event.key === 'Enter') {
                const query = document.getElementById('searchInput').value;
                if (query.trim()) {
                    vscode.postMessage({ command: 'search', query });
                }
            }
        }
        
        function openDocument(documentId) {
            vscode.postMessage({ command: 'openDocument', documentId });
        }
        
        function openPdf(documentId) {
            vscode.postMessage({ command: 'openPdf', documentId });
        }
        
        function deleteDocument(documentId) {
            if (confirm('Remove this document from the index?')) {
                vscode.postMessage({ command: 'deleteDocument', documentId });
            }
        }
        
        function indexWorkspace() {
            vscode.postMessage({ command: 'indexWorkspace' });
        }
        
        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }
        
        function openChat() {
            vscode.postMessage({ command: 'openChat' });
        }
        
        function buildSemanticIndex() {
            vscode.postMessage({ command: 'buildSemanticIndex' });
        }
        
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'searchResults') {
                const container = document.getElementById('searchResults');
                if (message.results.length === 0) {
                    container.innerHTML = '<div class="section"><p style="text-align: center; padding: 20px; color: var(--text-secondary);">No results found. Try different keywords.</p></div>';
                    return;
                }
                
                container.innerHTML = '<div class="section"><div class="section-header"><div class="section-title">🔍 Search Results <span class="badge">' + message.results.length + '</span></div></div>' + message.results.map(r => \`
                    <div class="search-result" onclick="openDocument('\${r.documentId}')">
                        <div class="search-result-header">
                            <span class="search-result-doc">📄 \${r.documentName} • Page \${r.pageNumber}</span>
                            <span class="search-result-score">\${(r.score * 100).toFixed(0)}% match</span>
                        </div>
                        <div class="search-result-excerpt">\${r.excerpt}</div>
                    </div>
                \`).join('') + '</div>';
            }
        });
    </script>
</body>
</html>`;
    }

    private formatSize(bytes: number): string {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
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
