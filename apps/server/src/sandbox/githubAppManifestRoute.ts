// @effect-diagnostics-next-line nodeBuiltinImport:off -- the page script's hash is a constant, worked out once at load.
import * as NodeCrypto from "node:crypto";

import {
  SANDBOX_GITHUB_APP_HOMEPAGE,
  SANDBOX_GITHUB_APP_NEW_ROUTE,
  SANDBOX_GITHUB_APP_PASTE_REDIRECT_URL,
  sandboxGithubAppManifest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { requestUrl } from "../requestUrl.ts";

const GITHUB_NEW_APP = "https://github.com/settings/apps/new";
// Clients send a v4 UUID; nothing else reaches the page.
const STATE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SUBMIT_SCRIPT = 'document.getElementById("manifest").submit();';
const SUBMIT_SCRIPT_HASH = NodeCrypto.createHash("sha256").update(SUBMIT_SCRIPT).digest("base64");
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  `script-src 'sha256-${SUBMIT_SCRIPT_HASH}'`,
  "style-src 'unsafe-inline'",
  "form-action https://github.com",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** The page that posts the manifest to GitHub on load, with a button for when scripts are off. */
const githubAppManifestPage = (state: string): string => {
  const manifest = JSON.stringify(
    sandboxGithubAppManifest({
      redirectUrl: SANDBOX_GITHUB_APP_PASTE_REDIRECT_URL,
      homepageUrl: SANDBOX_GITHUB_APP_HOMEPAGE,
    }),
  );
  const action = `${GITHUB_NEW_APP}?state=${encodeURIComponent(state)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Create the GitHub App</title>
<style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
form { max-width: 26rem; padding: 1.5rem; text-align: center; }
p { margin: 0 0 1rem; line-height: 1.5; }
button { font: inherit; padding: 0.5rem 1rem; border-radius: 0.375rem; cursor: pointer; }
</style>
</head>
<body>
<form id="manifest" method="post" action="${escapeHtml(action)}">
<input type="hidden" name="manifest" value="${escapeHtml(manifest)}">
<p>Opening GitHub to create the T3 Code sandboxes app.</p>
<button type="submit">Continue to GitHub</button>
</form>
<script>${SUBMIT_SCRIPT}</script>
</body>
</html>
`;
};

const badRequest = () =>
  HttpServerResponse.text("Bad Request", {
    status: 400,
    headers: { "cache-control": "no-store" },
  });

/**
 * Opens GitHub's new-app form filled in from the user's own browser. The desktop app can only
 * open a URL there, and a URL alone can't carry the manifest GitHub needs in a POST body.
 */
export const layerGithubAppManifestRoute = HttpRouter.add(
  "GET",
  SANDBOX_GITHUB_APP_NEW_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const state = Option.flatMapNullishOr(requestUrl(request), (url) =>
      url.searchParams.get("state"),
    );
    if (Option.isNone(state) || !STATE_PATTERN.test(state.value)) return badRequest();
    return HttpServerResponse.text(githubAppManifestPage(state.value), {
      contentType: "text/html; charset=utf-8",
      headers: {
        "cache-control": "no-store",
        "content-security-policy": CONTENT_SECURITY_POLICY,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  }),
);
