# 📚 Research Copilot - NotebookLM for VS Code

> Transform your PDF research into an AI-powered knowledge base. Generate podcasts, visualize connections, write papers with citations, and chat with your documents.

## ✨ Features

### 🎙️ **Audio Podcast Generation** ⭐ NEW
Transform your research papers into engaging audio podcasts! Choose from multiple styles:
- **Conversation**: Two hosts discussing the research naturally
- **Lecture**: Educational presentation style
- **Debate**: Friendly debate between different perspectives
- **Interview**: Q&A format with expert insights
- **Summary**: Brief audio overview of key findings

Uses Microsoft's free neural TTS with 12+ voice options - **no API keys required!**

### 🕸️ **Knowledge Graph Visualization** ⭐ NEW
See how your documents connect with an interactive D3.js visualization:
- Document nodes sized by content length
- Semantic similarity links between related papers
- Shared concept detection across documents
- Citation relationship mapping
- Drag, zoom, and explore your research landscape
- Export to JSON, GraphML, or GEXF (for Gephi/yEd)

### ✍️ **Research Writing Assistant with LaTeX** ⭐ NEW
AI-powered academic writing with automatic citations from your indexed documents:
- **Literature Reviews** - Synthesize sources on any topic
- **Abstracts** - Concise summaries of research
- **Introductions, Methodology, Discussion, Conclusions**
- **Custom sections** with your own prompts

**Output formats:**
- 📄 **LaTeX** (.tex) - Ready for academic submission
- 📚 **BibTeX** (.bib) - Auto-generated bibliography
- 📝 **Markdown** - With footnote citations

**Citation styles:** APA, MLA, Chicago, IEEE

