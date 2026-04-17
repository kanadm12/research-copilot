import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DocumentImage } from './documentStore';

// Tesseract.js for OCR
import Tesseract from 'tesseract.js';

export class ImageExtractor {
    private context: vscode.ExtensionContext;
    private outputDir: string = '';
    private ocrWorker: Tesseract.Worker | null = null;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.initializeOutputDir();
    }

    private initializeOutputDir(): void {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            const config = vscode.workspace.getConfiguration('researchCopilot');
            const indexPath = config.get<string>('indexPath', '.research-copilot');
            this.outputDir = path.join(workspaceFolder.uri.fsPath, indexPath, 'images');
        } else {
            this.outputDir = path.join(this.context.globalStorageUri.fsPath, 'images');
        }

        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }
    }

    async extractImagesFromPage(page: any, pageNumber: number, pdfPath: string): Promise<DocumentImage[]> {
        const images: DocumentImage[] = [];
        const config = vscode.workspace.getConfiguration('researchCopilot');
        const ocrEnabled = config.get<boolean>('ocrEnabled', true);

        try {
            // Get the operator list which contains image data
            const ops = await page.getOperatorList();
            const viewport = page.getViewport({ scale: 2.0 }); // Higher scale for better quality

            // Look for image operators
            for (let i = 0; i < ops.fnArray.length; i++) {
                // paintImageXObject = 85
                if (ops.fnArray[i] === 85) {
                    const imageName = ops.argsArray[i][0];
                    
                    try {
                        const img = await this.extractSingleImage(
                            page, 
                            imageName, 
                            pageNumber, 
                            pdfPath,
                            images.length
                        );
                        
                        if (img) {
                            // Perform OCR if enabled
                            if (ocrEnabled) {
                                img.ocrText = await this.performOCR(img.path);
                            }
                            
                            images.push(img);
                        }
                    } catch (imgError) {
                        console.error(`Error extracting image ${imageName}:`, imgError);
                    }
                }
            }

            // Also try to render the page as an image for pages with complex layouts
            if (images.length === 0) {
                // Render full page as image if no embedded images found
                // This helps with scanned PDFs
                const pageImage = await this.renderPageAsImage(page, pageNumber, pdfPath, viewport);
                if (pageImage) {
                    if (ocrEnabled) {
                        pageImage.ocrText = await this.performOCR(pageImage.path);
                    }
                    // Only add full page render if OCR found text (likely a scanned page)
                    if (pageImage.ocrText && pageImage.ocrText.trim().length > 50) {
                        images.push(pageImage);
                    }
                }
            }
        } catch (error) {
            console.error(`Error extracting images from page ${pageNumber}:`, error);
        }

        return images;
    }

    private async extractSingleImage(
        page: any, 
        imageName: string, 
        pageNumber: number,
        pdfPath: string,
        imageIndex: number
    ): Promise<DocumentImage | null> {
        try {
            // Get the image object
            const imgData = await page.objs.get(imageName);
            if (!imgData) return null;

            // Skip very small images (likely icons or artifacts)
            if (imgData.width < 50 || imgData.height < 50) {
                return null;
            }

            const pdfName = path.basename(pdfPath, '.pdf');
            const imageFileName = `${pdfName}_page${pageNumber}_img${imageIndex}.png`;
            const imagePath = path.join(this.outputDir, imageFileName);

            // Convert image data to PNG using canvas or sharp
            await this.saveImageData(imgData, imagePath);

            const documentImage: DocumentImage = {
                id: `img_${Date.now().toString(36)}_${imageIndex}`,
                documentId: '', // Will be set by caller
                pageNumber,
                path: imagePath,
                width: imgData.width,
                height: imgData.height,
                description: `Image from page ${pageNumber}`,
            };

            return documentImage;
        } catch (error) {
            console.error('Error extracting single image:', error);
            return null;
        }
    }

    private async saveImageData(imgData: any, outputPath: string): Promise<void> {
        // We'll use sharp if available, otherwise raw data
        try {
            const sharp = require('sharp');
            
            // Handle different image data formats
            if (imgData.bitmap) {
                // Bitmap data
                await sharp(Buffer.from(imgData.bitmap.data), {
                    raw: {
                        width: imgData.bitmap.width,
                        height: imgData.bitmap.height,
                        channels: 4
                    }
                })
                .png()
                .toFile(outputPath);
            } else if (imgData.data) {
                // Raw RGBA data
                const channels = imgData.data.length / (imgData.width * imgData.height);
                await sharp(Buffer.from(imgData.data), {
                    raw: {
                        width: imgData.width,
                        height: imgData.height,
                        channels: Math.round(channels) as 1 | 2 | 3 | 4
                    }
                })
                .png()
                .toFile(outputPath);
            }
        } catch (error) {
            // Fallback: save raw data
            console.error('Sharp not available or error saving image:', error);
            // Write a placeholder file
            fs.writeFileSync(outputPath + '.meta.json', JSON.stringify({
                width: imgData.width,
                height: imgData.height,
                note: 'Image extraction failed - sharp library issue'
            }));
        }
    }

    private async renderPageAsImage(
        page: any, 
        pageNumber: number, 
        pdfPath: string,
        viewport: any
    ): Promise<DocumentImage | null> {
        try {
            // This requires canvas package - skip if not available
            const { createCanvas } = require('canvas');
            
            const canvas = createCanvas(viewport.width, viewport.height);
            const context = canvas.getContext('2d');

            await page.render({
                canvasContext: context,
                viewport: viewport
            }).promise;

            const pdfName = path.basename(pdfPath, '.pdf');
            const imageFileName = `${pdfName}_page${pageNumber}_full.png`;
            const imagePath = path.join(this.outputDir, imageFileName);

            const buffer = canvas.toBuffer('image/png');
            fs.writeFileSync(imagePath, buffer);

            return {
                id: `img_page_${Date.now().toString(36)}`,
                documentId: '',
                pageNumber,
                path: imagePath,
                width: viewport.width,
                height: viewport.height,
                description: `Full page render of page ${pageNumber}`
            };
        } catch (error) {
            // Canvas package not available - this is optional
            console.log('Canvas not available for full page rendering');
            return null;
        }
    }

    async performOCR(imagePath: string): Promise<string> {
        if (!fs.existsSync(imagePath)) {
            return '';
        }

        try {
            const result = await Tesseract.recognize(imagePath, 'eng', {
                logger: () => {} // Suppress progress logs
            });

            return result.data.text.trim();
        } catch (error) {
            console.error('OCR failed:', error);
            return '';
        }
    }

    async describeImageWithAI(imagePath: string): Promise<string> {
        // This method can be used to get AI-generated descriptions of images
        // using VS Code's language model API
        try {
            // Read image as base64
            const imageBuffer = fs.readFileSync(imagePath);
            const base64Image = imageBuffer.toString('base64');
            const mimeType = 'image/png';

            // Use VS Code's chat API for vision if available
            const models = await vscode.lm.selectChatModels({
                vendor: 'copilot',
                family: 'gpt-4o' // Vision-capable model
            });

            if (models.length === 0) {
                return '';
            }

            const model = models[0];
            
            // Create a message with the image
            const messages = [
                vscode.LanguageModelChatMessage.User([
                    new vscode.LanguageModelTextPart('Describe this image from a research document in detail. Focus on any charts, graphs, diagrams, or important visual information.'),
                    vscode.LanguageModelDataPart.image(
                        new Uint8Array(Buffer.from(base64Image, 'base64')),
                        mimeType
                    )
                ])
            ];

            const response = await model.sendRequest(messages, {});
            
            let description = '';
            for await (const chunk of response.text) {
                description += chunk;
            }

            return description;
        } catch (error) {
            console.error('AI image description failed:', error);
            return '';
        }
    }

    async cleanup(): Promise<void> {
        if (this.ocrWorker) {
            await this.ocrWorker.terminate();
            this.ocrWorker = null;
        }
    }
}
