const MAX_TIPS = 3;

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

const normalizeTip = tip => {
    const title = clean(tip.title || 'Parenting tip');
    const description = clean(tip.body || tip.description || '');
    const details = clean(tip.details || '');
    return {
        id: tip.id,
        title,
        body: description,
        description,
        details,
        activity: clean(tip.activity || tip.type || ''),
        reason: clean(tip.reason || tip.recommendationReason || ''),
        categories: Array.isArray(tip.categories) ? tip.categories : [],
        isGenerated: Boolean(tip.isGenerated),
    };
};

export function buildLocationNotificationPayload({ location, tips = [], notificationId }) {
    const normalizedTips = tips.slice(0, MAX_TIPS).map(normalizeTip);
    const locationName = clean(location?.name || 'your saved location');
    const locationType = clean(location?.type || 'Location');

    const title = `You've arrived at ${locationName}`;
    const tipLines = normalizedTips
        .map((tip, index) => {
            const text = tip.description || tip.details;
            return text ? `${index + 1}. ${tip.title}: ${text}` : `${index + 1}. ${tip.title}`;
        })
        .filter(Boolean);

    const body = tipLines.length
        ? `Tips for ${locationName}:\n${tipLines.join('\n')}`
        : `Tips for ${locationType} at ${locationName}`;

    return {
        title,
        body,
        notificationType: 'location_parenting_tips',
        locationId: location?.id != null ? String(location.id) : '',
        locationName,
        locationType,
        tips: normalizedTips,
        generatedTipMetadata: {
            count: normalizedTips.length,
            hasGeneratedTips: normalizedTips.some(tip => tip.isGenerated),
        },
        notificationId,
    };
}

// Shared by the legacy JS-polling path (routes/location.js) and the native geofence
// path (routes/geofence.js) so both produce identical tip-generation prompts for the
// same location. When `activities` is empty this returns exactly the prompt string
// both routes used before activities existed — no behavior change for locations
// without selected activities.
export function buildLocationTipPrompt({
    domainDesc,
    locationName,
    activities = [],
    childContext = '',
}) {
    const activitiesClause = activities.length
        ? ` The family especially wants ideas for these activities they do there: ${activities.join(', ')}.`
        : '';
    const base = `${domainDesc} activities at ${locationName}${activitiesClause}`;
    return childContext ? `${base} for children (${childContext})` : base;
}

export function notificationDataForPush(payload) {
    return {
        notificationType: payload.notificationType,
        notificationId: String(payload.notificationId || ''),
        locationType: payload.locationType,
        locationId: String(payload.locationId || ''),
        locationName: payload.locationName,
        tips: JSON.stringify(payload.tips || []),
        generatedTipMetadata: JSON.stringify(payload.generatedTipMetadata || {}),
    };
}
