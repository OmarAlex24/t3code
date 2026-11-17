import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http";

import { makeCliproxyApi } from "./cliproxyApi.ts";

const config = {
  kind: "cliproxy",
  url: "http://hub.test:8317",
  managementKey: "management-secret",
  enabled: true,
} as const;

describe("CLIProxyAPI client keys", () => {
  it.effect("appends one key with PATCH and removes only that key with DELETE", () =>
    Effect.gen(function* () {
      const requests: Array<{
        method: string;
        url: string;
        auth: string | undefined;
        body: unknown;
      }> = [];
      const http = HttpClient.make((request) => {
        requests.push({
          method: request.method,
          url: [request.url, UrlParams.toString(request.urlParams)].filter(Boolean).join("?"),
          auth: request.headers.authorization,
          body:
            request.body._tag === "Uint8Array"
              ? JSON.parse(new TextDecoder().decode(request.body.body))
              : undefined,
        });
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ status: "ok" })));
      });
      const api = yield* makeCliproxyApi.pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provide(NodeCrypto.layer),
      );
      yield* api.addApiKey(config, "t3-sandbox-web-0123456789abcdef");
      yield* api.removeApiKey(config, "t3-sandbox-web-0123456789abcdef");
      expect(requests).toEqual([
        {
          method: "PATCH",
          url: "http://hub.test:8317/v0/management/api-keys",
          auth: "Bearer management-secret",
          // An `old` the hub does not have makes it append `new` instead of replacing a key.
          body: {
            old: "t3-sandbox-web-0123456789abcdef",
            new: "t3-sandbox-web-0123456789abcdef",
          },
        },
        {
          method: "DELETE",
          url: "http://hub.test:8317/v0/management/api-keys?value=t3-sandbox-web-0123456789abcdef",
          auth: "Bearer management-secret",
          body: undefined,
        },
      ]);
    }),
  );

  it.effect("names the status, never the key, when the hub refuses it", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ error: "t3-sandbox-web-0123456789abcdef" }, { status: 403 }),
          ),
        ),
      );
      const api = yield* makeCliproxyApi.pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provide(NodeCrypto.layer),
      );
      const error = yield* Effect.flip(api.addApiKey(config, "t3-sandbox-web-0123456789abcdef"));
      expect(error.detail).toBe("The hub answered with HTTP 403.");
    }),
  );
});
