// R2 giả trong bộ nhớ, chỉ dùng trong test.
export interface StoredObject {
  bytes: Uint8Array
  contentType?: string
}

export function createTestBucket() {
  const objects = new Map<string, StoredObject>()
  const bucket = {
    async put(key: string, value: ArrayBuffer | Uint8Array | string, opts?: { httpMetadata?: { contentType?: string } }) {
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value as ArrayBuffer)
      objects.set(key, { bytes: new Uint8Array(bytes), contentType: opts?.httpMetadata?.contentType })
      return { key }
    },
    async get(key: string) {
      const o = objects.get(key)
      return o ? { key, body: new Blob([o.bytes]).stream(), arrayBuffer: async () => o.bytes.buffer, size: o.bytes.byteLength } : null
    },
    async delete(key: string | string[]) {
      for (const k of Array.isArray(key) ? key : [key]) objects.delete(k)
    },
    async head(key: string) {
      return objects.has(key) ? { key, size: objects.get(key)!.bytes.byteLength } : null
    },
  }
  return { bucket: bucket as unknown as R2Bucket, objects }
}
