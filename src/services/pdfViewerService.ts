import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { BoundingRect, ChunkPosition } from './documentStore';
import { PdfPositionService } from './pdfPositionService';

/**
 * Highlight annotation for PDF viewer
 */
export interface HighlightAnnotation {
    id: string;
    pageNumber: number;
    rects: BoundingRect[];
    color: string;
    label?: string;
    onClick?: string;  // Command to execute on click
}

/**
 * Citation link that can be clicked to open PDF
 */
export interface CitationLink {
    citationId: string;
    documentPath: string;
    documentName: string;
    pageNumber: number;
    text: string;
    position?: ChunkPosition;
}

/**
 * PdfViewerService - Opens PDFs in VS Code webview with highlight overlays
 * 
 * Features:
 * - Render PDF pages using PDF.js
 * - Overlay bounding box highlights on cited passages
 * - Navigate to specific pages
 * - Click-to-copy citation text
 */
export class PdfViewerService {
    private context: vscode.ExtensionContext;
    private positionService: PdfPositionService;
    private panels: Map<string, vscode.WebviewPanel> = new Map();

    constructor(context: vscode.ExtensionContext, positionService: PdfPositionService) {
        this.context = context;
        this.positionService = positionService;
    }

    /**
     * Open a PDF with optional highlight at a specific position
     */
    async openPdfWithHighlight(
        pdfPath: string,
        pageNumber: number = 1,
        highlights: HighlightAnnotation[] = [],
        title?: string
    ): Promise<vscode.WebviewPanel> {
        const pdfName = path.basename(pdfPath);
        const panelKey = pdfPath;

        // Reuse existing panel if open
        let panel = this.panels.get(panelKey);
        if (panel) {
            panel.reveal();
            // Update highlights and navigate to page
            panel.webview.postMessage({
                type: 'navigate',
                pageNumber,
                highlights
            });
            return panel;
        }

        // Create new panel
        panel = vscode.window.createWebviewPanel(
            'researchCopilotPdfViewer',
            title || `📄 ${pdfName}`,
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.file(path.dirname(pdfPath)),
                    this.context.extensionUri
                ]
            }
        );

        this.panels.set(panelKey, panel);

        // Handle panel disposal
        panel.onDidDispose(() => {
            this.panels.delete(panelKey);
        }, null, this.context.subscriptions);

        // Handle messages from webview
        panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.type) {
                    case 'copyText':
                        await vscode.env.clipboard.writeText(message.text);
                        vscode.window.showInformationMessage('Citation text copied to clipboard');
                        break;
                    case 'highlightClicked':
                        // Execute the associated command if any
                        if (message.command) {
                            vscode.commands.executeCommand(message.command, message.data);
                        }
                        break;
                    case 'ready':
                        // Send initial data when viewer is ready
                        panel!.webview.postMessage({
                            type: 'init',
                            pageNumber,
                            highlights
                        });
                        break;
                }
            },
            null,
            this.context.subscriptions
        );

        // Get PDF as base64 for embedding in webview
        const pdfData = fs.readFileSync(pdfPath);
        const pdfBase64 = pdfData.toString('base64');

        panel.webview.html = this.getWebviewContent(pdfBase64, pdfName, pageNumber, highlights);

        return panel;
    }

    /**
     * Open PDF and highlight a specific text passage
     */
    async openPdfAtCitation(citation: CitationLink): Promise<vscode.WebviewPanel | null> {
        if (!fs.existsSync(citation.documentPath)) {
            vscode.window.showErrorMessage(`PDF not found: ${citation.documentPath}`);
            return null;
        }

        let highlights: HighlightAnnotation[] = [];

        if (citation.position) {
            highlights.push({
                id: citation.citationId,
                pageNumber: citation.pageNumber,
                rects: citation.position.normalizedRects || citation.position.rects,
                color: 'rgba(255, 255, 0, 0.4)',
                label: 'Cited passage'
            });
        } else {
            // Try to find position dynamically
            const annotation = await this.positionService.getHighlightAnnotation(
                citation.documentPath,
                citation.pageNumber,
                citation.text
            );

            if (annotation) {
                highlights.push({
                    id: citation.citationId,
                    pageNumber: annotation.page,
                    rects: annotation.normalizedRects,
                    color: annotation.color,
                    label: 'Cited passage'
                });
            }
        }

        return this.openPdfWithHighlight(
            citation.documentPath,
            citation.pageNumber,
            highlights,
            `Citation: ${citation.documentName}`
        );
    }

    /**
     * Generate webview HTML content
     */
    private getWebviewContent(
        pdfBase64: string,
        pdfName: string,
        initialPage: number,
        highlights: HighlightAnnotation[]
    ): string {
        const highlightsJson = JSON.stringify(highlights);

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${pdfName}</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            background: var(--vscode-editor-background, #1e1e1e);
            color: var(--vscode-editor-foreground, #d4d4d4);
            font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
            overflow: hidden;
        }

        .toolbar {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            height: 48px;
            background: var(--vscode-titleBar-activeBackground, #3c3c3c);
            border-bottom: 1px solid var(--vscode-panel-border, #454545);
            display: flex;
            align-items: center;
            padding: 0 16px;
            gap: 12px;
            z-index: 1000;
        }

        .toolbar button {
            background: var(--vscode-button-background, #0e639c);
            color: var(--vscode-button-foreground, white);
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
        }

        .toolbar button:hover {
            background: var(--vscode-button-hoverBackground, #1177bb);
        }

        .toolbar button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .page-info {
            color: var(--vscode-foreground, #cccccc);
            font-size: 13px;
            min-width: 100px;
            text-align: center;
        }

        .zoom-controls {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-left: auto;
        }

        #zoom-level {
            color: var(--vscode-foreground, #cccccc);
            font-size: 13px;
            min-width: 50px;
            text-align: center;
        }

        .viewer-container {
            position: absolute;
            top: 48px;
            left: 0;
            right: 0;
            bottom: 0;
            overflow: auto;
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 20px;
            gap: 20px;
        }

        .page-container {
            position: relative;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            background: white;
        }

        .page-canvas {
            display: block;
        }

        .highlight-layer {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
        }

        .highlight-rect {
            position: absolute;
            pointer-events: auto;
            cursor: pointer;
            transition: all 0.2s ease;
        }

        .highlight-rect:hover {
            filter: brightness(1.2);
        }

        .highlight-rect.flash {
            animation: flash 1s ease-out;
        }

        @keyframes flash {
            0% { opacity: 0.8; transform: scale(1.02); }
            50% { opacity: 1; transform: scale(1.05); }
            100% { opacity: 0.6; transform: scale(1); }
        }

        .loading {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            font-size: 18px;
            color: var(--vscode-foreground, #cccccc);
        }

        .highlight-tooltip {
            position: absolute;
            background: var(--vscode-editorWidget-background, #252526);
            border: 1px solid var(--vscode-editorWidget-border, #454545);
            padding: 8px 12px;
            border-radius: 4px;
            font-size: 12px;
            white-space: nowrap;
            z-index: 1001;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.2s;
        }

        .highlight-tooltip.visible {
            opacity: 1;
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <button id="prev-btn" title="Previous Page">◀ Prev</button>
        <span class="page-info"><span id="current-page">1</span> / <span id="total-pages">?</span></span>
        <button id="next-btn" title="Next Page">Next ▶</button>
        <input type="number" id="page-input" min="1" style="width: 60px; padding: 4px;" title="Go to page">
        <button id="go-btn">Go</button>
        <div class="zoom-controls">
            <button id="zoom-out">−</button>
            <span id="zoom-level">100%</span>
            <button id="zoom-in">+</button>
            <button id="zoom-fit">Fit</button>
        </div>
    </div>

    <div class="viewer-container" id="viewer">
        <div class="loading" id="loading">Loading PDF...</div>
    </div>

    <div class="highlight-tooltip" id="tooltip"></div>

    <script>
        const vscode = acquireVsCodeApi();
        
        // PDF.js configuration
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

        let pdfDoc = null;
        let currentPage = ${initialPage};
        let scale = 1.0;
        let highlights = ${highlightsJson};
        let renderedPages = new Map();

        const viewer = document.getElementById('viewer');
        const loading = document.getElementById('loading');
        const currentPageSpan = document.getElementById('current-page');
        const totalPagesSpan = document.getElementById('total-pages');
        const prevBtn = document.getElementById('prev-btn');
        const nextBtn = document.getElementById('next-btn');
        const pageInput = document.getElementById('page-input');
        const goBtn = document.getElementById('go-btn');
        const zoomIn = document.getElementById('zoom-in');
        const zoomOut = document.getElementById('zoom-out');
        const zoomLevel = document.getElementById('zoom-level');
        const zoomFit = document.getElementById('zoom-fit');
        const tooltip = document.getElementById('tooltip');

        // Load PDF from base64
        const pdfData = atob('${pdfBase64}');
        const pdfArray = new Uint8Array(pdfData.length);
        for (let i = 0; i < pdfData.length; i++) {
            pdfArray[i] = pdfData.charCodeAt(i);
        }

        pdfjsLib.getDocument({ data: pdfArray }).promise.then(pdf => {
            pdfDoc = pdf;
            totalPagesSpan.textContent = pdf.numPages;
            pageInput.max = pdf.numPages;
            loading.style.display = 'none';
            
            // Render all pages (or visible pages for large PDFs)
            renderAllPages();
            
            // Scroll to initial page
            setTimeout(() => scrollToPage(currentPage), 100);
            
            // Notify VS Code we're ready
            vscode.postMessage({ type: 'ready' });
        }).catch(err => {
            loading.textContent = 'Error loading PDF: ' + err.message;
        });

        async function renderAllPages() {
            viewer.innerHTML = '';
            renderedPages.clear();

            for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
                const page = await pdfDoc.getPage(pageNum);
                const viewport = page.getViewport({ scale });

                const container = document.createElement('div');
                container.className = 'page-container';
                container.id = 'page-' + pageNum;
                container.dataset.pageNum = pageNum;

                const canvas = document.createElement('canvas');
                canvas.className = 'page-canvas';
                canvas.width = viewport.width;
                canvas.height = viewport.height;

                const ctx = canvas.getContext('2d');
                await page.render({ canvasContext: ctx, viewport }).promise;

                container.appendChild(canvas);

                // Add highlight layer
                const highlightLayer = document.createElement('div');
                highlightLayer.className = 'highlight-layer';
                container.appendChild(highlightLayer);

                // Add highlights for this page
                const pageHighlights = highlights.filter(h => h.pageNumber === pageNum);
                for (const highlight of pageHighlights) {
                    for (const rect of highlight.rects) {
                        const div = document.createElement('div');
                        div.className = 'highlight-rect';
                        div.style.left = (rect.x * 100) + '%';
                        div.style.top = (rect.y * 100) + '%';
                        div.style.width = (rect.width * 100) + '%';
                        div.style.height = (rect.height * 100) + '%';
                        div.style.background = highlight.color || 'rgba(255, 255, 0, 0.4)';
                        div.dataset.highlightId = highlight.id;
                        div.title = highlight.label || 'Click to copy';

                        div.addEventListener('click', () => {
                            vscode.postMessage({
                                type: 'highlightClicked',
                                highlightId: highlight.id,
                                command: highlight.onClick,
                                data: { pageNumber: pageNum }
                            });
                        });

                        div.addEventListener('mouseenter', (e) => {
                            if (highlight.label) {
                                tooltip.textContent = highlight.label;
                                tooltip.style.left = e.pageX + 10 + 'px';
                                tooltip.style.top = e.pageY + 10 + 'px';
                                tooltip.classList.add('visible');
                            }
                        });

                        div.addEventListener('mouseleave', () => {
                            tooltip.classList.remove('visible');
                        });

                        highlightLayer.appendChild(div);
                    }
                }

                viewer.appendChild(container);
                renderedPages.set(pageNum, container);
            }
        }

        function scrollToPage(pageNum) {
            const container = document.getElementById('page-' + pageNum);
            if (container) {
                container.scrollIntoView({ behavior: 'smooth', block: 'start' });
                currentPage = pageNum;
                currentPageSpan.textContent = pageNum;
                pageInput.value = pageNum;

                // Flash highlights on that page
                const pageHighlights = container.querySelectorAll('.highlight-rect');
                pageHighlights.forEach(el => {
                    el.classList.add('flash');
                    setTimeout(() => el.classList.remove('flash'), 1000);
                });
            }
        }

        function updateZoom(newScale) {
            scale = Math.max(0.25, Math.min(3, newScale));
            zoomLevel.textContent = Math.round(scale * 100) + '%';
            renderAllPages().then(() => scrollToPage(currentPage));
        }

        // Navigation
        prevBtn.addEventListener('click', () => {
            if (currentPage > 1) scrollToPage(currentPage - 1);
        });

        nextBtn.addEventListener('click', () => {
            if (currentPage < pdfDoc.numPages) scrollToPage(currentPage + 1);
        });

        goBtn.addEventListener('click', () => {
            const page = parseInt(pageInput.value);
            if (page >= 1 && page <= pdfDoc.numPages) {
                scrollToPage(page);
            }
        });

        pageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') goBtn.click();
        });

        // Zoom
        zoomIn.addEventListener('click', () => updateZoom(scale + 0.25));
        zoomOut.addEventListener('click', () => updateZoom(scale - 0.25));
        zoomFit.addEventListener('click', () => {
            const containerWidth = viewer.clientWidth - 40;
            if (pdfDoc) {
                pdfDoc.getPage(1).then(page => {
                    const viewport = page.getViewport({ scale: 1 });
                    const fitScale = containerWidth / viewport.width;
                    updateZoom(fitScale);
                });
            }
        });

        // Track scroll position to update current page
        viewer.addEventListener('scroll', () => {
            const viewerRect = viewer.getBoundingClientRect();
            const viewerCenter = viewerRect.top + viewerRect.height / 2;

            let closestPage = 1;
            let closestDist = Infinity;

            for (const [pageNum, container] of renderedPages) {
                const rect = container.getBoundingClientRect();
                const pageCenter = rect.top + rect.height / 2;
                const dist = Math.abs(pageCenter - viewerCenter);
                if (dist < closestDist) {
                    closestDist = dist;
                    closestPage = pageNum;
                }
            }

            if (closestPage !== currentPage) {
                currentPage = closestPage;
                currentPageSpan.textContent = currentPage;
                pageInput.value = currentPage;
            }
        });

        // Handle messages from VS Code
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'navigate':
                    if (message.highlights) {
                        highlights = message.highlights;
                        renderAllPages().then(() => scrollToPage(message.pageNumber || 1));
                    } else {
                        scrollToPage(message.pageNumber || 1);
                    }
                    break;
                case 'init':
                    if (message.highlights) {
                        highlights = message.highlights;
                    }
                    renderAllPages().then(() => scrollToPage(message.pageNumber || 1));
                    break;
                case 'addHighlight':
                    highlights.push(message.highlight);
                    renderAllPages().then(() => scrollToPage(message.highlight.pageNumber));
                    break;
            }
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
                e.preventDefault();
                if (currentPage > 1) scrollToPage(currentPage - 1);
            } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
                e.preventDefault();
                if (currentPage < pdfDoc.numPages) scrollToPage(currentPage + 1);
            } else if (e.key === 'Home') {
                e.preventDefault();
                scrollToPage(1);
            } else if (e.key === 'End') {
                e.preventDefault();
                scrollToPage(pdfDoc.numPages);
            } else if (e.key === '+' || e.key === '=') {
                if (e.ctrlKey) {
                    e.preventDefault();
                    updateZoom(scale + 0.25);
                }
            } else if (e.key === '-') {
                if (e.ctrlKey) {
                    e.preventDefault();
                    updateZoom(scale - 0.25);
                }
            }
        });
    </script>
</body>
</html>`;
    }

    /**
     * Close all PDF viewer panels
     */
    closeAll(): void {
        for (const panel of this.panels.values()) {
            panel.dispose();
        }
        this.panels.clear();
    }

    /**
     * Check if a PDF is currently open
     */
    isOpen(pdfPath: string): boolean {
        return this.panels.has(pdfPath);
    }

    /**
     * Get the panel for a specific PDF
     */
    getPanel(pdfPath: string): vscode.WebviewPanel | undefined {
        return this.panels.get(pdfPath);
    }

    /**
     * Add a highlight to an already-open PDF
     */
    async addHighlightToOpenPdf(pdfPath: string, highlight: HighlightAnnotation): Promise<boolean> {
        const panel = this.panels.get(pdfPath);
        if (!panel) return false;

        panel.webview.postMessage({
            type: 'addHighlight',
            highlight
        });

        return true;
    }

    /**
     * Navigate an open PDF to a specific page
     */
    navigateToPage(pdfPath: string, pageNumber: number): boolean {
        const panel = this.panels.get(pdfPath);
        if (!panel) return false;

        panel.webview.postMessage({
            type: 'navigate',
            pageNumber
        });

        return true;
    }
}
