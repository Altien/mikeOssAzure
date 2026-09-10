export function chunkArray<T>(values: T[], size: number): T[][] {
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new RangeError("chunk size must be a positive integer");
  }
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}
