import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { describe } from "vite-plus/test";

import * as ServerConfig from "./config.ts";
import * as ServerHttp from "./http.ts";

describe("browser API CORS behind a sandbox proxy", () => {
  it("adds no CORS headers when the proxy in front answers CORS", async () => {
    const layerRoute = Layer.effectDiscard(
      Effect.gen(function* () {
        const router = yield* HttpRouter.HttpRouter;
        yield* router.add("GET", "/api/environment", HttpServerResponse.empty());
      }),
    );
    const layerProxyConfig = Layer.effect(
      ServerConfig.ServerConfig,
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        return { ...config, proxyHandlesCors: true };
      }),
    ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "http-cors-proxy-" })));
    const layerApp = Layer.merge(layerRoute, ServerHttp.layerBrowserApiCors).pipe(
      Layer.provide(layerProxyConfig),
      Layer.provide(NodeServices.layer),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(layerApp, { disableLogger: true });

    try {
      const response = await handler(
        new Request("https://backend.example/api/environment", {
          headers: { origin: "https://app.t3.codes" },
        }),
      );

      // Daytona's proxy adds the origin it echoes; a second value here would fail the request.
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await dispose();
    }
  });
});
