/**
 * Optional local embeddings for memory search (Settings → Memory → Embeddings). Talks to a local Ollama server only;
 * memory search falls back to keyword + fuzzy matching whenever it is off, slow or unreachable.
 */
export interface Embedder {
  readonly model: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export function ollamaEmbedder(url: string, model: string, fetchFn: typeof fetch = fetch, timeoutMs = 15_000): Embedder {
  const base = url.replace(/\/+$/, "");
  return {
    model: `ollama:${model}`,
    async embed(texts) {
      if (!texts.length) return [];
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const r = await fetchFn(`${base}/api/embed`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, input: texts }), signal: ctl.signal });
        if (!r.ok) throw new Error(`Ollama answered ${r.status}${r.status === 404 ? `: pull the model first (ollama pull ${model})` : ""}`);
        const j = (await r.json()) as { embeddings?: number[][] };
        if (!Array.isArray(j.embeddings) || j.embeddings.length !== texts.length) throw new Error("Ollama returned no embeddings");
        return j.embeddings.map((v) => Float32Array.from(v));
      } finally {
        clearTimeout(t);
      }
    },
  };
}

export function denseCosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export const toBlob = (v: Float32Array): Uint8Array => new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
export const fromBlob = (b: Uint8Array): Float32Array => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
