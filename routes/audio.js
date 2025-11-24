import express from 'express';
import { OpenAI } from 'openai';
import fs from 'fs/promises';
import path from 'path';
import NodeCache from 'node-cache';
import pool from '../config/db.js';

const router = express.Router();

// Cache audio URLs for 2 hours
const audioCache = new NodeCache({ stdTTL: 7200 });

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Ensure public/audio directory exists
const AUDIO_DIR = path.join(process.cwd(), 'public', 'audio');
await fs.mkdir(AUDIO_DIR, { recursive: true });

// Generate audio from tip content (for AI-generated tips)
router.post('/generate-from-content', async (req, res) => {
    try {
        const { title, body, details } = req.body;
        
        if (!title || !body) {
            return res.status(400).json({ error: 'Title and body are required' });
        }

        // Create cache key from content
        const contentHash = `${title}_${body}`.substring(0, 50);
        const cacheKey = `audio_content_${contentHash}`;
        const cachedUrl = audioCache.get(cacheKey);
        
        if (cachedUrl) {
            console.log(`✅ Serving cached audio for content`);
            return res.json({ audioUrl: cachedUrl });
        }

        // Generate audio content
        const audioContent = `${title}. ${body}`;
        
        console.log(`🎵 Generating audio from content: "${title}"`);

        // Generate speech using OpenAI TTS
        const mp3 = await openai.audio.speech.create({
            model: 'tts-1',
            voice: 'nova',
            input: audioContent,
            speed: 0.95,
        });

        // Save to file with timestamp
        const timestamp = Date.now();
        const fileName = `tip_ai_${timestamp}.mp3`;
        const filePath = path.join(AUDIO_DIR, fileName);
        const buffer = Buffer.from(await mp3.arrayBuffer());
        await fs.writeFile(filePath, buffer);

        // Generate URL
        const audioUrl = `/audio/${fileName}`;
        
        // Cache the URL
        audioCache.set(cacheKey, audioUrl);

        console.log(`✅ Audio generated from content: ${audioUrl}`);

        res.json({ audioUrl });

    } catch (error) {
        console.error('Error generating audio from content:', error);
        res.status(500).json({ 
            error: 'Failed to generate audio',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});
// Generate audio for a specific tip
router.post('/:tipId/generate', async (req, res) => {
    try {
        const tipId = req.params.tipId;
        
        // Check cache first
        const cacheKey = `audio_${tipId}`;
        const cachedUrl = audioCache.get(cacheKey);
        
        if (cachedUrl) {
            console.log(`✅ Serving cached audio for tip ${tipId}`);
            return res.json({ audioUrl: cachedUrl });
        }

        // Fetch tip from database
        const [tips] = await pool.query(
            'SELECT id, title, description FROM tips WHERE id = ?',
            [tipId]
        );

        if (tips.length === 0) {
            return res.status(404).json({ error: 'Tip not found' });
        }

        const tip = tips[0];
        
        // Generate audio content (title + description)
        const audioContent = `${tip.title}. ${tip.description}`;
        
        console.log(`🎵 Generating audio for tip ${tipId}: "${tip.title}"`);

        // Generate speech using OpenAI TTS
        const mp3 = await openai.audio.speech.create({
            model: 'tts-1',
            voice: 'nova', // or 'alloy', 'echo', 'fable', 'onyx', 'shimmer'
            input: audioContent,
            speed: 0.95, // Slightly slower for clarity
        });

        // Save to file
        const fileName = `tip_${tipId}.mp3`;
        const filePath = path.join(AUDIO_DIR, fileName);
        const buffer = Buffer.from(await mp3.arrayBuffer());
        await fs.writeFile(filePath, buffer);

        // Generate URL
        const audioUrl = `/audio/${fileName}`;
        
        // Cache the URL
        audioCache.set(cacheKey, audioUrl);

        console.log(`✅ Audio generated for tip ${tipId}: ${audioUrl}`);

        res.json({ audioUrl });

    } catch (error) {
        console.error('Error generating audio:', error);
        res.status(500).json({ 
            error: 'Failed to generate audio',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Batch generate audio for multiple tips (optional, for preloading)
router.post('/batch-generate', async (req, res) => {
    try {
        const { tipIds } = req.body;
        
        if (!Array.isArray(tipIds) || tipIds.length === 0) {
            return res.status(400).json({ error: 'tipIds array is required' });
        }

        const results = [];

        for (const tipId of tipIds.slice(0, 10)) { // Limit to 10 at once
            try {
                const cacheKey = `audio_${tipId}`;
                let audioUrl = audioCache.get(cacheKey);

                if (!audioUrl) {
                    // Fetch and generate audio
                    const [tips] = await pool.query(
                        'SELECT id, title, description FROM tips WHERE id = ?',
                        [tipId]
                    );

                    if (tips.length > 0) {
                        const tip = tips[0];
                        const audioContent = `${tip.title}. ${tip.description}`;

                        const mp3 = await openai.audio.speech.create({
                            model: 'tts-1',
                            voice: 'nova',
                            input: audioContent,
                            speed: 0.95,
                        });

                        const fileName = `tip_${tipId}.mp3`;
                        const filePath = path.join(AUDIO_DIR, fileName);
                        const buffer = Buffer.from(await mp3.arrayBuffer());
                        await fs.writeFile(filePath, buffer);

                        audioUrl = `/audio/${fileName}`;
                        audioCache.set(cacheKey, audioUrl);
                    }
                }

                results.push({ tipId, audioUrl, success: !!audioUrl });
            } catch (error) {
                console.error(`Failed to generate audio for tip ${tipId}:`, error);
                results.push({ tipId, audioUrl: null, success: false, error: error.message });
            }
        }

        res.json({ results });

    } catch (error) {
        console.error('Batch audio generation error:', error);
        res.status(500).json({ error: 'Failed to generate batch audio' });
    }
});

// Get audio URL if it exists (no generation)
router.get('/:tipId', async (req, res) => {
    try {
        const tipId = req.params.tipId;
        const cacheKey = `audio_${tipId}`;
        const cachedUrl = audioCache.get(cacheKey);

        if (cachedUrl) {
            return res.json({ audioUrl: cachedUrl, cached: true });
        }

        // Check if file exists
        const fileName = `tip_${tipId}.mp3`;
        const filePath = path.join(AUDIO_DIR, fileName);
        
        try {
            await fs.access(filePath);
            const audioUrl = `/audio/${fileName}`;
            audioCache.set(cacheKey, audioUrl);
            return res.json({ audioUrl, cached: false });
        } catch {
            return res.status(404).json({ error: 'Audio not found', needsGeneration: true });
        }

    } catch (error) {
        console.error('Error checking audio:', error);
        res.status(500).json({ error: 'Failed to check audio status' });
    }
});

export default router;
