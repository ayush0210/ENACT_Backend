// Safely reads the `locations.activities` JSON column regardless of how the driver
// hands it back (mysql2 normally parses JSON columns into a JS array, but older rows,
// driver config differences, or a manually-edited row could surface it as a raw JSON
// string or malformed data). Never throws — a bad value degrades to [] so a single
// corrupt row can't take down a locations/notification endpoint.
export function parseStoredActivities(value) {
    if (value == null) return [];

    if (Array.isArray(value)) {
        return value.filter(v => typeof v === 'string');
    }

    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed)
                ? parsed.filter(v => typeof v === 'string')
                : [];
        } catch (err) {
            console.error(
                'Invalid JSON in locations.activities, falling back to []:',
                err.message,
            );
            return [];
        }
    }

    console.error(
        'Unexpected type for locations.activities, falling back to []:',
        typeof value,
    );
    return [];
}
