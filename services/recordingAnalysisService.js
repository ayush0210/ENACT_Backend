import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import OpenAI from 'openai';

const CATEGORIES = ['science', 'social', 'literature', 'language'];
const KEYWORDS = {
    science: [
        'experiment',
        'hypothesis',
        'observe',
        'predict',
        'measure',
        'science',
        'discover',
        'investigate',
        'evidence',
        'nature',
        'weather',
        'water',
        'plant',
        'animal',
        'space',
        'planet',
        'moon',
        'sun',
        'grow',
        'because',
        'why',
        'how',
    ],
    social: [
        'friend',
        'share',
        'help',
        'together',
        'feeling',
        'happy',
        'sad',
        'angry',
        'excited',
        'sorry',
        'please',
        'family',
        'kind',
        'fair',
        'play',
        'teacher',
    ],
    literature: [
        'story',
        'character',
        'beginning',
        'ending',
        'imagine',
        'pretend',
        'book',
        'read',
        'page',
        'author',
        'once upon a time',
        'the end',
        'prince',
        'princess',
        'dragon',
        'adventure',
    ],
    language: [
        'word',
        'sentence',
        'speak',
        'listen',
        'communicate',
        'language',
        'voice',
        'describe',
        'explain',
        'meaning',
        'question',
        'answer',
        'conversation',
        'pronounce',
        'letter',
        'alphabet',
        'spell',
        'vocabulary',
    ],
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function countWords(text) {
    return (text || '').trim().split(/\s+/).filter(Boolean).length;
}

function keywordSegments(transcript) {
    const segments = [];
    for (const category of CATEGORIES) {
        for (const keyword of KEYWORDS[category]) {
            const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(
                `\\b${escaped.replace(/\\s+/g, '\\s+')}\\b`,
                'gi',
            );
            let match;
            while ((match = regex.exec(transcript)) !== null) {
                segments.push({
                    text: match[0],
                    category,
                    startIndex: match.index,
                    endIndex: match.index + match[0].length,
                });
            }
        }
    }
    return segments.sort((a, b) => a.startIndex - b.startIndex);
}

function normalizeSegments(transcript, proposed) {
    const accepted = [];
    for (const segment of Array.isArray(proposed) ? proposed : []) {
        if (
            !CATEGORIES.includes(segment?.category) ||
            typeof segment?.text !== 'string'
        )
            continue;
        const startIndex = transcript.indexOf(segment.text);
        if (startIndex < 0) continue;
        const candidate = {
            text: segment.text,
            category: segment.category,
            startIndex,
            endIndex: startIndex + segment.text.length,
        };
        const overlaps = accepted.some(
            item =>
                candidate.startIndex < item.endIndex &&
                candidate.endIndex > item.startIndex,
        );
        if (!overlaps) accepted.push(candidate);
    }
    return accepted.sort((a, b) => a.startIndex - b.startIndex);
}

function buildMetrics(segments, durationSeconds) {
    const categoryWordCounts = Object.fromEntries(
        CATEGORIES.map(category => [category, 0]),
    );
    for (const segment of segments)
        categoryWordCounts[segment.category] += countWords(segment.text);
    const classifiedTotal = Object.values(categoryWordCounts).reduce(
        (sum, value) => sum + value,
        0,
    );
    const categoryPercentages = {};
    const categoryWpm = {};
    for (const category of CATEGORIES) {
        categoryPercentages[category] = classifiedTotal
            ? Math.round(
                  (categoryWordCounts[category] / classifiedTotal) * 1000,
              ) / 10
            : 0;
        categoryWpm[category] =
            durationSeconds > 0
                ? Math.round(
                      (categoryWordCounts[category] / (durationSeconds / 60)) *
                          10,
                  ) / 10
                : null;
    }
    return { categoryWordCounts, categoryPercentages, categoryWpm };
}

async function transcribe(filePath, filename, mimetype) {
    if (!process.env.REVAI_API_KEY)
        throw new Error('REVAI_API_KEY is not configured');
    const baseUrl =
        process.env.REVAI_API_BASE_URL || 'https://api.rev.ai/speechtotext/v1';
    const form = new FormData();
    form.append('media', fs.createReadStream(filePath), {
        filename,
        contentType: mimetype,
    });
    form.append('skip_diarization', 'true');
    form.append('language', 'en');
    const submitted = await axios.post(`${baseUrl}/jobs`, form, {
        headers: {
            ...form.getHeaders(),
            Authorization: `Bearer ${process.env.REVAI_API_KEY}`,
        },
        timeout: 60_000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
    });
    const jobId = submitted.data?.id;
    if (!jobId) throw new Error('Rev.ai did not return a job id');

    const deadline =
        Date.now() +
        Number(process.env.RECORDING_TRANSCRIPTION_TIMEOUT_MS || 600_000);
    let durationSeconds = null;
    while (Date.now() < deadline) {
        await sleep(2_000);
        const job = await axios.get(`${baseUrl}/jobs/${jobId}`, {
            headers: { Authorization: `Bearer ${process.env.REVAI_API_KEY}` },
            timeout: 30_000,
        });
        if (job.data?.status === 'failed') {
            throw new Error(
                `Rev.ai transcription failed: ${job.data?.failure_detail || 'unknown error'}`,
            );
        }
        if (job.data?.status !== 'transcribed') continue;
        durationSeconds = job.data?.duration_seconds ?? null;
        const response = await axios.get(
            `${baseUrl}/jobs/${jobId}/transcript`,
            {
                headers: {
                    Authorization: `Bearer ${process.env.REVAI_API_KEY}`,
                    Accept: 'application/vnd.rev.transcript.v1.0+json',
                },
                timeout: 30_000,
            },
        );
        const transcript = (response.data?.monologues || [])
            .flatMap(monologue => monologue.elements || [])
            .map(element => element.value || '')
            .join('')
            .trim();
        return { transcript, durationSeconds, jobId };
    }
    throw new Error('Rev.ai transcription timed out');
}

async function classify(transcript) {
    if (
        !process.env.OPENAI_API_KEY ||
        process.env.RECORDING_LLM_ENABLED === 'false'
    ) {
        return {
            segments: keywordSegments(transcript),
            method: 'keyword-only',
        };
    }
    try {
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const response = await openai.chat.completions.create({
            model: process.env.OPENAI_CLASSIFICATION_MODEL || 'gpt-4o-mini',
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
                {
                    role: 'system',
                    content:
                        'Classify exact, non-overlapping transcript phrases into science, social, literature, or language. Science includes observations and natural phenomena; social includes feelings and relationships; literature includes stories and imaginative narrative; language includes vocabulary, reading, writing, and communication. Return JSON as {"segments":[{"text":"exact transcript text","category":"science|social|literature|language"}]}. Never paraphrase.',
                },
                { role: 'user', content: transcript },
            ],
        });
        const parsed = JSON.parse(
            response.choices[0]?.message?.content || '{}',
        );
        const segments = normalizeSegments(transcript, parsed.segments);
        if (segments.length) return { segments, method: 'llm' };
    } catch (error) {
        console.error(
            'Recording classification failed; using keyword fallback:',
            error.message,
        );
    }
    return { segments: keywordSegments(transcript), method: 'keyword-only' };
}

export async function analyzeRecording({
    filePath,
    filename,
    mimetype,
    suppliedDurationSeconds,
}) {
    const transcription = await transcribe(filePath, filename, mimetype);
    const transcript = transcription.transcript || '';
    const durationSeconds =
        transcription.durationSeconds ?? suppliedDurationSeconds ?? null;
    const wordCount = countWords(transcript);
    const wordsPerMinute =
        durationSeconds > 0
            ? Math.round((wordCount / (durationSeconds / 60)) * 10) / 10
            : null;
    const classification = await classify(transcript);
    return {
        transcript,
        durationSeconds,
        wordCount,
        wordsPerMinute,
        segments: classification.segments,
        classificationMethod: classification.method,
        ...buildMetrics(classification.segments, durationSeconds),
    };
}

export const recordingAnalysisInternals = {
    keywordSegments,
    normalizeSegments,
    buildMetrics,
    countWords,
};
