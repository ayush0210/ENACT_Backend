import express from 'express';
import audioRoutes from './routes/audio.js';
import path from 'path';
import { fileURLToPath } from 'url';
import body from 'body-parser';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import url from 'url';
import http from 'http';
import location from './routes/location.js';
import 'dotenv/config';
import morgan from 'morgan';
import user from './routes/user.js';
import tips from './routes/tips.js';
import childrenRouter from './routes/children.js';
import sessionRoutes from './routes/sessions.js';
import dashboardRoutes from './routes/dashboard.js';
import adminRoutes from './routes/adminRoutes.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import personalizationRoutes, {
    buildSurveyContext,
    categoryReply,
    looksLikeParentingPrompt,
    reframeAsParenting,
    safeJSONParse,
} from './routes/personalization.js';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
app.use(cors());
app.use(morgan('dev'));
app.use(cookieParser('session'));
app.use(body.json());
app.use(body.urlencoded({ extended: true }));
app.use('/endpoint', childrenRouter);
app.use('/endpoint/session', sessionRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/admin', adminRoutes);
import authroutes from './routes/auth.js';
import { isStrictlyInScope } from './utils/strictDomains.js';
import pool from './config/db.js';
import personalizationService from './services/personalizationService.js';
app.use('/api/auth', authroutes);
app.use('/api/home', user);
app.use('/api/tips', tips);
app.use('/api/personalization', personalizationRoutes);
// Serve static audio files
app.use('/audio', express.static(path.join(__dirname, 'public', 'audio')));

// Audio generation routes
app.use('/api/tips/audio', audioRoutes);

// --- WS server wiring ---
const server = http.createServer(app); // 👈 wrap express
const wss = new WebSocketServer({
    server,
    path: '/ws/personalization', // 👈 WS path
});

function sendJSON(ws, obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

wss.on('connection', async (ws, req) => {
    const openedAt = Date.now();
    console.log(`[WS] Client connected`);
    // ---- simple JWT check on handshake (?token=...) ----
    const { query } = url.parse(req.url, true);
    try {
        if (!query?.token) throw new Error('Missing token');
        req.user = jwt.verify(query.token, process.env.JWT_SECRET);
    } catch (e) {
        sendJSON(ws, { type: 'error', message: 'Unauthorized' });
        return ws.close(1008, 'Unauthorized');
    }

    let aborted = false;
    ws.on('close', (code, reasonBuf) => {
        const lifetime = Date.now() - openedAt;
        const reason = reasonBuf?.toString?.() || '';
        console.log(
            `[WS] Client disconnected after ${lifetime} ms | code=${code} reason="${reason}"`,
        );
        aborted = true;
    });

    ws.once('message', async raw => {
        let msg;
        try {
            msg = JSON.parse(String(raw));
        } catch {
            sendJSON(ws, { type: 'error', message: 'Bad JSON' });
            return ws.close();
        }
        if (msg.type !== 'start') {
            sendJSON(ws, {
                type: 'error',
                message: 'First message must be type=start',
            });
            return ws.close();
        }

        try {
            const userId = req.user.id;
            const {
                prompt,
                contentPreferences = [],
                generateMode = 'hybrid',
            } = msg;
            if (!prompt) {
                sendJSON(ws, { type: 'error', message: 'Prompt is required' });
                return ws.close();
            }

            // --- your scope checks (same as REST) ---
            let effectivePrompt = prompt;
            const v = isStrictlyInScope(prompt);
            if (!v.isValid) {
                if (looksLikeParentingPrompt(prompt)) {
                    effectivePrompt = reframeAsParenting(
                        prompt,
                        'This question is about my child. Strictly provide age-appropriate, safe, practical parenting strategies.',
                    );
                } else {
                    const { status, payload } = categoryReply(v.type, prompt);
                    sendJSON(ws, { type: 'out_of_scope', status, payload });
                    return ws.close();
                }
            }

            // --- survey context (same SQL as REST) ---
            const [surveyRows] = await pool.query(
                'SELECT content_preferences, challenge_areas, parenting_goals, current_challenge FROM user_survey_responses WHERE user_id = ?',
                [userId],
            );

            let enhancedContentPrefs = [...contentPreferences];
            let surveyContext = '';
            let hasSurveyData = false;
            if (surveyRows.length) {
                const survey = surveyRows[0];
                const userPrefs =
                    safeJSONParse(survey.content_preferences) ?? [];
                enhancedContentPrefs = [
                    ...new Set([...enhancedContentPrefs, ...userPrefs]),
                ];
                hasSurveyData = true;
                surveyContext = buildSurveyContext(survey);
            }

            sendJSON(ws, {
                type: 'start',
                mode: generateMode,
                hasSurveyData,
                effectivePrompt,
            });

            // --- stream AI tips first ---
            let emitted = 0;
            if (generateMode === 'generate' || generateMode === 'hybrid') {
                await personalizationService.generateTipsStreamNDJSON({
                    ws,
                    abortedRef: () => aborted,
                    userId,
                    query: surveyContext
                        ? `${effectivePrompt}\n\nUser Context: ${surveyContext}`
                        : effectivePrompt,
                    contentPreferences: enhancedContentPrefs,
                    onPhase: phase =>
                        sendJSON(ws, { type: 'phase', data: phase }),
                    onTip: async tip => {
                        const scored =
                            await personalizationService.scoreSingleGeneratedTip(
                                {
                                    userId,
                                    query: effectivePrompt,
                                    tip,
                                },
                            );
                        if (!scored) return;
                        emitted += 1;
                        sendJSON(ws, {
                            type: 'tip',
                            source: 'ai',
                            data: scored,
                        });
                    },
                });
            }

            // --- DB fallback if AI produced nothing ---
            if (
                emitted === 0 &&
                (generateMode === 'database' || generateMode === 'hybrid')
            ) {
                const dbResult =
                    await personalizationService.getContextualPersonalizedTips(
                        userId,
                        effectivePrompt,
                        5,
                        enhancedContentPrefs,
                    );
                if (dbResult?.tips?.length) {
                    sendJSON(ws, {
                        type: 'batch',
                        source: 'database',
                        items: dbResult.tips,
                    });
                }
            }

            sendJSON(ws, { type: 'done' });
            ws.close();
        } catch (err) {
            console.error('WS error:', err);
            sendJSON(ws, {
                type: 'error',
                message: err?.message || 'Internal error',
            });
            ws.close();
        }
    });
});

app.get('/', async (req, res) => {
    return res.send('Active');
});
app.use('/endpoint', location);
const port = process.env.PORT || 1337;
server.listen(port, err => {
    if (err) console.log(err);
    else console.log(err || 'Listening on port ' + port);
});
