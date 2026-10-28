/** Stateful SDK test double: records operations and simulates Cosine normalization. */
export function fakeQdrant({ dimensions = 3, exists = true, distance = "Cosine" } = {}) {
  const points = new Map();
  const calls = [];
  const info = { config: { params: { vectors: { size: dimensions, distance } } }, payload_schema: {} };
  const record = (method, args) => calls.push({ method, args: structuredClone(args) });
  const matches = (point, filter = {}) => {
    const match = (condition) => condition.match.any
      ? condition.match.any.includes(point.payload[condition.key])
      : point.payload[condition.key] === condition.match.value;
    return (filter.must ?? []).every(match) && !(filter.must_not ?? []).some(match);
  };
  const client = {
    async getCollection(...args) {
      record("getCollection", args);
      if (!exists) throw Object.assign(new Error("Missing"), { status: 404 });
      return structuredClone(info);
    },
    async createCollection(...args) {
      record("createCollection", args);
      exists = true;
      info.config.params.vectors = args[1].vectors;
      return true;
    },
    async createPayloadIndex(...args) {
      record("createPayloadIndex", args);
      info.payload_schema[args[1].field_name] = { data_type: args[1].field_schema, points: 0 };
      return { status: "completed" };
    },
    async upsert(...args) {
      record("upsert", args);
      for (const point of args[1].points) {
        const norm = Math.hypot(...point.vector);
        points.set(point.id, {
          ...structuredClone(point),
          vector: point.vector.map((value) => norm ? Math.fround(value / norm) : 0),
        });
      }
      return { status: "completed" };
    },
    async retrieve(...args) {
      record("retrieve", args);
      return args[1].ids.filter((id) => points.has(id)).map((id) => structuredClone(points.get(id)));
    },
    async delete(...args) {
      record("delete", args);
      for (const [id, point] of points) if (matches(point, args[1].filter)) points.delete(id);
      return { status: "completed" };
    },
    async count(...args) {
      record("count", args);
      return { count: [...points.values()].filter((point) => matches(point, args[1].filter)).length };
    },
    async query(...args) {
      record("query", args);
      if (!exists) throw Object.assign(new Error("Missing"), { status: 404 });
      const request = args[1];
      const norm = Math.hypot(...request.query);
      const hits = [...points.values()].filter((point) => matches(point, request.filter))
        .map((point) => {
          const pointNorm = Math.hypot(...point.vector);
          const dot = point.vector.reduce((sum, value, index) => sum + value * request.query[index], 0);
          return { id: point.id, score: norm && pointNorm ? dot / norm / pointNorm : 0, payload: structuredClone(point.payload) };
        })
        .filter((point) => request.score_threshold === undefined || point.score >= request.score_threshold)
        .sort((left, right) => right.score - left.score).slice(0, request.limit);
      return { points: hits };
    },
  };
  return { client, points, calls, info, connection: { client, collection: "unit_documents", dimensions } };
}

export function embeddedChunk(index = 0, overrides = {}) {
  return {
    id: `00000000-0000-8000-8000-${String(index).padStart(12, "0")}`,
    documentId: "document-version-one", sourceName: "guide.txt", pageNumber: 1,
    chunkIndex: index, text: `Synthetic source chunk ${index}.`, embedding: [1, 0.5, 0.25],
    ...overrides,
  };
}
