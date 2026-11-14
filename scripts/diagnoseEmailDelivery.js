// Manual-only diagnostic: sends three test emails through the exact same
// Nodemailer/Gmail SMTP configuration used by routes/auth.js's
// requestPasswordReset, to isolate SMTP-submission problems from
// message-content/recipient-side filtering problems.
//
// This script is NEVER invoked automatically — it is not wired into
// index.js, any route, or any npm script. It only runs when a human
// executes it directly and passes a recipient explicitly. It does not touch
// the database, does not generate or store a real reset_token, and sends
// exactly three messages once (no retry/poll loop).
//
// Usage (run manually, from the backend project root):
//   node scripts/diagnoseEmailDelivery.js --to=<recipient-email>
//
// Sends, in order, a few seconds apart:
//   A. Plain-text-only test email
//   B. HTML + plain-text alternative test email
//   C. The real password-reset HTML/text template, with a dummy code that
//      is clearly marked as non-functional and is never written to the DB
//
// For each send, prints (to stdout only — nothing is written to the app's
// PM2 logs by this script): messageId, accepted/rejected recipient counts,
// and duration. The raw SMTP response string, credentials, and message
// bodies are never printed.

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

const DELAY_BETWEEN_SENDS_MS = 3000;
const DUMMY_RESET_CODE = 'DIAGNOSTIC-DO-NOT-USE-000000';

const toArg = process.argv.find(arg => arg.startsWith('--to='));
const recipient = toArg?.split('=')[1];

if (!recipient) {
    console.error(
        'Usage: node scripts/diagnoseEmailDelivery.js --to=<recipient-email>',
    );
    process.exit(1);
}

if (!process.env.EMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.error(
        'EMAIL_USER and GMAIL_APP_PASSWORD must be set in the environment (.env) to run this diagnostic.',
    );
    process.exit(1);
}

const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
    },
});

const realTemplateHtml = `
      <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #4A90E2; text-align: center;">Password Reset Request</h1>
        <p style="color: #666; font-size: 16px;">You requested a password reset for your ENACT account.</p>
        <div style="text-align: center; margin: 30px 0;">
          <p style="color: #666; font-size: 16px;">Copy and paste this code in the app to reset your password:</p>
          <p style="color: #4A90E2; font-size: 22px; font-family: monospace; background: #f5f5f5; padding: 14px 20px; border-radius: 5px; display: inline-block; letter-spacing: 1px;">${DUMMY_RESET_CODE}</p>
        </div>
        <p style="color: #666; font-size: 14px;">This code will expire in 1 hour.</p>
        <p style="color: #999; font-size: 14px;">If you didn't request this, please ignore this email.</p>
        <p style="color: #999; font-size: 12px;">For security, this code will only work once.</p>
        <p style="color: #c00; font-size: 12px;">[DIAGNOSTIC MESSAGE — this code is fake and cannot reset any account]</p>
      </div>
    `;

const realTemplateText = `You requested a password reset for your ENACT account.

Copy and paste this code in the app to reset your password:

${DUMMY_RESET_CODE}

This code will expire in 1 hour.
If you didn't request this, please ignore this email.
For security, this code will only work once.

[DIAGNOSTIC MESSAGE -- this code is fake and cannot reset any account]`;

const messages = [
    {
        label: 'A: plain-text only',
        mail: {
            from: `"ENACT" <${process.env.EMAIL_USER}>`,
            to: recipient,
            subject: 'ENACT Diagnostic Test A (plain text)',
            text: 'This is a plain-text-only diagnostic email from ENACT. No action is needed.',
        },
    },
    {
        label: 'B: html + text alternative',
        mail: {
            from: `"ENACT" <${process.env.EMAIL_USER}>`,
            to: recipient,
            subject: 'ENACT Diagnostic Test B (html + text)',
            text: 'This is an HTML+text diagnostic email from ENACT. No action is needed.',
            html: '<p>This is an <strong>HTML+text</strong> diagnostic email from ENACT. No action is needed.</p>',
        },
    },
    {
        label: 'C: real reset template, dummy code',
        mail: {
            from: `"ENACT" <${process.env.EMAIL_USER}>`,
            to: recipient,
            subject: 'Password Reset Request',
            text: realTemplateText,
            html: realTemplateHtml,
        },
    },
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const run = async () => {
    console.log(`Diagnostic run targeting ${recipient}`);
    console.log(`Sending ${messages.length} messages, ${DELAY_BETWEEN_SENDS_MS}ms apart. No retries.\n`);

    for (const [index, { label, mail }] of messages.entries()) {
        const start = Date.now();
        try {
            const info = await transporter.sendMail(mail);
            const durationMs = Date.now() - start;
            console.log(`[${label}]`, {
                messageId: info.messageId,
                accepted: Array.isArray(info.accepted) ? info.accepted.length : 0,
                rejected: Array.isArray(info.rejected) ? info.rejected.length : 0,
                durationMs,
            });
        } catch (error) {
            const durationMs = Date.now() - start;
            console.error(`[${label}] FAILED`, {
                code: error.code,
                responseCode: error.responseCode,
                durationMs,
            });
        }

        if (index !== messages.length - 1) {
            await sleep(DELAY_BETWEEN_SENDS_MS);
        }
    }

    console.log('\nDone. Check the recipient inbox/spam/all-mail for each of the three subjects above.');
};

run();
