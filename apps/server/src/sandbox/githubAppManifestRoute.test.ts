import { SANDBOX_GITHUB_APP_PASTE_REDIRECT_URL } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { describe, expect, it } from "vite-plus/test";

import { layerGithubAppManifestRoute } from "./githubAppManifestRoute.ts";

const STATE = "0f8fad5b-d9cb-469f-a165-70867728950e";

const serve = async (path: string) => {
  // The app's own static fallback, so the test shows the page route wins over it.
  const layerFallback = HttpRouter.add("GET", "*", HttpServerResponse.text("app"));
  const { handler, dispose } = HttpRouter.toWebHandler(
    Layer.mergeAll(layerGithubAppManifestRoute, layerFallback),
    { disableLogger: true },
  );
  try {
    const response = await handler(new Request(`http://127.0.0.1:3773${path}`));
    return { response, body: await response.text() };
  } finally {
    await dispose();
  }
};

describe("GitHub App manifest page", () => {
  it("posts the manifest to GitHub with the client's state, under a strict policy", async () => {
    const { response, body } = await serve(`/api/sandbox/github-app/new?state=${STATE}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const policy = response.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("form-action https://github.com");
    // The browser runs the submit script only when its hash is the one the policy allows.
    const script = /<script>([^<]*)<\/script>/u.exec(body)?.[1] ?? "";
    const hash = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script)),
    ).toString("base64");
    expect(policy).toContain(`script-src 'sha256-${hash}'`);

    const unescape = (text: string) =>
      text
        .replaceAll("&quot;", '"')
        .replaceAll("&#39;", "'")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&");
    expect(body).toContain(
      `<form id="manifest" method="post" action="https://github.com/settings/apps/new?state=${STATE}">`,
    );
    const manifest = JSON.parse(unescape(/name="manifest" value="([^"]*)"/u.exec(body)?.[1] ?? ""));
    expect(manifest).toMatchObject({
      name: "T3 Code sandboxes",
      public: false,
      redirect_url: SANDBOX_GITHUB_APP_PASTE_REDIRECT_URL,
      default_permissions: { contents: "write", pull_requests: "write", metadata: "read" },
    });
    expect(body).toContain('<button type="submit">Continue to GitHub</button>');
  });

  it.each([
    ["no state", "/api/sandbox/github-app/new"],
    ["a state that is not a UUID", `/api/sandbox/github-app/new?state=${STATE}"><script>`],
    ["an uppercase UUID", `/api/sandbox/github-app/new?state=${STATE.toUpperCase()}`],
  ])("refuses %s", async (_case, path) => {
    const { response, body } = await serve(path);
    expect(response.status).toBe(400);
    expect(body).not.toContain("<script>");
  });
});
