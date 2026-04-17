import * as vscode from 'vscode';
import * as path from 'path';
import { DocumentStore, DocumentMetadata } from '../services/documentStore';

export class DocumentTreeProvider implements vscode.TreeDataProvider<DocumentTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<DocumentTreeItem | undefined | null | void> = 
        new vscode.EventEmitter<DocumentTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<DocumentTreeItem | undefined | null | void> = 
        this._onDidChangeTreeData.event;

    private documentStore: DocumentStore;

    constructor(documentStore: DocumentStore) {
        this.documentStore = documentStore;
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: DocumentTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: DocumentTreeItem): Thenable<DocumentTreeItem[]> {
        if (!element) {
            // Root level: show all documents
            return Promise.resolve(this.getDocumentItems());
        } else if (element.contextValue === 'document') {
            // Document level: show sections
            return Promise.resolve(this.getDocumentSections(element.documentId!));
        } else if (element.contextValue === 'imageSection') {
            // Images section: show images
            return Promise.resolve(this.getDocumentImageItems(element.documentId!));
        }

        return Promise.resolve([]);
    }

    private getDocumentItems(): DocumentTreeItem[] {
        const documents = this.documentStore.getAllDocuments();
        
        return documents.map(doc => {
            const item = new DocumentTreeItem(
                doc.name,
                vscode.TreeItemCollapsibleState.Collapsed,
                {
                    command: 'vscode.open',
                    title: 'Open Extracted Content',
                    arguments: [vscode.Uri.file(doc.extractedPath || doc.path)]
                }
            );
            
            item.contextValue = 'document';
            item.documentId = doc.id;
            item.tooltip = `${doc.pageCount} pages • ${doc.chunks.length} chunks • ${doc.images.length} images`;
            item.iconPath = new vscode.ThemeIcon('file-pdf');
            item.description = `${doc.pageCount} pages`;

            return item;
        });
    }

    private getDocumentSections(documentId: string): DocumentTreeItem[] {
        const doc = this.documentStore.getDocument(documentId);
        if (!doc) return [];

        const sections: DocumentTreeItem[] = [];

        // Summary section
        const summaryItem = new DocumentTreeItem(
            'Summary',
            vscode.TreeItemCollapsibleState.None,
            {
                command: 'researchCopilot.showSummary',
                title: 'Show Summary',
                arguments: [documentId]
            }
        );
        summaryItem.iconPath = new vscode.ThemeIcon('book');
        summaryItem.tooltip = doc.summary.substring(0, 200) + '...';
        sections.push(summaryItem);

        // Content section
        if (doc.extractedPath) {
            const contentItem = new DocumentTreeItem(
                'Full Content',
                vscode.TreeItemCollapsibleState.None,
                {
                    command: 'vscode.open',
                    title: 'Open Content',
                    arguments: [vscode.Uri.file(doc.extractedPath)]
                }
            );
            contentItem.iconPath = new vscode.ThemeIcon('file-text');
            sections.push(contentItem);
        }

        // Images section (if any)
        if (doc.images.length > 0) {
            const imagesItem = new DocumentTreeItem(
                `Images (${doc.images.length})`,
                vscode.TreeItemCollapsibleState.Collapsed
            );
            imagesItem.contextValue = 'imageSection';
            imagesItem.documentId = documentId;
            imagesItem.iconPath = new vscode.ThemeIcon('file-media');
            sections.push(imagesItem);
        }

        // Metadata section
        const metaItem = new DocumentTreeItem(
            'Metadata',
            vscode.TreeItemCollapsibleState.None
        );
        metaItem.iconPath = new vscode.ThemeIcon('info');
        metaItem.tooltip = `Indexed: ${doc.indexedAt}\nSize: ${(doc.fileSize / 1024).toFixed(1)} KB`;
        metaItem.description = new Date(doc.indexedAt).toLocaleDateString();
        sections.push(metaItem);

        return sections;
    }

    private getDocumentImageItems(documentId: string): DocumentTreeItem[] {
        const images = this.documentStore.getDocumentImages(documentId);
        
        return images.map((img, index) => {
            const item = new DocumentTreeItem(
                `Page ${img.pageNumber} - Image ${index + 1}`,
                vscode.TreeItemCollapsibleState.None,
                {
                    command: 'vscode.open',
                    title: 'Open Image',
                    arguments: [vscode.Uri.file(img.path)]
                }
            );
            
            item.iconPath = new vscode.ThemeIcon('preview');
            item.tooltip = img.ocrText 
                ? `OCR: ${img.ocrText.substring(0, 100)}...` 
                : `${img.width}x${img.height}`;
            item.description = `${img.width}x${img.height}`;

            return item;
        });
    }
}

class DocumentTreeItem extends vscode.TreeItem {
    documentId?: string;

    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly command?: vscode.Command
    ) {
        super(label, collapsibleState);
    }
}
