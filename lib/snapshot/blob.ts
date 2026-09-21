import { put, get } from "@vercel/blob";

export const COVERAGE_BLOB_KEY = "coverage-latest.json.br";

export type BlobPutResult = {
  url: string;
  uploadedAt: string;
  bytes: number;
};

export async function putCoverageBlob(body: Buffer): Promise<BlobPutResult> {
  const result = await put(COVERAGE_BLOB_KEY, body, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 3600,
  });
  return {
    url: result.url,
    uploadedAt: new Date().toISOString(),
    bytes: body.length,
  };
}

export type CoverageBlobRead = {
  /**
   * The stored bytes, still brotli-compressed. Typed as Uint8Array<ArrayBuffer>
   * rather than Buffer so it satisfies BodyInit — Buffer is
   * Uint8Array<ArrayBufferLike>, which the Response constructor rejects.
   */
  body: Uint8Array<ArrayBuffer>;
  etag: string;
  uploadedAt: string;
};

// Server-side read. Private blobs require the BLOB_READ_WRITE_TOKEN which the
// SDK picks up from env automatically. Returns null if the blob doesn't exist
// yet (before the first cron run).
//
// Surfaces the blob's own metadata so /api/coverage can set an ETag without
// decompressing and parsing the payload to reach `generated_at`.
export async function readCoverageBlobWithMeta(): Promise<CoverageBlobRead | null> {
  const result = await get(COVERAGE_BLOB_KEY, { access: "private" });
  if (!result || result.stream === null) return null;
  const ab = await new Response(result.stream).arrayBuffer();
  return {
    body: new Uint8Array(ab),
    etag: result.blob.etag,
    uploadedAt: result.blob.uploadedAt.toISOString(),
  };
}

// Kept for callers that only want the bytes (the ship-metadata admin routes).
// Buffer.from(buffer, offset, length) is a view, not a copy.
export async function readCoverageBlob(): Promise<Buffer | null> {
  const result = await readCoverageBlobWithMeta();
  if (!result) return null;
  return Buffer.from(result.body.buffer, result.body.byteOffset, result.body.byteLength);
}
