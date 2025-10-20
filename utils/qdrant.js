import { QdrantClient } from '@qdrant/js-client-rest';

export const qdrant = new QdrantClient({
    url: process.env.QDRANT_URI, // e.g. http://localhost:6333 or a cloud URL
    apiKey: process.env.QDRANT_API_KEY, // optional if local/no auth
});

export const TIPS_COLLECTION = 'tips_idx';

export async function ensureTipsCollection(dim) {
    const exists = await qdrant
        .getCollection(TIPS_COLLECTION)
        .catch(() => null);
    if (!exists) {
        await qdrant.createCollection(TIPS_COLLECTION, {
            vectors: { size: dim, distance: 'cosine' },
            optimizers_config: { default_segment_number: 2 },
        });
        await qdrant.createPayloadIndex(TIPS_COLLECTION, {
            field_name: 'type',
            field_schema: 'keyword',
        });
        await qdrant.createPayloadIndex(TIPS_COLLECTION, {
            field_name: 'tip_id',
            field_schema: 'keyword',
        });
        await qdrant.createPayloadIndex(TIPS_COLLECTION, {
            field_name: 'title',
            field_schema: 'text',
        });
        await qdrant.createPayloadIndex(TIPS_COLLECTION, {
            field_name: 'description',
            field_schema: 'text',
        });
    }
}
