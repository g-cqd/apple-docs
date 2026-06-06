import { VECTOR_DIMS } from '../../src/search/embedding.js'

// Deterministic "semantic" embedder for tests — no ONNX dependency.
// Maps a small set of topics (and their synonyms) to one-hot dimensions, so a
// query synonym is vector-close to a doc that mentions the topic even with no
// lexical word overlap.
export const TOPICS = ['audio', 'network', 'layout']
const SYNONYMS = { sound: 'audio', record: 'audio', request: 'network', stack: 'layout' }

export function topicEmbedder() {
  return {
    async embed(text) {
      const v = new Float32Array(VECTOR_DIMS).fill(-1)
      const t = String(text).toLowerCase()
      TOPICS.forEach((topic, i) => {
        const hit = t.includes(topic) || Object.entries(SYNONYMS).some(([w, top]) => top === topic && t.includes(w))
        if (hit) v[i] = 1
      })
      return v
    },
  }
}
