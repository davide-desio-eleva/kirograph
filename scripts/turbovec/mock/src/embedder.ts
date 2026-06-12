export interface EmbeddingResult {
  id: string;
  vector: Float32Array;
  model: string;
}

export class Embedder {
  private model: string;
  private dim: number;

  constructor(model: string, dim = 768) {
    this.model = model;
    this.dim = dim;
  }

  async embed(text: string): Promise<Float32Array> {
    // Placeholder — replace with real model inference
    return new Float32Array(this.dim);
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return Promise.all(texts.map(async (t, i) => ({
      id: String(i),
      vector: await this.embed(t),
      model: this.model,
    })));
  }

  getDim(): number { return this.dim; }
  getModel(): string { return this.model; }
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] ** 2;
    nb += b[i] ** 2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
