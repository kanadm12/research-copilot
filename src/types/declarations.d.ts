declare module 'pdf-parse' {
    interface PDFData {
        numpages: number;
        numrender: number;
        info: any;
        metadata: any;
        version: string;
        text: string;
    }

    interface PDFOptions {
        pagerender?: (pageData: any) => Promise<string>;
        max?: number;
        version?: string;
    }

    function pdfParse(dataBuffer: Buffer, options?: PDFOptions): Promise<PDFData>;
    export = pdfParse;
}

declare module 'natural' {
    export class TfIdf {
        addDocument(document: string | string[]): void;
        tfidfs(terms: string | string[], callback: (i: number, measure: number) => void): void;
        listTerms(d: number): Array<{ term: string; tfidf: number }>;
    }

    export class WordTokenizer {
        tokenize(text: string): string[];
    }

    export class PorterStemmer {
        static stem(token: string): string;
    }
}

declare module 'ml-distance' {
    export function cosine(a: number[], b: number[]): number;
    export function euclidean(a: number[], b: number[]): number;
}
