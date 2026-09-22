export const REDACT_REGEX_CHUNK_THRESHOLD = 32_768;
export const REDACT_REGEX_CHUNK_SIZE = 16_384;

type BoundedRedactOptions = {
  chunkThreshold?: number;
  chunkSize?: number;
};

export function replacePatternBounded(
  text: string,
  pattern: RegExp,
  replacer: Parameters<string["replace"]>[1],
  options?: BoundedRedactOptions,
): string {
  const chunkThreshold = options?.chunkThreshold ?? REDACT_REGEX_CHUNK_THRESHOLD;
  const chunkSize = options?.chunkSize ?? REDACT_REGEX_CHUNK_SIZE;
  if (chunkThreshold <= 0 || chunkSize <= 0 || text.length <= chunkThreshold) {
    return text.replace(pattern, replacer);
  }

  let parts: string[] | undefined;
  for (let index = 0; index < text.length; index += chunkSize) {
    const chunk = text.slice(index, index + chunkSize);
    const replaced = chunk.replace(pattern, replacer);
    if (!parts && replaced !== chunk) {
      parts = [text.slice(0, index)];
    }
    // Most log chunks contain no secrets. Avoid rebuilding the full input for every pattern.
    parts?.push(replaced);
  }
  return parts ? parts.join("") : text;
}
