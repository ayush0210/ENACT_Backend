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
import geofenceRouter from './routes/geofence.js';
import 'dotenv/config';
import morgan from 'morgan';
import user from './routes/user.js';
import tips from './routes/tips.js';
import childrenRouter from './routes/children.js';
import childPersonalizationRouter from './routes/childPersonalization.js';
import sessionRoutes from './routes/sessions.js';
import dashboardRoutes from './routes/dashboard.js';
import adminRoutes from './routes/adminRoutes.js';
import activitiesRouter from './routes/activities.js';
import issueReportsRouter from './routes/issueReports.js';
import diagnosticsRouter from './routes/diagnostics.js';
import recordingsRouter from './routes/recordings.js';
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
app.use('/api/children', childPersonalizationRouter);
app.use('/endpoint/session', sessionRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/activities', activitiesRouter);
app.use('/api/issue-reports', issueReportsRouter);
app.use('/api/diagnostics', diagnosticsRouter);
app.use('/api/recordings', recordingsRouter);
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

import { getApprovedActivities } from './utils/activityCache.js';

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
        console.log(`[WS] Auth failed: ${e.message} — closing 1008`);
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
        // TEMP DIAGNOSTIC — remove once the scope-check regression is confirmed
        // fixed in production. Logs shape/lengths only, never the JWT.
        console.log(
            `[DIAG] WS raw message received: length=${String(raw).length}`,
        );

        let msg;
        try {
            msg = JSON.parse(String(raw));
        } catch {
            sendJSON(ws, { type: 'error', message: 'Bad JSON' });
            return ws.close();
        }

        // TEMP DIAGNOSTIC
        console.log('[DIAG] WS parsed payload:', {
            type: msg?.type,
            promptLength:
                typeof msg?.prompt === 'string' ? msg.prompt.length : null,
            contentPreferences: msg?.contentPreferences,
            generateMode: msg?.generateMode,
            childId: msg?.childId ?? null,
        });

        if (msg.type !== 'start') {
            sendJSON(ws, {
                type: 'error',
                message: 'First message must be type=start',
            });
            // TEMP DIAGNOSTIC
            console.log('[DIAG] WS closing: reason=non-start-first-message');
            return ws.close();
        }

        try {
            const userId = req.user.id;
            // TEMP DIAGNOSTIC — auth result, never the token itself.
            console.log(`[DIAG] WS authenticated userId=${userId}`);

            const {
                prompt,
                contentPreferences = [],
                generateMode = 'hybrid',
                childId: rawChildId = null,
            } = msg;
            if (!prompt) {
                sendJSON(ws, { type: 'error', message: 'Prompt is required' });
                // TEMP DIAGNOSTIC
                console.log('[DIAG] WS closing: reason=missing-prompt');
                return ws.close();
            }

            // Never trust a client-supplied childId without verifying
            // ownership — same rule as every REST route in this codebase
            // (see routes/children.js). An unowned/unknown id is treated as
            // "no child context" rather than an error, since childId here is
            // purely an optional personalization hint, not a required field.
            let childId = null;
            const candidateChildId = Number(rawChildId);
            if (Number.isInteger(candidateChildId) && candidateChildId > 0) {
                const [ownedChild] = await pool.query(
                    'SELECT id FROM children WHERE id = ? AND user_id = ?',
                    [candidateChildId, userId],
                );
                if (ownedChild.length) childId = candidateChildId;
            }
            // TEMP DIAGNOSTIC — whether a child was resolved for personalization.
            console.log(
                `[DIAG] WS childId resolved: raw=${JSON.stringify(rawChildId)} resolved=${childId}`,
            );

            // --- your scope checks (same as REST) ---
            // NOTE: isStrictlyInScope is `async` (it calls an LLM classifier).
            // This call was missing `await`, so `v` was a pending Promise —
            // `v.isValid` was always `undefined`, so `!v.isValid` was always
            // `true`, and EVERY prompt was rejected as out-of-scope regardless
            // of content. This is the fix for that regression.
            const effectivePrompt = prompt;
            const approvedActivities = await getApprovedActivities();
            const v = await isStrictlyInScope(prompt, approvedActivities);
            // TEMP DIAGNOSTIC — guardrail result, never logs the raw prompt.
            console.log('[DIAG] WS scope check result:', {
                isValid: v.isValid,
                domain: v.domain,
                reason: v.reason,
                classifiedBy: v.classifiedBy,
            });
            if (!v.isValid) {
                const { status, payload } = categoryReply(v.reason ?? v.type, prompt);
                sendJSON(ws, { type: 'out_of_scope', status, payload });
                // TEMP DIAGNOSTIC
                console.log(
                    `[DIAG] WS closing: reason=out_of_scope guardrailReason=${v.reason ?? v.type}`,
                );
                return ws.close();
            }

            // --- survey context (same SQL as REST) ---
            const [surveyRows] = await pool.query(
                'SELECT content_preferences, challenge_areas, parenting_goals, current_challenge FROM user_survey_responses WHERE user_id = ?',
                [userId],
            );

            let enhancedContentPrefs = Array.isArray(contentPreferences)
                ? [...contentPreferences]
                : [];
            let surveyContext = '';
            let hasSurveyData = false;
            if (surveyRows.length) {
                const survey = surveyRows[0];
                const userPrefs =
                    safeJSONParse(survey.content_preferences) ?? [];
                // The in-app selected content preferences are the active filter.
                // Survey preferences only fill in when the app sends no active filter.
                if (!enhancedContentPrefs.length) {
                    enhancedContentPrefs = userPrefs;
                }
                hasSurveyData = true;
                surveyContext = buildSurveyContext(survey);
            }

            sendJSON(ws, {
                type: 'start',
                mode: generateMode,
                hasSurveyData,
                effectivePrompt,
            });

            // Load the child's personalization context ONCE per request and
            // pass it into both the prompt builder and the scoring context —
            // previously each fetched it independently, so a single request
            // with a resolved childId issued two redundant DB round-trips for
            // the identical profile. This is request-scoped (a local const,
            // not module/shared state) — nothing here can leak between
            // requests or connections.
            const childProfile = await personalizationService.getChildPersonalizationContext(childId);
            // TEMP DIAGNOSTIC — confirms generation actually starts.
            console.log('[DIAG] WS beginning tip generation', {
                generateMode,
                childId,
                hasChildProfile: !!childProfile,
                hasOldUserSurveyData: hasSurveyData,
            });

            // --- stream AI tips first ---
            let emitted = 0;
            if (generateMode === 'generate' || generateMode === 'hybrid') {
                const scoringContextPromise =
                    personalizationService.buildGeneratedTipScoringContext(
                        userId,
                        effectivePrompt,
                        childId,
                        childProfile,
                    );
                await personalizationService.generateTipsStreamNDJSON({
                    ws,
                    abortedRef: () => aborted,
                    userId,
                    query: surveyContext
                        ? `${effectivePrompt}\n\nUser Context: ${surveyContext}`
                        : effectivePrompt,
                    contentPreferences: enhancedContentPrefs,
                    childId,
                    childProfile,
                    onPhase: phase =>
                        sendJSON(ws, { type: 'phase', data: phase }),
                    onTip: async tip => {
                        if (emitted >= 3) return;
                        const scored =
                            await personalizationService.scoreSingleGeneratedTip(
                                {
                                    userId,
                                    query: effectivePrompt,
                                    tip,
                                    context: scoringContextPromise,
                                    strict: false,
                                    childId,
                                },
                            );
                        emitted += 1;
                        sendJSON(ws, {
                            type: 'tip',
                            source: 'ai',
                            data: scored || tip,
                        });
                    },
                });
            }

            // --- Retry with reduced personalization if the personalized
            // generation came up short (e.g. tips were dropped by the
            // output-validation gate). One bounded retry, same prompt, no
            // child profile — before falling all the way back to the DB. ---
            if (
                emitted < 3 &&
                childId &&
                (generateMode === 'generate' || generateMode === 'hybrid')
            ) {
                const retryScoringContextPromise =
                    personalizationService.buildGeneratedTipScoringContext(
                        userId,
                        effectivePrompt,
                        null, // reduced personalization: no child profile
                        null,
                    );
                await personalizationService.generateTipsStreamNDJSON({
                    ws,
                    abortedRef: () => aborted,
                    userId,
                    query: surveyContext
                        ? `${effectivePrompt}\n\nUser Context: ${surveyContext}`
                        : effectivePrompt,
                    contentPreferences: enhancedContentPrefs,
                    childId: null,
                    childProfile: null,
                    onPhase: phase =>
                        sendJSON(ws, { type: 'phase', data: phase }),
                    onTip: async tip => {
                        if (emitted >= 3) return;
                        const scored =
                            await personalizationService.scoreSingleGeneratedTip(
                                {
                                    userId,
                                    query: effectivePrompt,
                                    tip,
                                    context: retryScoringContextPromise,
                                    strict: false,
                                    childId: null,
                                },
                            );
                        emitted += 1;
                        sendJSON(ws, {
                            type: 'tip',
                            source: 'ai',
                            data: scored || tip,
                        });
                    },
                });
            }

            // --- DB fallback/top-up if AI produced fewer than 3 tips ---
            if (
                emitted < 3 &&
                (generateMode === 'database' || generateMode === 'hybrid')
            ) {
                const dbResult =
                    await personalizationService.getContextualPersonalizedTips(
                        userId,
                        effectivePrompt,
                        3 - emitted,
                        enhancedContentPrefs,
                        childId,
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
            // TEMP DIAGNOSTIC
            console.log(`[DIAG] WS closing: reason=done emittedTips=${emitted}`);
            ws.close();
        } catch (err) {
            console.error('WS error:', err);
            sendJSON(ws, {
                type: 'error',
                message: err?.message || 'Internal error',
            });
            // TEMP DIAGNOSTIC
            console.log(`[DIAG] WS closing: reason=caught-error message=${err?.message}`);
            ws.close();
        }
    });
});

app.get('/', async (req, res) => {
    return res.send('Active');
});
app.use('/endpoint', location);
app.use('/endpoint', geofenceRouter);
const port = process.env.PORT || 1337;
server.listen(port, err => {
    if (err) console.log(err);
    else console.log(err || 'Listening on port ' + port);
});
