/** Matches the server's read cap: a larger file would arrive truncated. */
export const COPYABLE_FILE_MAX_BYTES = 1024 * 1024;

const DEFAULT_COPIED_FILE_NAME = /^(?:\.env(?:\..+)?|\.envrc|\.dev\.vars)$/;

/** Env files are the ignored files people almost always want on a new machine. */
export function isDefaultCopiedFile(path: string): boolean {
  const name = path.split("/").at(-1) ?? path;
  return DEFAULT_COPIED_FILE_NAME.test(name);
}
