import { z } from "zod";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type BookmarkMetadata = Record<string, JsonValue>;
export const MAX_METADATA_BYTES = 64 * 1024;
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);

export function isMetadataObject(value: unknown): value is BookmarkMetadata {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

/** Bounded JSON validation before any recursive processing or serialization. */
export const zBookmarkMetadataSchema = z.preprocess(
  (value, ctx) => {
    const stack = [{ value: value as unknown, depth: 0 }];
    let nodes = 0;
    while (stack.length) {
      const entry = stack.pop()!;
      if (entry.depth > 16 || ++nodes > MAX_METADATA_BYTES) {
        ctx.addIssue({
          code: "custom",
          message: "Metadata exceeds the maximum nesting depth (16) or size",
        });
        return z.NEVER;
      }
      const v = entry.value;
      if (
        v === null ||
        typeof v === "string" ||
        typeof v === "boolean" ||
        (typeof v === "number" && Number.isFinite(v))
      )
        continue;
      if (Array.isArray(v)) {
        for (const child of v)
          stack.push({ value: child, depth: entry.depth + 1 });
      } else if (isMetadataObject(v)) {
        for (const [key, child] of Object.entries(v)) {
          if (forbiddenKeys.has(key)) {
            ctx.addIssue({
              code: "custom",
              message: "Metadata contains a reserved object key",
            });
            return z.NEVER;
          }
          stack.push({ value: child, depth: entry.depth + 1 });
        }
      } else {
        ctx.addIssue({
          code: "custom",
          message: "Metadata must contain only JSON values",
        });
        return z.NEVER;
      }
    }
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength >
      MAX_METADATA_BYTES
    ) {
      ctx.addIssue({ code: "custom", message: "Metadata exceeds 64 KiB" });
      return z.NEVER;
    }
    return value;
  },
  z.record(z.string(), z.unknown()),
) as z.ZodType<BookmarkMetadata, BookmarkMetadata>;

/** JSON Merge Patch: objects merge, arrays replace, null deletes; root null clears. */
export function mergeBookmarkMetadata(
  current: BookmarkMetadata | undefined,
  patch: BookmarkMetadata | null,
): BookmarkMetadata {
  if (patch === null) return {};
  // Validate inputs here too: this helper is also used outside HTTP validation.
  zBookmarkMetadataSchema.parse(patch);
  const merge = (
    old: BookmarkMetadata,
    changes: BookmarkMetadata,
  ): BookmarkMetadata => {
    const result = { ...old };
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) delete result[key];
      else if (isMetadataObject(value))
        result[key] = merge(
          isMetadataObject(result[key]) ? result[key] : {},
          value,
        );
      else result[key] = structuredClone(value);
    }
    return result;
  };
  return zBookmarkMetadataSchema.parse(merge(current ?? {}, patch));
}

/** Only descriptive fields enter retrieval; arbitrary metadata remains preserved. */
export function bookmarkMetadataSearchText(
  metadata: BookmarkMetadata | undefined,
): string {
  const paths = [
    ["pageTitle"],
    ["title"],
    ["description"],
    ["author"],
    ["capture", "pageTitle"],
    ["source", "title"],
    ["source", "description"],
    ["source", "author"],
    ["company", "name"],
    ["company", "description"],
    ["search", "text"],
    ["search", "keywords"],
  ];
  const parts = new Set<string>();
  for (const path of paths) {
    let value: JsonValue | undefined = metadata;
    for (const key of path)
      value = isMetadataObject(value) ? value[key] : undefined;
    for (const text of Array.isArray(value) ? value : [value]) {
      if (typeof text === "string" && text.trim()) parts.add(text.trim());
    }
  }
  return [...parts].join("\n");
}
