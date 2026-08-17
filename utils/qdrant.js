import { QdrantClient } from '@qdrant/js-client-rest';

export const qdrant = new QdrantClient({
    url: process.env.QDRANT_URI, // e.g. http://localhost:6333 or a cloud URL
    apiKey: process.env.QDRANT_API_KEY, // optional if local/no auth
});

export const TIPS_COLLECTION = 'tips_idx';

export async function ensureTipsCollection(dim) {
    try {
        const exists = await qdrant
            .getCollection(TIPS_COLLECTION)
            .catch(() => null);
        
        if (!exists) {
            console.log('Creating Qdrant collection...');
            // Updated format for newer Qdrant API
            await qdrant.createCollection(TIPS_COLLECTION, {
                vectors: {
                    size: dim,
                    distance: 'Cosine'  // Capital C is important!
                }
            });
            
            // Create indexes
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
            console.log('✅ Qdrant collection created');
        }
    } catch (error) {
        console.error('Qdrant error:', error);
        throw error;
    }
}