### 📄 **Enhanced PDF Processing** ⭐ NEW
Converts PDFs to DOCX for superior extraction using [pdf2docx](https://github.com/ArtifexSoftware/pdf2docx):
- Better table recognition and formatting
- Cleaner image extraction
- Improved text layout preservation
- **Auto-setup**: Dependencies install automatically on first use

### 🔍 **Smart Document Search**
Search across all your research PDFs using natural language queries. Find relevant passages, citations, and information instantly.

### 🧠 **Semantic Search with AI Embeddings**
Powered by **all-MiniLM-L6-v2** from Hugging Face. Understands the *meaning* of your queries, not just keywords. Find conceptually related content even when exact words don't match.

### 🤖 **Copilot Integration**
Use `@research` in GitHub Copilot Chat to ask questions about your documents. Copilot searches your indexed PDFs and provides answers with citations.

### 📷 **Image Extraction & OCR**
Automatically extracts images from PDFs, including charts, diagrams, and figures. OCR support for scanned documents ensures no information is lost.

### 📑 **Citation Extraction**
Automatically detects and extracts academic citations in multiple formats:
- **APA**: (Author, Year)
- **MLA**: (Author Page)
- **IEEE**: [1], [2]
- **Harvard**: (Author Year)
- **Chicago/Vancouver**: And more!

Export your citations to **BibTeX** format for easy bibliography management.

### 🖍️ **Highlighting & Annotations**
Highlight important passages with color-coded markers:
- 🟡 Yellow, 🟢 Green, 🔵 Blue, 🩷 Pink, 🟣 Purple, 🟠 Orange

Add notes and tags to your highlights, then export them to Markdown or HTML.

### 📊 **Visual Dashboard**
Overview of all indexed documents, search interface, and research progress tracking.

### 🔗 **Language Model Tools**
Exposes your research to Copilot through 8 Language Model Tools:
- `searchDocuments` - Keyword-based search
- `semanticSearch` - AI-powered semantic search
- `getDocumentContent` - Get full document text
- `getDocumentImages` - Retrieve images with OCR
- `listDocuments` - List indexed documents
- `summarizeDocument` - Get document summaries
- `getCitations` - Extract academic citations
- `getHighlights` - Retrieve user highlights

## 🚀 Getting Started

### Installation

1. **From VS Code Marketplace** (coming soon)
   
2. **From Source:**
   ```bash
   git clone https://github.com/your-username/research-copilot.git
   cd research-copilot
   npm install
   npm run compile
   ```
   Then press `F5` in VS Code to run the extension.

### Quick Start

1. **Add PDFs to your workspace** - Create a folder with your research papers, textbooks, or any PDF documents.

2. **Index your documents** - Run `Research Copilot: Index All PDFs in Workspace` from the Command Palette (`Ctrl+Shift+P`).

3. **Build Semantic Index** - Run `Research Copilot: Build Semantic Search Index` to enable AI-powered search.

4. **Start exploring:**
   - 🎙️ Generate a podcast: `Research Copilot: Generate Audio Podcast`
   - 🕸️ View connections: `Research Copilot: Show Knowledge Graph`
   - ✍️ Write research: `Research Copilot: Write Research`
   - 💬 Ask questions: Type `@research` in Copilot Chat

## 💬 Using @research Chat

The `@research` chat participant understands special commands:

| Command | Description |
|---------|-------------|
| `/list` | Show all indexed documents |
| `/stats` | Display indexing statistics |
| `/summarize [doc]` | Get summary of a specific document |
| `/citations [doc]` | Extract citations from a document |
| `/highlights` | View all your highlights |
| `/semantic [query]` | Force semantic (AI) search |

Examples:
```
@research What methods were used in the Smith et al. paper?
@research /list
@research /summarize machine-learning-survey.pdf
@research /citations neural-networks.pdf
@research /semantic concepts similar to attention mechanisms
@research Compare the conclusions across my indexed papers
```

## ⚙️ Configuration

Access settings through `File > Preferences > Settings` and search for "Research Copilot".

| Setting | Default | Description |
|---------|---------|-------------|
| `autoIndex` | `true` | Auto-index PDFs when added to workspace |
| `extractImages` | `true` | Extract images from PDFs |
| `ocrEnabled` | `true` | Enable OCR for scanned documents |
| `useDocxConversion` | `true` | Use enhanced DOCX conversion (requires Python) |
| `indexPath` | `.research-copilot` | Folder to store index data |
| `maxPdfSizeMB` | `50` | Maximum PDF file size to process |
| `chunkSize` | `1000` | Text chunk size for indexing |
| `chunkOverlap` | `200` | Overlap between chunks |

## 🛠️ Commands

### Core Commands
| Command | Description |
|---------|-------------|
| `Index All PDFs in Workspace` | Index all PDF files in the workspace |
| `Index This PDF` | Index a specific PDF file |
| `Open Dashboard` | Open the visual dashboard |
| `Clear Index` | Clear all indexed data |

### 🎙️ Podcast & Media
| Command | Description |
|---------|-------------|
| `Generate Audio Podcast` | Create podcast from your documents |

### 🕸️ Knowledge Graph
| Command | Description |
|---------|-------------|
| `Show Knowledge Graph` | Interactive visualization of document connections |
| `Export Knowledge Graph` | Export to JSON/GraphML/GEXF |

### ✍️ Research Writing
| Command | Description |
|---------|-------------|
| `Write Research` | Generate literature reviews, abstracts, etc. with LaTeX |

### Search Commands
| Command | Description |
|---------|-------------|
| `Search Documents` | Keyword search through documents |
| `Semantic Search` | AI-powered semantic search |
| `Hybrid Search` | Combines keywords + AI for best results |
| `Find Similar Passages` | Find text similar to selection |
| `Build Semantic Index` | Build/rebuild the AI search index |

### Highlighting Commands
| Command | Description |
|---------|-------------|
| `Create Highlight` | Highlight selected text with color |
| `View All Highlights` | Browse all your highlights |
| `Export Highlights` | Export to Markdown/HTML/JSON |

### Citation Commands
| Command | Description |
|---------|-------------|
| `Extract Citations` | Extract citations from a document |
| `Export BibTeX` | Export all citations as BibTeX |

## 📁 Project Structure

```
.research-copilot/           # Index data (in your workspace)
├── index.json               # Document metadata index
├── vectors.json             # Semantic embeddings
├── knowledge_graph.json     # Graph data
├── extracted/               # Extracted text as Markdown
├── converted/               # DOCX conversions
├── podcasts/                # Generated audio files
│   ├── podcast_123.mp3
│   └── podcast_123.md       # Transcript
├── writing/                 # Generated research writing
│   ├── literature_review.tex
│   ├── literature_review.bib
│   └── literature_review.md
└── images/                  # Extracted images
```

## 🔧 How It Works

1. **PDF Processing**: Uses `pdf.js` or DOCX conversion for superior text extraction.

2. **Image Extraction**: Identifies and extracts embedded images via DOCX pipeline.

3. **OCR**: Uses `tesseract.js` for scanned documents and images.

4. **Text Chunking**: Splits documents into overlapping chunks for search accuracy.

5. **Semantic Embeddings**: Uses **Xenova/all-MiniLM-L6-v2** (384-dimensional) for meaning-based search.

6. **Knowledge Graph**: Analyzes concepts, citations, and semantic similarity to build connections.

7. **Podcast Generation**: Uses VS Code's LM API for script generation + Microsoft edge-tts for audio.

8. **Research Writing**: Retrieves relevant chunks, generates content with Copilot, formats citations.

## 🧠 The AI Model

Research Copilot uses **all-MiniLM-L6-v2** from Hugging Face:

- **Architecture**: MiniLM (distilled from BERT)
- **Embedding Dimension**: 384
- **Training Data**: 1B+ sentence pairs
- **Size**: ~23MB (quantized)

The model runs locally via `@xenova/transformers` (ONNX runtime) - **your research stays private**.

## 🎯 Use Cases

- **Academic Research**: Search papers, generate literature reviews, visualize connections
- **Thesis Writing**: Auto-citations, BibTeX export, LaTeX output
- **Study Aid**: Generate audio summaries, create flashcard-like content
- **Literature Review**: Synthesize multiple papers automatically
- **Conference Prep**: Generate podcast-style summaries for commutes
- **Lab Meetings**: Knowledge graphs to show research landscape

## 📝 Roadmap

- [x] ~~Vector embeddings for semantic search~~ ✅
- [x] ~~Citation extraction and linking~~ ✅
- [x] ~~Annotation and highlighting support~~ ✅
- [x] ~~Export to BibTeX~~ ✅
- [x] ~~Knowledge graph visualization~~ ✅ **NEW!**
- [x] ~~Audio podcast generation~~ ✅ **NEW!**
- [x] ~~Research writing assistant~~ ✅ **NEW!**
- [x] ~~LaTeX export~~ ✅ **NEW!**
- [ ] Flashcard generation
- [ ] Integration with Zotero/Mendeley
- [ ] Collaborative research workspaces
- [ ] Video summary generation
- [ ] Multi-language support

## 🤝 Contributing

Contributions are welcome! Please read our [Contributing Guidelines](CONTRIBUTING.md) first.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [pdf2docx](https://github.com/ArtifexSoftware/pdf2docx) - PDF to DOCX conversion
- [edge-tts](https://github.com/rany2/edge-tts) - Microsoft neural TTS
- [D3.js](https://d3js.org/) - Knowledge graph visualization
- [PDF.js](https://mozilla.github.io/pdf.js/) - PDF rendering
- [Tesseract.js](https://tesseract.projectnaptha.com/) - OCR
- [Hugging Face Transformers](https://huggingface.co/) - AI embeddings
- [VS Code Extension API](https://code.visualstudio.com/api)
- Inspired by [Google NotebookLM](https://notebooklm.google.com/)

---

**Made with ❤️ for researchers everywhere**

*Now with podcasts, knowledge graphs, and AI writing!* 🎙️🕸️✍️
