// Shared normalization for resolving a client-submitted activity name to the exact
// canonical label in the current approved-activities list (SUPPORTED_ACTIVITIES plus
// any admin-approved custom activities from getApprovedActivities()).
//
// Without this, minor spelling/spacing variants of the same activity — "bedtime" vs
// "Bed time", "Bath-Time" vs "Bath time" — would be treated as different values,
// causing valid activities to be rejected or stored inconsistently. We never invent
// new canonical labels here: unresolvable input is reported as unresolved so callers
// can reject it (activities are only ever persisted or sent to the AI in their
// canonical form).

function compact(value) {
    return String(value ?? '')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ');
}

// Alias key used only for matching: ignores spaces and hyphens entirely so
// "bed time", "bed-time", and "bedtime" all collapse to the same key.
function aliasKey(value) {
    return compact(value).replace(/[\s-]+/g, '');
}

/**
 * Resolve a single activity name to its canonical approved label.
 * Returns the canonical label string, or null if it doesn't match any approved activity.
 */
export function resolveActivity(input, approvedActivities) {
    if (typeof input !== 'string') return null;
    const normalized = compact(input);
    if (!normalized) return null;
    const key = aliasKey(normalized);
    return approvedActivities.find(a => aliasKey(a) === key) ?? null;
}

/**
 * Resolve a list of client-submitted activity names against the approved list.
 * - Non-string entries and unresolvable strings are reported in `unresolved`.
 * - Resolved entries are de-duplicated (post-normalization) and returned in `resolved`,
 *   in their exact canonical form.
 */
export function resolveActivities(inputs, approvedActivities) {
    const resolved = [];
    const unresolved = [];
    const seen = new Set();

    for (const raw of inputs) {
        const match = resolveActivity(raw, approvedActivities);
        if (!match) {
            unresolved.push(raw);
            continue;
        }
        const key = aliasKey(match);
        if (!seen.has(key)) {
            seen.add(key);
            resolved.push(match);
        }
    }

    return { resolved, unresolved };
}
