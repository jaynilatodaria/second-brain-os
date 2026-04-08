const { FlagEmbedding, EmbeddingModel } = require("fastembed");
const { QdrantClient } = require("@qdrant/js-client-rest");

const QDRANT_URL  = process.env.QDRANT_URL || "http://localhost:6333";
const VECTOR_SIZE = 384; // BGE-small-en-v1.5
const COLLECTIONS = ["tasks", "projects", "people", "journal"];

const client = new QdrantClient({ url: QDRANT_URL });

// --- Embedding (local, no API) ---

let _model = null;

async function getModel() {
  if (!_model) {
    console.log("[qdrant] Loading embedding model (first run may download ~50MB)...");
    _model = await FlagEmbedding.init({ model: EmbeddingModel.BGESmallENV15 });
    console.log("[qdrant] Embedding model ready.");
  }
  return _model;
}

async function embed(text) {
  const model = await getModel();
  const input = text?.trim() || " ";
  for await (const batch of model.embed([input])) {
    return Array.from(batch[0]);
  }
}

// --- Collection setup ---

async function resetCollections() {
  for (const name of COLLECTIONS) {
    try {
      await client.deleteCollection(name);
      console.log(`[qdrant] Deleted collection: ${name}`);
    } catch (err) {
      console.warn(`[qdrant] Could not delete ${name}: ${err.message}`);
    }
  }
  await ensureCollections();
  console.log("[qdrant] All collections reset.");
}

async function ensureCollections() {
  try {
    const { collections } = await client.getCollections();
    const existing = new Set(collections.map((c) => c.name));

    for (const name of COLLECTIONS) {
      if (!existing.has(name)) {
        await client.createCollection(name, {
          vectors: { size: VECTOR_SIZE, distance: "Cosine" },
        });
        console.log(`[qdrant] Created collection: ${name}`);
      } else {
        // Check if existing collection has the right vector size; recreate if not
        const info = await client.getCollection(name);
        const existingSize = info.config?.params?.vectors?.size;
        if (existingSize && existingSize !== VECTOR_SIZE) {
          console.log(`[qdrant] Collection ${name} has dim ${existingSize}, expected ${VECTOR_SIZE} — recreating`);
          await client.deleteCollection(name);
          await client.createCollection(name, {
            vectors: { size: VECTOR_SIZE, distance: "Cosine" },
          });
          console.log(`[qdrant] Recreated collection: ${name}`);
        }
      }
    }
  } catch (err) {
    console.warn(`[qdrant] ensureCollections failed — Qdrant may be unreachable: ${err.message}`);
  }
}

// --- Upsert ---

async function upsertVector(collection, id, text, payload) {
  try {
    const vector = await embed(text);

    const now = new Date().toISOString();
    const fullPayload = {
      source:           payload.source           ?? collection,
      raw_user_message: payload.raw_user_message ?? "",
      created_at:       payload.created_at       ?? now,
      updated_at:       payload.updated_at       ?? now,
      updated_by:       payload.updated_by       ?? "system",
      ...payload,
    };

    await client.upsert(collection, {
      wait: true,
      points: [{ id, vector, payload: fullPayload }],
    });

    return true;
  } catch (err) {
    console.warn(`[qdrant] upsertVector failed (${collection}/${id}): ${err.message}`);
    return null;
  }
}

// --- Search ---

async function searchVectors(collection, queryText, limit = 5) {
  try {
    const vector = await embed(queryText);

    const results = await client.search(collection, {
      vector,
      limit,
      with_payload: true,
    });

    return results.map((r) => r.payload);
  } catch (err) {
    console.warn(`[qdrant] searchVectors failed (${collection}): ${err.message}`);
    return null;
  }
}

async function healthCheck() {
  try {
    await client.getCollections();
    return true;
  } catch {
    return false;
  }
}

module.exports = { ensureCollections, resetCollections, upsertVector, searchVectors, healthCheck };
