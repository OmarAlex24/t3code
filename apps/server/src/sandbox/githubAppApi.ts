// @effect-diagnostics nodeBuiltinImport:off - GitHub hands out PKCS#1 keys, which only node:crypto reads.
import * as NodeCrypto from "node:crypto";

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

const GITHUB_API = "https://api.github.com";

/** The app sandboxes get installation tokens from; the key never leaves this server. */
export interface GithubAppCredentials {
  readonly appId: string;
  readonly slug: string;
  readonly privateKey: Redacted.Redacted<string>;
}

/** A bounded reason that never carries a credential or a response body. */
export class GithubAppApiError extends Schema.TaggedError<GithubAppApiError>()(
  "GithubAppApiError",
  {
    detail: Schema.String,
    status: Schema.optional(Schema.Number),
  },
) {}

const isGithubAppApiError = Schema.is(GithubAppApiError);

// Fixed shapes, so building them cannot throw.
const JWT_HEADER = Buffer.from('{"alg":"RS256","typ":"JWT"}').toString("base64url");
const jwtClaims = (now: number, appId: string) =>
  Buffer.from(`{"iat":${now - 60},"exp":${now + 540},"iss":${JSON_STRING(appId)}}`).toString(
    "base64url",
  );
// App ids are digits; anything else is refused before it reaches a claim.
const JSON_STRING = (value: string) => (/^\d+$/u.test(value) ? `"${value}"` : '""');

const ManifestConversion = Schema.Struct({
  id: Schema.Number,
  slug: Schema.optional(Schema.String),
  name: Schema.String,
  pem: Schema.String,
  owner: Schema.Struct({ login: Schema.String }),
});
const Installation = Schema.Struct({ id: Schema.Number });
const InstallationToken = Schema.Struct({ token: Schema.String, expires_at: Schema.String });

const describeFailure = (action: string) => (error: unknown) => {
  if (isGithubAppApiError(error)) return error;
  if (Cause.isTimeoutError(error)) {
    return new GithubAppApiError({ detail: `GitHub did not answer while ${action}.` });
  }
  if (HttpClientError.isHttpClientError(error) && error.reason._tag === "StatusCodeError") {
    const status = error.reason.response.status;
    return new GithubAppApiError({
      detail: `GitHub answered with HTTP ${status} while ${action}.`,
      status,
    });
  }
  return new GithubAppApiError({ detail: `Could not reach GitHub while ${action}.` });
};

/** A ten-minute RS256 JWT that authenticates as the app, backdated a minute for clock drift. */
const appJwt = Effect.fn("GithubAppApi.appJwt")(function* (app: GithubAppCredentials) {
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const unsigned = `${JWT_HEADER}.${jwtClaims(now, app.appId)}`;
  const signature = yield* Effect.try({
    try: () =>
      NodeCrypto.sign(
        "sha256",
        Buffer.from(unsigned),
        NodeCrypto.createPrivateKey(Redacted.value(app.privateKey)),
      ),
    catch: () =>
      new GithubAppApiError({
        detail: "The saved GitHub App key could not be read. Connect the app again.",
      }),
  });
  return Redacted.make(`${unsigned}.${signature.toString("base64url")}`);
});

export const makeGithubAppApi = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  const send = <A>(
    action: string,
    request: HttpClientRequest.HttpClientRequest,
    decode: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, unknown>,
  ) =>
    client
      .execute(
        request.pipe(
          HttpClientRequest.setHeaders({
            accept: "application/vnd.github+json",
            // GitHub refuses requests without one with a 403.
            "user-agent": "t3code",
            "x-github-api-version": "2022-11-28",
          }),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(decode),
        Effect.timeout("20 seconds"),
        Effect.mapError(describeFailure(action)),
      );

  /** Turns the manifest flow's one-time code into the new app and its private key. */
  const convertManifest = Effect.fn("GithubAppApi.convertManifest")(function* (code: string) {
    const body = yield* send(
      "creating the GitHub App",
      HttpClientRequest.post(`${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`),
      HttpClientResponse.schemaBodyJson(ManifestConversion),
    );
    return {
      appId: String(body.id),
      slug: body.slug ?? body.name,
      owner: body.owner.login,
      privateKey: Redacted.make(body.pem),
    };
  });

  /** The app's installation on a repository, or null when the app is not installed there. */
  const repositoryInstallation = Effect.fn("GithubAppApi.repositoryInstallation")(function* (
    app: GithubAppCredentials,
    repository: { readonly owner: string; readonly name: string },
  ) {
    const jwt = yield* appJwt(app);
    return yield* send(
      `finding the app on ${repository.owner}/${repository.name}`,
      HttpClientRequest.get(
        `${GITHUB_API}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/installation`,
      ).pipe(HttpClientRequest.bearerToken(Redacted.value(jwt))),
      HttpClientResponse.schemaBodyJson(Installation),
    ).pipe(
      Effect.map((installation): number | null => installation.id),
      Effect.catchIf(
        (error) => error.status === 404,
        () => Effect.succeed(null),
      ),
    );
  });

  /**
   * An hour-long token with the app's permissions on every repository the installation covers. The
   * user picks those repositories in the installation's settings on GitHub, so an agent can work on
   * more than the sandbox's own repository.
   */
  const createInstallationToken = Effect.fn("GithubAppApi.createInstallationToken")(function* (
    app: GithubAppCredentials,
    installationId: number,
  ) {
    const jwt = yield* appJwt(app);
    const body = yield* send(
      "making a token for the sandbox",
      HttpClientRequest.post(
        `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
      ).pipe(HttpClientRequest.bearerToken(Redacted.value(jwt))),
      HttpClientResponse.schemaBodyJson(InstallationToken),
    );
    return { token: Redacted.make(body.token), expiresAt: body.expires_at };
  });

  /** Revokes an installation token with itself; one GitHub no longer accepts is already dead. */
  const revokeInstallationToken = Effect.fn("GithubAppApi.revokeInstallationToken")(function* (
    token: Redacted.Redacted<string>,
  ) {
    yield* send(
      "revoking the sandbox's token",
      HttpClientRequest.delete(`${GITHUB_API}/installation/token`).pipe(
        HttpClientRequest.bearerToken(Redacted.value(token)),
      ),
      () => Effect.void,
    ).pipe(
      Effect.catchIf(
        (error) => error.status === 401,
        () => Effect.void,
      ),
    );
  });

  return {
    convertManifest,
    repositoryInstallation,
    createInstallationToken,
    revokeInstallationToken,
  };
});
