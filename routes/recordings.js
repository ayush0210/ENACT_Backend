import express from 'express';
import fs from 'fs/promises';
import multer from 'multer';
import os from 'os';
import path from 'path';
import pool from '../config/db.js';
import { authenticateJWT } from './middleware.js';
import { analyzeRecording } from '../services/recordingAnalysisService.js';

const router = express.Router();
const uploadDirectory = path.join(os.tmpdir(), 'enact-recording-uploads');
await fs.mkdir(uploadDirectory, { recursive: true });

const allowedMimeTypes = new Set([
    'audio/mp4',
    'audio/m4a',
    'audio/x-m4a',
    'audio/mpeg',
    'audio/wav',
    'audio/webm',
    'audio/ogg',
]);

const upload = multer({
    dest: uploadDirectory,
    limits: {
        fileSize: Number(process.env.RECORDING_MAX_BYTES || 50 * 1024 * 1024),
    },
    fileFilter: (_req, file, callback) => {
        if (allowedMimeTypes.has(file.mimetype)) callback(null, true);
        else callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'audio'));
    },
});

function parseJsonColumn(value, fallback) {
    if (value == null) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function serializeRecording(row, includeTranscript = true) {
    return {
        id: Number(row.id),
        clientRecordingId: row.client_recording_id,
        childId: Number(row.child_id),
        status: row.status,
        recordedAt: row.recorded_at,
        createdAt: row.created_at,
        completedAt: row.completed_at,
        ...(includeTranscript ? { transcript: row.transcript || null } : {}),
        classificationMethod: row.classification_method || null,
        metrics: {
            durationSeconds:
                row.duration_seconds == null
                    ? null
                    : Number(row.duration_seconds),
            wordCount: row.word_count == null ? null : Number(row.word_count),
            wordsPerMinute:
                row.words_per_minute == null
                    ? null
                    : Number(row.words_per_minute),
        },
        categories: {
            wordCounts: parseJsonColumn(row.category_word_counts, {}),
            percentages: parseJsonColumn(row.category_percentages, {}),
            wordsPerMinute: parseJsonColumn(row.category_wpm, {}),
        },
        segments: parseJsonColumn(row.classified_segments, []),
        error:
            row.status === 'failed'
                ? {
                      code: row.error_code || 'PROCESSING_FAILED',
                      message: row.error_message || 'Processing failed',
                  }
                : null,
    };
}

async function deleteTempFile(filePath) {
    if (!filePath) return;
    await fs.unlink(filePath).catch(() => {});
}

async function processRecording(recordingId, file) {
    try {
        await pool.query(
            "UPDATE recordings SET status = 'processing', error_code = NULL, error_message = NULL WHERE id = ?",
            [recordingId],
        );
        const [rows] = await pool.query(
            'SELECT duration_seconds FROM recordings WHERE id = ?',
            [recordingId],
        );
        const result = await analyzeRecording({
            filePath: file.path,
            filename: file.originalname,
            mimetype: file.mimetype,
            suppliedDurationSeconds:
                rows[0]?.duration_seconds == null
                    ? null
                    : Number(rows[0].duration_seconds),
        });
        await pool.query(
            `UPDATE recordings
             SET status = 'completed', audio_file_path = NULL, transcript = ?,
                 classification_method = ?, duration_seconds = ?, word_count = ?,
                 words_per_minute = ?, category_word_counts = ?, category_percentages = ?,
                 category_wpm = ?, classified_segments = ?, completed_at = NOW(),
                 transcript_expires_at = DATE_ADD(recorded_at, INTERVAL 365 DAY)
             WHERE id = ?`,
            [
                result.transcript,
                result.classificationMethod,
                result.durationSeconds,
                result.wordCount,
                result.wordsPerMinute,
                JSON.stringify(result.categoryWordCounts),
                JSON.stringify(result.categoryPercentages),
                JSON.stringify(result.categoryWpm),
                JSON.stringify(result.segments),
                recordingId,
            ],
        );
    } catch (error) {
        console.error(`Recording ${recordingId} processing failed:`, error);
        await pool
            .query(
                `UPDATE recordings
             SET status = 'failed', audio_file_path = NULL, error_code = ?, error_message = ?, completed_at = NOW()
             WHERE id = ?`,
                [
                    'PROCESSING_FAILED',
                    String(error?.message || 'Processing failed').slice(
                        0,
                        2000,
                    ),
                    recordingId,
                ],
            )
            .catch(dbError =>
                console.error('Failed to store recording error:', dbError),
            );
    } finally {
        await deleteTempFile(file.path);
    }
}

router.post('/', authenticateJWT, upload.single('audio'), async (req, res) => {
    let accepted = false;
    try {
        if (!req.file)
            return res.status(400).json({ error: 'Audio file is required' });
        const userId = req.user.id;
        const { childId, clientRecordingId, recordedAt, durationSeconds } =
            req.body;
        if (!childId || !clientRecordingId || !recordedAt) {
            return res
                .status(400)
                .json({
                    error: 'childId, clientRecordingId, and recordedAt are required',
                });
        }
        if (!/^[A-Za-z0-9._:-]{1,100}$/.test(clientRecordingId)) {
            return res.status(400).json({ error: 'Invalid clientRecordingId' });
        }
        const parsedDate = new Date(recordedAt);
        if (
            Number.isNaN(parsedDate.getTime()) ||
            parsedDate > new Date(Date.now() + 5 * 60 * 1000)
        ) {
            return res.status(400).json({ error: 'Invalid recordedAt value' });
        }

        const [users] = await pool.query(
            'SELECT recording FROM users WHERE id = ?',
            [userId],
        );
        if (!users.length)
            return res.status(401).json({ error: 'User not found' });
        if (!Boolean(users[0].recording)) {
            return res
                .status(403)
                .json({ error: 'Recording is not enabled for this account' });
        }
        const [children] = await pool.query(
            'SELECT id FROM children WHERE id = ? AND user_id = ?',
            [childId, userId],
        );
        if (!children.length)
            return res
                .status(403)
                .json({ error: 'Child does not belong to this account' });

        const [existing] = await pool.query(
            'SELECT * FROM recordings WHERE user_id = ? AND client_recording_id = ?',
            [userId, clientRecordingId],
        );
        if (existing.length) {
            if (existing[0].status === 'failed') {
                await pool.query(
                    `UPDATE recordings
                     SET status = 'queued', audio_file_path = ?, error_code = NULL,
                         error_message = NULL, completed_at = NULL
                     WHERE id = ? AND user_id = ?`,
                    [req.file.path, existing[0].id, userId],
                );
                accepted = true;
                setImmediate(() => processRecording(existing[0].id, req.file));
                return res.status(202).json({
                    recording: {
                        id: Number(existing[0].id),
                        clientRecordingId,
                        childId: Number(childId),
                        status: 'queued',
                    },
                });
            }
            return res
                .status(200)
                .json({ recording: serializeRecording(existing[0]) });
        }

        const normalizedDuration = Number(durationSeconds);
        const [insert] = await pool.query(
            `INSERT INTO recordings
             (client_recording_id, user_id, child_id, status, audio_file_path, recorded_at, duration_seconds)
             VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
            [
                clientRecordingId,
                userId,
                childId,
                req.file.path,
                parsedDate,
                Number.isFinite(normalizedDuration) && normalizedDuration > 0
                    ? normalizedDuration
                    : null,
            ],
        );
        accepted = true;
        setImmediate(() => processRecording(insert.insertId, req.file));
        return res.status(202).json({
            recording: {
                id: insert.insertId,
                clientRecordingId,
                childId: Number(childId),
                status: 'queued',
            },
        });
    } catch (error) {
        if (error?.code === 'ER_DUP_ENTRY') {
            const [rows] = await pool.query(
                'SELECT * FROM recordings WHERE user_id = ? AND client_recording_id = ?',
                [req.user.id, req.body.clientRecordingId],
            );
            if (rows.length)
                return res
                    .status(200)
                    .json({ recording: serializeRecording(rows[0]) });
        }
        console.error('Recording upload failed:', error);
        return res.status(500).json({ error: 'Failed to accept recording' });
    } finally {
        if (!accepted) await deleteTempFile(req.file?.path);
    }
});

router.get('/', authenticateJWT, async (req, res) => {
    try {
        const params = [req.user.id];
        let where = 'WHERE user_id = ?';
        if (req.query.childId) {
            where += ' AND child_id = ?';
            params.push(req.query.childId);
        }
        const [rows] = await pool.query(
            `SELECT * FROM recordings ${where} ORDER BY created_at DESC LIMIT 100`,
            params,
        );
        return res.json({
            recordings: rows.map(row => serializeRecording(row, false)),
        });
    } catch (error) {
        console.error('Failed to list recordings:', error);
        return res.status(500).json({ error: 'Failed to list recordings' });
    }
});

router.get('/:id', authenticateJWT, async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM recordings WHERE id = ? AND user_id = ?',
            [req.params.id, req.user.id],
        );
        if (!rows.length)
            return res.status(404).json({ error: 'Recording not found' });
        return res.json({ recording: serializeRecording(rows[0]) });
    } catch (error) {
        console.error('Failed to fetch recording:', error);
        return res.status(500).json({ error: 'Failed to fetch recording' });
    }
});

router.delete('/:id', authenticateJWT, async (req, res) => {
    try {
        const [result] = await pool.query(
            'DELETE FROM recordings WHERE id = ? AND user_id = ?',
            [req.params.id, req.user.id],
        );
        if (!result.affectedRows)
            return res.status(404).json({ error: 'Recording not found' });
        return res.status(204).send();
    } catch (error) {
        console.error('Failed to delete recording:', error);
        return res.status(500).json({ error: 'Failed to delete recording' });
    }
});

router.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError) {
        const message =
            error.code === 'LIMIT_FILE_SIZE'
                ? 'Audio file is too large'
                : 'Unsupported or invalid audio upload';
        return res.status(400).json({ error: message });
    }
    console.error('Recording route error:', error);
    return res.status(500).json({ error: 'Recording request failed' });
});

export default router;
