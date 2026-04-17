import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { DocumentStore, DocumentMetadata } from './documentStore';

const execAsync = promisify(exec);

export interface PodcastConfig {
    style: 'conversation' | 'lecture' | 'debate' | 'interview' | 'summary';
    duration: 'short' | 'medium' | 'long'; // ~2min, ~5min, ~10min
    voices: {
        host: string;
        guest?: string;
    };
    focusTopics?: string[];
}

export interface PodcastResult {
    audioPath: string;
    transcriptPath: string;
    transcript: string;
    duration: number;
}

interface DialogueTurn {
    speaker: 'host' | 'guest';
    text: string;
}

export class PodcastGenerator {
    private context: vscode.ExtensionContext;
    private documentStore: DocumentStore;
    private outputDir: string = '';
    private pythonPath: string = 'python';
    private edgeTtsAvailable: boolean | null = null;

    // Available voices for edge-tts (Microsoft)
    private static readonly VOICES = {
        // English US
        'jenny': 'en-US-JennyNeural',      // Female, friendly
        'guy': 'en-US-GuyNeural',          // Male, casual
        'aria': 'en-US-AriaNeural',        // Female, professional
        'davis': 'en-US-DavisNeural',      // Male, deep
        'jane': 'en-US-JaneNeural',        // Female, conversational
        'jason': 'en-US-JasonNeural',      // Male, conversational
        'sara': 'en-US-SaraNeural',        // Female, cheerful
        'tony': 'en-US-TonyNeural',        // Male, friendly
        // English UK
        'sonia': 'en-GB-SoniaNeural',      // Female, British
        'ryan': 'en-GB-RyanNeural',        // Male, British
        // English AU
        'natasha': 'en-AU-NatashaNeural',  // Female, Australian
        'william': 'en-AU-WilliamNeural',  // Male, Australian
    };

    constructor(context: vscode.ExtensionContext, documentStore: DocumentStore) {
        this.context = context;
        this.documentStore = documentStore;
        this.initializeOutputDir();
    }

