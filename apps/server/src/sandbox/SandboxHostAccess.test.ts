import { describe, expect, it } from "vite-plus/test";

import { resolvesOnlyToPrivateNetwork, tailnetAddressOf } from "./SandboxHostAccess.ts";

describe("resolvesOnlyToPrivateNetwork", () => {
  it.each([
    [["127.0.0.1"], true],
    [["10.0.0.1"], true],
    [["172.16.4.2"], true],
    [["172.32.0.1"], false],
    [["192.168.1.10"], true],
    [["169.254.169.254"], true],
    // Tailscale addresses come from the shared CGNAT range.
    [["100.92.23.53"], true],
    [["100.128.0.1"], false],
    [["::1"], true],
    [["fd7a:115c:a1e0::1"], true],
    [["fe80::1"], true],
    [["::ffff:10.0.0.1"], true],
    [["2606:4700::6810:84e5"], false],
    [["104.16.132.229"], false],
    // One public address is enough for a sandbox to get through.
    [["100.92.23.53", "104.16.132.229"], false],
    // A failed lookup proves nothing.
    [[], false],
  ] as const)("%j -> %s", (addresses, expected) => {
    expect(resolvesOnlyToPrivateNetwork(addresses)).toBe(expected);
  });
});

describe("tailnetAddressOf", () => {
  it.each([
    [["100.92.23.53"], "100.92.23.53"],
    [["104.16.132.229", "100.92.23.53"], "100.92.23.53"],
    [["fd7a:115c:a1e0::1"], "fd7a:115c:a1e0::1"],
    // An IPv4 address is what a policy file's grant most often names.
    [["fd7a:115c:a1e0::1", "100.92.23.53"], "100.92.23.53"],
    [["100.128.0.1"], null],
    [["192.168.1.10"], null],
    [[], null],
  ] as const)("%j -> %s", (addresses, expected) => {
    expect(tailnetAddressOf(addresses)).toBe(expected);
  });
});
