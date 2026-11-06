import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

/** A bounded reason that never carries a key or a response body. */
export class MapleApiError extends Schema.TaggedError<MapleApiError>()("MapleApiError", {
  detail: Schema.String,
  status: Schema.optional(Schema.Number),
}) {}

const CreatedKey = Schema.Struct({ id: Schema.String, secret: Schema.String });

/**
 * The Maple API that serves an MCP server URL, or null for any other host. Keys work only in the
 * region they were made in, so the sandbox's key is made where the host's server points.
 */
export const mapleApiBaseUrl = (mcpUrl: string): string | null => {
  const url = URL.parse(mcpUrl);
  if (url === null || url.protocol !== "https:") return null;
  return url.hostname === "api.maple.dev" || url.hostname === "api.eu.maple.dev"
    ? `https://${url.hostname}`
    : null;
};

const describeFailure = (action: string) => (error: unknown) => {
  if (Cause.isTimeoutError(error)) {
    return new MapleApiError({ detail: `Maple did not answer while ${action}.` });
  }
  if (HttpClientError.isHttpClientError(error) && error.reason._tag === "StatusCodeError") {
    const status = error.reason.response.status;
    const hint =
      status === 401
        ? " Check the Maple admin key saved for sandboxes."
        : status === 403
          ? " The saved key needs an org admin and the api_keys:write scope."
          : "";
    return new MapleApiError({
      detail: `Maple answered with HTTP ${status} while ${action}.${hint}`,
      status,
    });
  }
  return new MapleApiError({ detail: `Could not reach Maple while ${action}.` });
};

export const makeMapleApi = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  const send = <A>(
    action: string,
    request: HttpClientRequest.HttpClientRequest,
    decode: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, unknown>,
  ) =>
    client
      .execute(request)
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(decode),
        Effect.timeout("20 seconds"),
        Effect.mapError(describeFailure(action)),
      );

  /** An MCP-only key named for the sandbox; it expires on its own after `expiresInSeconds`. */
  const createMcpKey = Effect.fn("MapleApi.createMcpKey")(function* (
    adminKey: Redacted.Redacted<string>,
    apiBaseUrl: string,
    options: { readonly name: string; readonly expiresInSeconds: number },
  ) {
    const body = yield* send(
      "making a key for the sandbox",
      HttpClientRequest.post(`${apiBaseUrl}/v2/api_keys`).pipe(
        HttpClientRequest.bearerToken(Redacted.value(adminKey)),
        HttpClientRequest.bodyJsonUnsafe({
          name: options.name,
          description: "Made by T3 Code for one sandbox; revoked when the sandbox is deleted.",
          kind: "mcp",
          expires_in_seconds: options.expiresInSeconds,
        }),
      ),
      HttpClientResponse.schemaBodyJson(CreatedKey),
    );
    return { id: body.id, secret: Redacted.make(body.secret) };
  });

  /** Revokes a key; one Maple no longer has is already gone. */
  const revokeKey = Effect.fn("MapleApi.revokeKey")(function* (
    adminKey: Redacted.Redacted<string>,
    apiBaseUrl: string,
    keyId: string,
  ) {
    yield* send(
      "revoking the sandbox's key",
      HttpClientRequest.delete(`${apiBaseUrl}/v2/api_keys/${encodeURIComponent(keyId)}`).pipe(
        HttpClientRequest.bearerToken(Redacted.value(adminKey)),
      ),
      () => Effect.void,
    ).pipe(
      Effect.catchIf(
        (error) => error.status === 404,
        () => Effect.void,
      ),
    );
  });

  return { createMcpKey, revokeKey };
});
