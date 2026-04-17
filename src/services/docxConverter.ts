import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Use mammoth for reading DOCX files
const mammoth = require('mammoth');

export interface DocxConversionResult {
    docxPath: string;
    text: string;
    html: string;
    images: ExtractedImage[];
    pageCount: number;
}

export interface ExtractedImage {
    path: string;
    altText: string;
    contentType: string;
    pageNumber: number;
}

export class DocxConverter {
    private context: vscode.ExtensionContext;
    private outputDir: string = '';
    private pythonPath: string = 'python';
    private pdf2docxAvailable: boolean | null = null;
    private pdf2docxPath: string = '';
    private pythonReady: boolean = false;
    private setupPromise: Promise<boolean> | null = null;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.initializeOutputDir();
        this.initializePdf2docxPath();
    }

    private initializeOutputDir(): void {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            const config = vscode.workspace.getConfiguration('researchCopilot');
            const indexPath = config.get<string>('indexPath', '.research-copilot');
            this.outputDir = path.join(workspaceFolder.uri.fsPath, indexPath, 'converted');
        } else {
            this.outputDir = path.join(this.context.globalStorageUri.fsPath, 'converted');
        }

        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }

        // Create images subdirectory
        const imagesDir = path.join(this.outputDir, 'images');
        if (!fs.existsSync(imagesDir)) {
            fs.mkdirSync(imagesDir, { recursive: true });
        }
    }

    /**
     * Initialize the path to pdf2docx - check bundled first, then workspace, then global
     */
    private initializePdf2docxPath(): void {
        // 1. Check if pdf2docx is bundled with the extension
        const extensionPath = this.context.extensionPath;
        const bundledPath = path.join(extensionPath, 'pdf2docx');
        if (fs.existsSync(bundledPath) && fs.existsSync(path.join(bundledPath, 'pdf2docx', '__init__.py'))) {
            this.pdf2docxPath = bundledPath;
            console.log(`Found bundled pdf2docx at: ${bundledPath}`);
            return;
        }

        // 2. Check for pdf2docx folder in workspace root (for development)
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            const workspacePath = path.join(workspaceFolder.uri.fsPath, 'pdf2docx');
            if (fs.existsSync(workspacePath) && fs.existsSync(path.join(workspacePath, 'pdf2docx', '__init__.py'))) {
                this.pdf2docxPath = workspacePath;
                console.log(`Found workspace pdf2docx at: ${workspacePath}`);
                return;
            }
        }

        // 3. No local pdf2docx found - will try to use globally installed
        console.log('No local pdf2docx found, will try global installation');
    }

    /**
     * Check if Python is available and find the correct command
     */
    async checkPythonAvailable(): Promise<boolean> {
        const pythonCommands = ['python', 'python3', 'py'];
        
        for (const pythonCmd of pythonCommands) {
            try {
                await execAsync(`${pythonCmd} --version`);
                this.pythonPath = pythonCmd;
                return true;
            } catch {
                continue;
            }
        }
        return false;
    }

    /**
     * Check if pdf2docx dependencies are installed
     */
    async checkDependenciesInstalled(): Promise<boolean> {
        try {
            if (this.pdf2docxPath) {
                // Check with local pdf2docx
                const checkScript = `
import sys
sys.path.insert(0, r'${this.pdf2docxPath}')
import fitz
import docx
from pdf2docx import Converter
print('ok')
`;
                await execAsync(`${this.pythonPath} -c "${checkScript.replace(/\n/g, ';').replace(/"/g, '\\"')}"`);
            } else {
                // Check global installation
                await execAsync(`${this.pythonPath} -c "from pdf2docx import Converter; print('ok')"`);
            }
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Auto-setup: Check Python and install dependencies if needed
     * Returns true if ready to use, false if setup failed
     */
    async autoSetup(showProgress: boolean = true): Promise<boolean> {
        // Return cached promise if already running
        if (this.setupPromise) {
            return this.setupPromise;
        }

        this.setupPromise = this._doAutoSetup(showProgress);
        const result = await this.setupPromise;
        this.setupPromise = null;
        return result;
    }

    private async _doAutoSetup(showProgress: boolean): Promise<boolean> {
        // Check Python first
        const pythonAvailable = await this.checkPythonAvailable();
        if (!pythonAvailable) {
            if (showProgress) {
                const action = await vscode.window.showErrorMessage(
                    'Python is required for PDF to DOCX conversion. Please install Python and ensure it\'s in your PATH.',
                    'Download Python'
                );
                if (action === 'Download Python') {
                    vscode.env.openExternal(vscode.Uri.parse('https://www.python.org/downloads/'));
                }
            }
            return false;
        }

        // Check if dependencies are already installed
        const depsInstalled = await this.checkDependenciesInstalled();
        if (depsInstalled) {
            this.pythonReady = true;
            this.pdf2docxAvailable = true;
            console.log('pdf2docx dependencies already installed');
            return true;
        }

        // Need to install dependencies
        if (showProgress) {
            return await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Research Copilot: Setting up PDF conversion...',
                cancellable: false
            }, async (progress) => {
                progress.report({ message: 'Installing Python dependencies...' });
                const success = await this.installDependencies();
                if (success) {
                    progress.report({ message: 'Setup complete!' });
                    this.pythonReady = true;
                    this.pdf2docxAvailable = true;
                }
                return success;
            });
        } else {
            const success = await this.installDependencies();
            if (success) {
                this.pythonReady = true;
                this.pdf2docxAvailable = true;
            }
            return success;
        }
    }

    /**
     * Install pdf2docx dependencies
     */
    private async installDependencies(): Promise<boolean> {
        try {
            if (this.pdf2docxPath) {
                // Install from bundled requirements.txt
                const requirementsPath = path.join(this.pdf2docxPath, 'requirements.txt');
                if (fs.existsSync(requirementsPath)) {
                    console.log(`Installing dependencies from: ${requirementsPath}`);
                    await execAsync(`${this.pythonPath} -m pip install -r "${requirementsPath}" --quiet --user`);
                } else {
                    // Install core dependencies manually
                    console.log('Installing core dependencies...');
                    await execAsync(`${this.pythonPath} -m pip install PyMuPDF python-docx fonttools numpy opencv-python-headless --quiet --user`);
                }
            } else {
                // Install pdf2docx from pip (includes all dependencies)
                console.log('Installing pdf2docx from pip...');
                await execAsync(`${this.pythonPath} -m pip install pdf2docx --quiet --user`);
            }

            // Verify installation
            return await this.checkDependenciesInstalled();
        } catch (error) {
            console.error('Failed to install dependencies:', error);
            return false;
        }
    }

    /**
     * Check if pdf2docx is available (either locally or installed)
     */
    async checkPdf2DocxAvailable(): Promise<boolean> {
        if (this.pdf2docxAvailable !== null) {
            return this.pdf2docxAvailable;
        }

        // Run auto-setup silently
        return await this.autoSetup(false);
    }

    /**
     * Install pdf2docx dependencies (PyMuPDF, python-docx, etc.)
     * Public method for manual installation command
     */
    async installPdf2Docx(): Promise<boolean> {
        return await this.autoSetup(true);
    }

    /**
     * Convert PDF to DOCX using pdf2docx Python library
     */
    async convertPdfToDocx(pdfPath: string): Promise<string> {
        // Ensure pdf2docx is available (will auto-setup if needed)
        const available = await this.autoSetup(true);
        if (!available) {
            throw new Error(
                'PDF conversion is not available. Please ensure Python is installed.'
            );
        }

        const pdfBaseName = path.basename(pdfPath, '.pdf');
        const docxPath = path.join(this.outputDir, `${pdfBaseName}.docx`);

        // Build Python script that uses local pdf2docx if available
        const sysPathInsert = this.pdf2docxPath 
            ? `sys.path.insert(0, r'${this.pdf2docxPath}')\n` 
            : '';

        const pythonScript = `
import sys
${sysPathInsert}
from pdf2docx import Converter

pdf_path = sys.argv[1]
docx_path = sys.argv[2]

try:
    cv = Converter(pdf_path)
    cv.convert(docx_path, start=0, end=None)
    cv.close()
    print("SUCCESS")
except Exception as e:
    print(f"ERROR: {e}", file=sys.stderr)
    sys.exit(1)
`;

        return new Promise((resolve, reject) => {
            const childProcess = spawn(this.pythonPath, ['-c', pythonScript, pdfPath, docxPath]);
            
            let stdout = '';
            let stderr = '';
            let isResolved = false;

            // Timeout after 5 minutes for large PDFs
            const timeout = setTimeout(() => {
                if (!isResolved) {
                    isResolved = true;
                    childProcess.kill('SIGTERM');
                    reject(new Error('PDF to DOCX conversion timed out after 5 minutes'));
                }
            }, 5 * 60 * 1000);

            const cleanup = () => {
                clearTimeout(timeout);
            };

            childProcess.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            childProcess.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            childProcess.on('close', (code) => {
                cleanup();
                if (isResolved) return;
                isResolved = true;
                
                if (code === 0 && stdout.includes('SUCCESS')) {
                    resolve(docxPath);
                } else {
                    reject(new Error(`PDF to DOCX conversion failed: ${stderr || stdout}`));
                }
            });

            childProcess.on('error', (error) => {
                cleanup();
                if (isResolved) return;
                isResolved = true;
                reject(new Error(`Failed to run Python: ${error.message}`));
            });
        });
    }

    /**
     * Extract content from DOCX file using mammoth
     */
    async extractFromDocx(docxPath: string, originalPdfName: string): Promise<DocxConversionResult> {
        const images: ExtractedImage[] = [];
        let imageIndex = 0;
        const pdfBaseName = path.basename(originalPdfName, '.pdf');
        const imagesDir = path.join(this.outputDir, 'images', pdfBaseName);

        // Create images directory for this document
        if (!fs.existsSync(imagesDir)) {
            fs.mkdirSync(imagesDir, { recursive: true });
        }

        // Custom image converter for mammoth
        const convertImage = mammoth.images.imgElement((image: any) => {
            return image.read('base64').then((imageBuffer: string) => {
                const contentType = image.contentType || 'image/png';
                const extension = contentType.split('/')[1] || 'png';
                const imageName = `image_${++imageIndex}.${extension}`;
                const imagePath = path.join(imagesDir, imageName);
                
                // Save the image
                const buffer = Buffer.from(imageBuffer, 'base64');
                fs.writeFileSync(imagePath, buffer);

                images.push({
                    path: imagePath,
                    altText: `Image ${imageIndex}`,
                    contentType: contentType,
                    pageNumber: 0 // DOCX doesn't have page numbers in mammoth
                });

                return {
                    src: imagePath
                };
            });
        });

        // Extract HTML with images
        const htmlResult = await mammoth.convertToHtml(
            { path: docxPath },
            { convertImage: convertImage }
        );

        // Extract plain text
        const textResult = await mammoth.extractRawText({ path: docxPath });

        // Estimate page count (rough approximation based on character count)
        const estimatedPageCount = Math.ceil(textResult.value.length / 3000);

        return {
            docxPath,
            text: textResult.value,
            html: htmlResult.value,
            images,
            pageCount: estimatedPageCount
        };
    }

    /**
     * Full conversion pipeline: PDF -> DOCX -> Extract content
     */
    async convertAndExtract(pdfPath: string): Promise<DocxConversionResult> {
        console.log(`Converting PDF to DOCX: ${pdfPath}`);
        
        // Step 1: Convert PDF to DOCX
        const docxPath = await this.convertPdfToDocx(pdfPath);
        console.log(`DOCX created: ${docxPath}`);
        
        // Step 2: Extract content from DOCX
        const result = await this.extractFromDocx(docxPath, path.basename(pdfPath));
        console.log(`Extracted: ${result.text.length} chars, ${result.images.length} images`);
        
        return result;
    }

    /**
     * Clean up temporary DOCX files
     */
    async cleanup(docxPath: string): Promise<void> {
        try {
            if (fs.existsSync(docxPath)) {
                fs.unlinkSync(docxPath);
            }
        } catch (error) {
            console.error('Failed to cleanup DOCX file:', error);
        }
    }

    /**
     * Check if conversion should be used (based on config and availability)
     */
    async shouldUseDocxConversion(): Promise<boolean> {
        const config = vscode.workspace.getConfiguration('researchCopilot');
        const useDocxConversion = config.get<boolean>('useDocxConversion', false);
        
        if (!useDocxConversion) {
            return false;
        }

        return await this.checkPdf2DocxAvailable();
    }

    /**
     * Get the path where DOCX files are stored
     */
    getOutputDir(): string {
        return this.outputDir;
    }
}
