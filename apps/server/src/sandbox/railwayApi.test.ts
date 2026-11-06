import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe, expect } from "vite-plus/test";

import { makeRailwayApi, RAILWAY_GRAPHQL_URL, railwaySandboxTokenName } from "./railwayApi.ts";

interface Sent {
  readonly query: string;
  readonly variables: Record<string, unknown>;
  readonly auth: string | undefined;
}

// Railway's GraphQL endpoint: one POST per operation, answering by the query it was sent.
const fakeRailway = (answer: (sent: Sent) => unknown) => {
  const sent: Array<Sent> = [];
  const client = HttpClient.make((request) => {
    expect(request.url).toBe(RAILWAY_GRAPHQL_URL);
    const body =
      request.body._tag === "Uint8Array"
        ? JSON.parse(new TextDecoder().decode(request.body.body))
        : {};
    const call = {
      query: body.query,
      variables: body.variables ?? {},
      auth: request.headers.authorization,
    };
    sent.push(call);
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(answer(call))));
  });
  return { sent, client };
};

const token = Redacted.make("railway-workspace-TOKEN");

describe("railwayApi", () => {
  it.effect("mints a token named for the sandbox and returns only its value", () => {
    const fake = fakeRailway(() => ({ data: { apiTokenCreate: "minted-SECRET" } }));
    return Effect.gen(function* () {
      const api = yield* makeRailwayApi;
      const minted = yield* api.createToken(token, "ws_1", railwaySandboxTokenName("bx_abc"));
      expect(Redacted.value(minted)).toBe("minted-SECRET");
      expect(fake.sent).toEqual([
        {
          query: expect.stringContaining("apiTokenCreate"),
          variables: { i: { name: "t3-sandbox-bx_abc", workspaceId: "ws_1" } },
          auth: "Bearer railway-workspace-TOKEN",
        },
      ]);
    }).pipe(Effect.provideService(HttpClient.HttpClient, fake.client));
  });

  it.effect(
    "revokes every token with the name across pages, and finding none is not an error",
    () => {
      const page = (after: unknown) =>
        after === null
          ? {
              edges: [
                { node: { id: "tok_other", name: "t3-sandbox-bx_other" } },
                { node: { id: "tok_1", name: "t3-sandbox-bx_abc" } },
              ],
              pageInfo: { hasNextPage: true, endCursor: "c1" },
            }
          : {
              // A launch that minted twice: both go.
              edges: [{ node: { id: "tok_2", name: "t3-sandbox-bx_abc" } }],
              pageInfo: { hasNextPage: false, endCursor: "c2" },
            };
      const fake = fakeRailway((sent) =>
        sent.query.includes("workspaceApiTokens")
          ? { data: { workspaceApiTokens: page(sent.variables.after) } }
          : { data: { workspaceApiTokenDelete: true } },
      );
      return Effect.gen(function* () {
        const api = yield* makeRailwayApi;
        expect(yield* api.deleteTokensNamed(token, "ws_1", "t3-sandbox-bx_abc")).toBe(2);
        expect(
          fake.sent
            .filter((sent) => sent.query.includes("workspaceApiTokenDelete"))
            .map((sent) => sent.variables),
        ).toEqual([
          { id: "tok_1", w: "ws_1" },
          { id: "tok_2", w: "ws_1" },
        ]);
        // Already revoked (or deleted in Railway's dashboard): nothing to delete, no failure.
        expect(yield* api.deleteTokensNamed(token, "ws_1", "t3-sandbox-bx_gone")).toBe(0);
      }).pipe(Effect.provideService(HttpClient.HttpClient, fake.client));
    },
  );

  it.effect("turns GraphQL errors, which come back as HTTP 200, into bounded failures", () => {
    const fake = fakeRailway((sent) =>
      sent.query.includes("apiToken {")
        ? { data: null, errors: [{ message: "Not Authorized" }] }
        : { errors: [{ message: "Problem processing request with railway-workspace-TOKEN" }] },
    );
    return Effect.gen(function* () {
      const api = yield* makeRailwayApi;
      const refused = yield* api.tokenWorkspaces(token).pipe(Effect.flip);
      expect(refused.unauthorized).toBe(true);
      const other = yield* api.workspaceName(token, "ws_1").pipe(Effect.flip);
      expect(other.unauthorized).toBeUndefined();
      expect(other.detail).toBe("Railway refused the request while reading the workspace.");
    }).pipe(Effect.provideService(HttpClient.HttpClient, fake.client));
  });
});