    private initializeOutputDir(): void {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            const config = vscode.workspace.getConfiguration('researchCopilot');
            const indexPath = config.get<string>('indexPath', '.research-copilot');
            this.outputDir = path.join(workspaceFolder.uri.fsPath, indexPath, 'podcasts');
        } else {
            this.outputDir = path.join(this.context.globalStorageUri.fsPath, 'podcasts');
        }

        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }
    }

    /**
     * Check and install edge-tts if needed
     */
    async ensureEdgeTts(): Promise<boolean> {
        if (this.edgeTtsAvailable !== null) {
            return this.edgeTtsAvailable;
        }

        const pythonCommands = ['python', 'python3', 'py'];
        
        for (const pythonCmd of pythonCommands) {
            try {
                await execAsync(`${pythonCmd} --version`);
                this.pythonPath = pythonCmd;
                
                // Check if edge-tts is installed
                try {
                    await execAsync(`${pythonCmd} -c "import edge_tts; print('ok')"`);
                    this.edgeTtsAvailable = true;
                    return true;
                } catch {
                    // Try to install edge-tts
                    console.log('Installing edge-tts...');
                    await execAsync(`${pythonCmd} -m pip install edge-tts --quiet --user`);
                    await execAsync(`${pythonCmd} -c "import edge_tts; print('ok')"`);
                    this.edgeTtsAvailable = true;
                    return true;
                }
            } catch {
                continue;
            }
        }

        this.edgeTtsAvailable = false;
        return false;
    }

    /**
     * Get available voices
     */
    getAvailableVoices(): { id: string; name: string; description: string }[] {
        return [
            { id: 'jenny', name: 'Jenny', description: 'Female, friendly (US)' },
            { id: 'guy', name: 'Guy', description: 'Male, casual (US)' },
            { id: 'aria', name: 'Aria', description: 'Female, professional (US)' },
            { id: 'davis', name: 'Davis', description: 'Male, deep voice (US)' },
            { id: 'sara', name: 'Sara', description: 'Female, cheerful (US)' },
            { id: 'tony', name: 'Tony', description: 'Male, friendly (US)' },
            { id: 'sonia', name: 'Sonia', description: 'Female, British' },
            { id: 'ryan', name: 'Ryan', description: 'Male, British' },
            { id: 'natasha', name: 'Natasha', description: 'Female, Australian' },
            { id: 'william', name: 'William', description: 'Male, Australian' },
        ];
    }

    /**
     * Generate a podcast from documents
     */
    async generatePodcast(
        documentIds: string[],
        config: PodcastConfig,
        progress?: vscode.Progress<{ message?: string; increment?: number }>
    ): Promise<PodcastResult> {
        // Ensure edge-tts is available
        progress?.report({ message: 'Checking TTS engine...' });
        const ttsAvailable = await this.ensureEdgeTts();
        if (!ttsAvailable) {
            throw new Error('Text-to-speech engine not available. Please ensure Python is installed.');
        }

        // Gather document content
        progress?.report({ message: 'Gathering document content...', increment: 10 });
        const documents = documentIds
            .map(id => this.documentStore.getDocument(id))
            .filter((d): d is DocumentMetadata => d !== undefined);

        if (documents.length === 0) {
            throw new Error('No documents found');
        }

        const content = this.gatherContent(documents);

        // Generate dialogue script using Copilot
        progress?.report({ message: 'Generating podcast script...', increment: 20 });
        const dialogue = await this.generateDialogueScript(content, config);

        // Save transcript
        const timestamp = Date.now();
        const transcriptPath = path.join(this.outputDir, `podcast_${timestamp}.md`);
        const transcriptContent = this.formatTranscript(dialogue, documents, config);
        fs.writeFileSync(transcriptPath, transcriptContent, 'utf8');

        // Generate audio for each turn
        progress?.report({ message: 'Generating audio...', increment: 30 });
        const audioPath = await this.generateAudio(dialogue, config, timestamp, progress);

        return {
            audioPath,
            transcriptPath,
            transcript: transcriptContent,
            duration: 0 // Will be calculated from audio
        };
    }

    /**
     * Gather content from documents
     */
    private gatherContent(documents: DocumentMetadata[]): string {
        let content = '';
        
        for (const doc of documents) {
            content += `\n\n=== Document: ${doc.name} ===\n\n`;
            content += `Summary: ${doc.summary}\n\n`;
            
            // Add key chunks (limited to avoid token limits)
            const keyChunks = doc.chunks.slice(0, 10);
            for (const chunk of keyChunks) {
                content += `${chunk.text}\n\n`;
            }
        }

        // Limit total content length
        if (content.length > 15000) {
            content = content.substring(0, 15000) + '\n\n[Content truncated for processing...]';
        }

        return content;
    }

    /**
     * Generate dialogue script using VS Code's Language Model API
     */
    private async generateDialogueScript(content: string, config: PodcastConfig): Promise<DialogueTurn[]> {
        const stylePrompts: Record<string, string> = {
            conversation: `Create a natural conversation between two people discussing this research. 
                The host introduces topics and asks questions, the guest (an expert) explains and provides insights.
                Make it engaging, with moments of surprise, "aha" moments, and relatable analogies.`,
            lecture: `Create an educational lecture about this research.
                The speaker (host) explains concepts clearly with examples.
                Include rhetorical questions and pauses for emphasis.`,
            debate: `Create a friendly debate between two researchers with different perspectives on this topic.
                They should respectfully challenge each other's viewpoints while finding common ground.`,
            interview: `Create an interview where the host asks probing questions about the research.
                The guest provides detailed answers with real-world implications.`,
            summary: `Create a brief, engaging summary of the key findings.
                The host presents the main points in an accessible way.`
        };

        const durationGuide: Record<string, string> = {
            short: 'Keep it concise, about 8-10 dialogue turns total (about 2 minutes when spoken).',
            medium: 'Create about 15-20 dialogue turns (about 5 minutes when spoken).',
            long: 'Create about 30-40 dialogue turns for an in-depth discussion (about 10 minutes when spoken).'
        };

        const prompt = `You are creating a podcast script based on research documents.

${stylePrompts[config.style]}

${durationGuide[config.duration]}

${config.focusTopics?.length ? `Focus especially on these topics: ${config.focusTopics.join(', ')}` : ''}

IMPORTANT RULES:
- Each turn should be 1-3 sentences for natural pacing
- Use conversational language, not academic jargon
- Include verbal cues like "So...", "Actually...", "Here's what's interesting..."
- Make complex topics accessible with analogies
- For two-speaker formats, create genuine back-and-forth dialogue

Return ONLY a JSON array with this exact format:
[
  {"speaker": "host", "text": "Welcome to the show! Today we're diving into some fascinating research..."},
  {"speaker": "guest", "text": "Thanks for having me! This research really caught my attention because..."}
]

Here's the research content to discuss:

${content}`;

        try {
            // Use VS Code's Language Model API
            const models = await vscode.lm.selectChatModels({ family: 'gpt-4' });
            if (models.length === 0) {
                // Fallback to any available model
                const allModels = await vscode.lm.selectChatModels();
                if (allModels.length === 0) {
                    throw new Error('No language models available');
                }
                models.push(allModels[0]);
            }

            const model = models[0];
            const messages = [vscode.LanguageModelChatMessage.User(prompt)];
            
            const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
            
            let responseText = '';
            for await (const chunk of response.text) {
                responseText += chunk;
            }

            // Parse the JSON response
            const jsonMatch = responseText.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                const dialogue = JSON.parse(jsonMatch[0]) as DialogueTurn[];
                // Validate the parsed dialogue structure
                if (Array.isArray(dialogue) && dialogue.length > 0 && 
                    dialogue.every(turn => typeof turn.speaker === 'string' && typeof turn.text === 'string')) {
                    return dialogue;
                }
            }

            throw new Error('Failed to parse dialogue from response');
        } catch (error) {
            console.error('Error generating dialogue:', error);
            // Return a fallback dialogue
            return this.createFallbackDialogue(content, config);
        }
    }

    /**
     * Create fallback dialogue if AI generation fails
     */
    private createFallbackDialogue(content: string, config: PodcastConfig): DialogueTurn[] {
        const summary = content.substring(0, 500);
        return [
            { speaker: 'host', text: "Welcome to today's research discussion. We have some fascinating findings to explore." },
            { speaker: 'guest', text: `Thank you for having me. ${summary}` },
            { speaker: 'host', text: "That's really interesting. What are the key implications of this research?" },
            { speaker: 'guest', text: "The main takeaway is that this opens up new possibilities for future research and applications." },
            { speaker: 'host', text: "Thank you for sharing these insights. That's all for today's episode!" }
        ];
    }

    /**
     * Generate audio from dialogue using edge-tts
     */
    private async generateAudio(
        dialogue: DialogueTurn[],
        config: PodcastConfig,
        timestamp: number,
        progress?: vscode.Progress<{ message?: string; increment?: number }>
    ): Promise<string> {
        const tempDir = path.join(this.outputDir, `temp_${timestamp}`);
        fs.mkdirSync(tempDir, { recursive: true });

        const hostVoice = PodcastGenerator.VOICES[config.voices.host as keyof typeof PodcastGenerator.VOICES] || PodcastGenerator.VOICES.jenny;
        const guestVoice = PodcastGenerator.VOICES[(config.voices.guest || 'guy') as keyof typeof PodcastGenerator.VOICES] || PodcastGenerator.VOICES.guy;

        const audioFiles: string[] = [];
        const totalTurns = dialogue.length;

        for (let i = 0; i < dialogue.length; i++) {
            const turn = dialogue[i];
            const voice = turn.speaker === 'host' ? hostVoice : guestVoice;
            const audioFile = path.join(tempDir, `part_${i.toString().padStart(3, '0')}.mp3`);
            
            progress?.report({ 
                message: `Generating audio (${i + 1}/${totalTurns})...`,
                increment: 40 / totalTurns
            });

            // Generate audio using edge-tts - write script to temp file to avoid escaping issues
            const pythonScript = `
import asyncio
import edge_tts
import sys

async def generate():
    text = sys.argv[1]
    voice = sys.argv[2]
    output = sys.argv[3]
    communicate = edge_tts.Communicate(text, voice)
    await communicate.save(output)

asyncio.run(generate())
`;
            const scriptFile = path.join(tempDir, `tts_${i}.py`);
            fs.writeFileSync(scriptFile, pythonScript, 'utf8');
            
            await execAsync(`"${this.pythonPath}" "${scriptFile}" "${turn.text}" "${voice}" "${audioFile}"`);
            audioFiles.push(audioFile);
        }

        // Combine audio files using ffmpeg or simple concatenation
        progress?.report({ message: 'Combining audio files...', increment: 10 });
        const finalAudioPath = path.join(this.outputDir, `podcast_${timestamp}.mp3`);
        
        await this.combineAudioFiles(audioFiles, finalAudioPath);

        // Clean up temp directory
        fs.rmSync(tempDir, { recursive: true, force: true });

        return finalAudioPath;
    }

    /**
     * Combine multiple audio files into one
     */
    private async combineAudioFiles(audioFiles: string[], outputPath: string): Promise<void> {
        // Try using ffmpeg if available
        try {
            const fileList = audioFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
            const listFile = outputPath.replace('.mp3', '_list.txt');
            fs.writeFileSync(listFile, fileList);
            
            await execAsync(`ffmpeg -f concat -safe 0 -i "${listFile}" -c copy "${outputPath}" -y`);
            fs.unlinkSync(listFile);
            return;
        } catch {
            // ffmpeg not available, use Python fallback
        }

        // Fallback: Use pydub to concatenate
        const pythonScript = `
from pydub import AudioSegment
import sys
import json

files = json.loads(sys.argv[1])
output_path = sys.argv[2]
combined = AudioSegment.empty()

for f in files:
    audio = AudioSegment.from_mp3(f)
    combined += audio
    # Add small pause between speakers
    combined += AudioSegment.silent(duration=300)

combined.export(output_path, format="mp3")
`;

        try {
            // Ensure pydub is installed
            await execAsync(`"${this.pythonPath}" -m pip install pydub --quiet --user`);
            
            // Write script to temp file and pass arguments safely
            const scriptFile = outputPath.replace('.mp3', '_combine.py');
            fs.writeFileSync(scriptFile, pythonScript, 'utf8');
            
            await execAsync(`"${this.pythonPath}" "${scriptFile}" '${JSON.stringify(audioFiles)}' "${outputPath}"`);
            fs.unlinkSync(scriptFile);
        } catch (error) {
            // If pydub fails, just copy the first file as a fallback
            console.error('Failed to combine audio files:', error);
            if (audioFiles.length > 0) {
                fs.copyFileSync(audioFiles[0], outputPath);
            }
        }
    }

    /**
     * Format transcript for saving
     */
    private formatTranscript(dialogue: DialogueTurn[], documents: DocumentMetadata[], config: PodcastConfig): string {
        let transcript = `# Research Podcast Transcript\n\n`;
        transcript += `**Generated:** ${new Date().toISOString()}\n`;
        transcript += `**Style:** ${config.style}\n`;
        transcript += `**Duration:** ${config.duration}\n\n`;
        
        transcript += `## Source Documents\n\n`;
        for (const doc of documents) {
            transcript += `- ${doc.name}\n`;
        }
        
        transcript += `\n---\n\n## Transcript\n\n`;
        
        for (const turn of dialogue) {
            const speakerName = turn.speaker === 'host' ? '**Host:**' : '**Guest:**';
            transcript += `${speakerName} ${turn.text}\n\n`;
        }

        return transcript;
    }

    /**
     * Get output directory
     */
    getOutputDir(): string {
        return this.outputDir;
    }
}
