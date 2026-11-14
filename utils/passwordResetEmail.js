// Pure helpers for requestPasswordReset's email-submission handling
// (routes/auth.js). Kept dependency-free (no DB pool, no SMTP transport) so
// they can be unit tested without a live database or network connection.

export const wasRecipientAccepted = (info, email) =>
    Array.isArray(info?.accepted) && info.accepted.includes(email);

export const buildPasswordResetEmailLog = (correlationId, info, durationMs) => ({
    correlationId,
    messageId: info?.messageId,
    accepted: Array.isArray(info?.accepted) ? info.accepted.length : 0,
    rejected: Array.isArray(info?.rejected) ? info.rejected.length : 0,
    durationMs,
});
