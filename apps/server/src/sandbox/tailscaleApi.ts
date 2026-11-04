import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

const TAILSCALE_API = "https://api.tailscale.com/api/v2";

// A key only has to outlive the minutes between minting it and `tailscale up` in the sandbox.
const AUTH_KEY_EXPIRY_SECONDS = 600;

/** The OAuth client T3 mints sandbox keys with. Only its tag's devices are ever created. */
export interface TailscaleOAuthClient {
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted<string>;
  readonly tag: string;
}

/** A bounded reason that never carries a credential or a response body. */
class TailscaleApiError extends Data.TaggedError("TailscaleApiError")<{
  readonly detail: string;
  readonly status?: number;
}> {}

const TokenResponse = Schema.Struct({ access_token: Schema.String });
const KeyResponse = Schema.Struct({ key: Schema.String, id: Schema.optional(Schema.String) });

const describeFailure = (action: string) => (error: unknown) => {
  if (Cause.isTimeoutError(error)) {
    return new TailscaleApiError({ detail: `Tailscale did not answer while ${action}.` });
  }
  if (HttpClientError.isHttpClientError(error) && error.reason._tag === "StatusCodeError") {
    const status = error.reason.response.status;
    const hint =
      status === 401
        ? " Check the OAuth client ID and secret."
        : status === 403
          ? " Check that the OAuth client has the Auth Keys and Devices Core write scopes and owns the tag."
          : "";
    return new TailscaleApiError({
      detail: `Tailscale answered with HTTP ${status} while ${action}.${hint}`,
      status,
    });
  }
  return new TailscaleApiError({ detail: `Could not reach Tailscale while ${action}.` });
};

export const makeTailscaleApi = Effect.gen(function* () {
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

  /** A one-hour API token from the OAuth client (client credentials grant). */
  const accessToken = Effect.fn("TailscaleApi.accessToken")(function* (
    oauth: TailscaleOAuthClient,
  ) {
    const body = yield* send(
      "signing in with the OAuth client",
      HttpClientRequest.post(`${TAILSCALE_API}/oauth/token`).pipe(
        HttpClientRequest.bodyUrlParams({
          grant_type: "client_credentials",
          client_id: oauth.clientId,
          client_secret: Redacted.value(oauth.clientSecret),
        }),
      ),
      HttpClientResponse.schemaBodyJson(TokenResponse),
    );
    return Redacted.make(body.access_token);
  });

  /**
   * A single-use, pre-approved, ephemeral key for the client's tag. Ephemeral means Tailscale
   * removes the node on its own once it has been offline for a while.
   */
  const createAuthKey = Effect.fn("TailscaleApi.createAuthKey")(function* (
    token: Redacted.Redacted<string>,
    options: { readonly tag: string; readonly description: string },
  ) {
    const body = yield* send(
      "creating an auth key",
      HttpClientRequest.post(`${TAILSCALE_API}/tailnet/-/keys`).pipe(
        HttpClientRequest.bearerToken(Redacted.value(token)),
        HttpClientRequest.bodyJsonUnsafe({
          capabilities: {
            devices: {
              create: {
                reusable: false,
                ephemeral: true,
                preauthorized: true,
                tags: [options.tag],
              },
            },
          },
          expirySeconds: AUTH_KEY_EXPIRY_SECONDS,
          description: options.description,
        }),
      ),
      HttpClientResponse.schemaBodyJson(KeyResponse),
    );
    return Redacted.make(body.key);
  });

  /** Removes a device; one Tailscale already removed (an ephemeral node gone offline) is fine. */
  const deleteDevice = Effect.fn("TailscaleApi.deleteDevice")(function* (
    token: Redacted.Redacted<string>,
    deviceId: string,
  ) {
    yield* send(
      "removing the sandbox from the tailnet",
      HttpClientRequest.delete(`${TAILSCALE_API}/device/${encodeURIComponent(deviceId)}`).pipe(
        HttpClientRequest.bearerToken(Redacted.value(token)),
      ),
      () => Effect.void,
    ).pipe(
      Effect.catchIf(
        (error) => error.status === 404,
        () => Effect.void,
      ),
    );
  });

  return { accessToken, createAuthKey, deleteDevice };
});
