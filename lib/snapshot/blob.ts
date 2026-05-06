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

// Server-side read. Private blobs require the BLOB_READ_WRITE_TOKEN which the
// SDK picks up from env automatically. Returns null if the blob doesn't exist
// yet (before the first cron run).
export async function readCoverageBlob(): Promise<Buffer | null> {
  const result = await get(COVERAGE_BLOB_KEY, { access: "private" });
  if (!result) return null;
  const ab = await new Response(result.stream).arrayBuffer();
  return Buffer.from(ab);
}
