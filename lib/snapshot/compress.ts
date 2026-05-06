import { promisify } from "node:util";
import { brotliCompress, brotliDecompress, constants } from "node:zlib";

const compress = promisify(brotliCompress);
const decompress = promisify(brotliDecompress);

// Quality 6 is a deliberate tradeoff: q=11 is ~5% smaller but ~10x slower,
// and the cron runs hourly — we'd rather not spend 30s of compute compressing
// a 24-month snapshot. The output is read once and cached for an hour.
const QUALITY = 6;

export async function compressJson(payload: unknown): Promise<Buffer> {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  return compress(json, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: QUALITY,
      [constants.BROTLI_PARAM_SIZE_HINT]: json.length,
    },
  });
}

export async function decompressJson<T>(buf: Buffer | Uint8Array): Promise<T> {
  const raw = await decompress(buf);
  return JSON.parse(raw.toString("utf8")) as T;
}
