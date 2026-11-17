import { describe, expect, it } from "vite-plus/test";

import {
  TAILNET_ADDRESS_PLACEHOLDER,
  endpointPort,
  tailscalePolicySnippet,
} from "./sandboxTailscalePolicy";

describe("endpointPort", () => {
  it("reads the endpoint's port, or its scheme's default", () => {
    expect(endpointPort("https://hub.example.ts.net")).toBe(443);
    expect(endpointPort("http://100.92.23.53")).toBe(80);
    expect(endpointPort("http://100.92.23.53:8317/v1")).toBe(8317);
    expect(endpointPort(undefined)).toBe(443);
    expect(endpointPort("not a url")).toBe(443);
  });
});

describe("tailscalePolicySnippet", () => {
  it("owns the tag by admins and lets it reach only the endpoint", () => {
    const snippet = tailscalePolicySnippet({
      tag: "tag:t3-sandbox",
      address: "100.92.23.53",
      port: 443,
    });
    expect(snippet).toContain(`"tag:t3-sandbox": ["autogroup:admin"]`);
    expect(snippet).toContain(
      `{ "src": ["tag:t3-sandbox"], "dst": ["100.92.23.53"], "ip": ["tcp:443"] }`,
    );
    // The narrower grant that replaces allow-all stays a comment: pasting must not widen access.
    expect(snippet).toContain(`// { "src": ["autogroup:member"], "dst": ["*"], "ip": ["*"] },`);
  });

  it("uses a placeholder address when the endpoint has no tailnet address", () => {
    const snippet = tailscalePolicySnippet({ tag: "tag:ci", address: null, port: 8317 });
    expect(snippet).toContain(
      `{ "src": ["tag:ci"], "dst": ["${TAILNET_ADDRESS_PLACEHOLDER}"], "ip": ["tcp:8317"] }`,
    );
  });
});
