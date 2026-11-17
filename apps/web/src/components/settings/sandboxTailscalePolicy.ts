/** Stands in for the endpoint's address when this server can't resolve it to a tailnet one. */
export const TAILNET_ADDRESS_PLACEHOLDER = "100.x.y.z";

/** The port a sandbox connects to: the endpoint's own, or its scheme's default. */
export function endpointPort(baseUrl: string | undefined): number {
  const url = baseUrl === undefined ? null : URL.parse(baseUrl);
  if (url === null) return 443;
  if (url.port !== "") return Number(url.port);
  return url.protocol === "http:" ? 80 : 443;
}

/**
 * The policy file entries sandboxes need: admins own the tag, and the tag reaches only the Claude
 * endpoint. The narrower replacement for Tailscale's default allow-all grant stays commented out,
 * so pasting the snippet never widens access by itself.
 */
export function tailscalePolicySnippet(input: {
  readonly tag: string;
  readonly address: string | null;
  readonly port: number;
}): string {
  const address = input.address ?? TAILNET_ADDRESS_PLACEHOLDER;
  return [
    `"tagOwners": {`,
    `  "${input.tag}": ["autogroup:admin"],`,
    `},`,
    `"grants": [`,
    `  // Sandboxes reach the Claude endpoint and nothing else.`,
    `  { "src": ["${input.tag}"], "dst": ["${address}"], "ip": ["tcp:${input.port}"] },`,
    `  // Replace the default allow-all grant ("src": ["*"]) with this one:`,
    `  // { "src": ["autogroup:member"], "dst": ["*"], "ip": ["*"] },`,
    `],`,
  ].join("\n");
}
