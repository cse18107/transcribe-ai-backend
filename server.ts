import express from 'express';
import cors from 'cors';
import multer from 'multer';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import ffmpeg from 'fluent-ffmpeg';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { writeFile, readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { createReadStream } from 'fs';
import { File } from 'formdata-node'; // Install: npm install formdata-node
import { FormData } from 'formdata-node'; // Install: npm install formdata-node

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

// Set FFmpeg path
ffmpeg.setFfmpegPath('C:\\ffmpeg\\bin\\ffmpeg.exe');
ffmpeg.setFfprobePath('C:\\ffmpeg\\bin\\ffprobe.exe');

const app = express();
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  }
});

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 120000, // 120 seconds timeout
});

app.use(cors());
app.use(express.json());

interface TranscriptionResponse {
  text: string;
  language: string;
  timestamp: string;
}

// Helper function to retry API calls with exponential backoff
async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  initialDelay: number = 1000
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      console.log(`Attempt ${i + 1} failed:`, error);
      
      if (i < maxRetries - 1) {
        const delay = initialDelay * Math.pow(2, i);
        console.log(`Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

app.post('/api/transcribe', upload.single('audio'), async (req: express.Request, res: express.Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    console.log('Received file:', {
      name: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype
    });

    // Save the uploaded file temporarily
    const inputPath = join(__dirname, 'temp-input');
    const outputPath = join(__dirname, 'temp-output.mp3');
    await writeFile(inputPath, req.file.buffer);

    // Convert audio to MP3 format using fluent-ffmpeg
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .toFormat('mp3')
        .audioFrequency(16000)
        .audioChannels(1)
        .on('end', resolve)
        .on('error', (err) => {
          console.error('FFmpeg error:', err);
          reject(err);
        })
        .save(outputPath);
    });

    // Process the audio in chunks (for files >25MB)
    const chunkSize = 25 * 1024 * 1024; // 25MB chunks
    const fileBuffer = await readFile(outputPath);
    const fileSize = fileBuffer.length;
    const chunks = Math.ceil(fileSize / chunkSize);
    const transcriptChunks: TranscriptionResponse[] = [];

    for (let i = 0; i < chunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, fileSize);
      const chunkBuffer = fileBuffer.slice(start, end);
      
      // Create a temporary file for this chunk
      const chunkPath = join(__dirname, `chunk-${i}.mp3`);
      await writeFile(chunkPath, chunkBuffer);

      try {
        // Create a File object for the chunk
        const file = new File([chunkBuffer], `chunk-${i}.mp3`, { type: 'audio/mp3' });
        
        // Create FormData and append the file
        const formData = new FormData();
        formData.append('file', file);
        formData.append('model', 'whisper-1');
        formData.append('response_format', 'verbose_json');

        // Use retryWithBackoff for the transcription
        const transcription = await retryWithBackoff(async () => {
          return await openai.audio.transcriptions.create({
            file: file,
            model: "whisper-1",
            response_format: "verbose_json",
          });
        });

        console.log('Transcription:', transcription);
        transcriptChunks.push({
          text: transcription.text,
          language: transcription.language,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        console.error(`Failed to transcribe chunk ${i}:`, error);
        throw error;
      } finally {
        // Clean up chunk file
        await unlink(chunkPath);
      }
    }

    // Clean up temporary files
    await unlink(inputPath);
    await unlink(outputPath);

    console.log('Transcription completed successfully', transcriptChunks);
    res.json({ transcript: transcriptChunks });
  } catch (error) {
    console.error('Transcription error:', error);
    res.status(500).json({ 
      error: 'Failed to process audio file',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});