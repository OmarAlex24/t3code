import { SourceControlSignInError, type SourceControlProviderKind } from "@t3tools/contracts";
import {
  defineSourceControlDriver,
  withOwnServices,
  type SourceControlSignIn,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";

import { definition } from "../shared/definition.ts";

import * as GitHubAppAccess from "./GitHubAppAccess.ts";
import * as GitHubAppSignIn from "./GitHubAppSignIn.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubMediaFetch from "./gitHubMediaFetch.ts";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import * as GitHubPullRequestProvider from "./GitHubPullRequestProvider.ts";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";

// `GitHubRest.layerWithDependencies` carries the quota reserve every GitHub reader shares, so it
// must be built once; the driver is.
const services = GitHubPullRequestApi.layer.pipe(
  Layer.provideMerge(GitHubAppAccess.layer),
  Layer.provideMerge(GitHubRest.layerWithDependencies),
);

const makeSignIn = Effect.gen(function* () {
  const appSignIn = yield* GitHubAppSignIn.GitHubAppSignIn;
  const appAccess = yield* GitHubAppAccess.GitHubAppAccess;
  const kind: SourceControlProviderKind = definition.kind;
  return {
    start: appSignIn.start,
    wait: (host) =>
      appSignIn.wait(host).pipe(
        Effect.andThen(
          appAccess.viewer(host).pipe(
            Effect.mapError(
              (cause) =>
                new SourceControlSignInError({
                  provider: kind,
                  host,
                  reason: "failed",
                  detail: "Signed in, but GitHub would not say which account it belongs to.",
                  cause,
                }),
            ),
          ),
        ),
        Effect.map((account) => ({ account })),
      ),
    cancel: appSignIn.cancel,
    access: appAccess.reach,
  } satisfies SourceControlSignIn;
});

// Only 204 means starred. Tokens without star access, a missing login, and 404 all read as false.
export const makeIsRepositoryStarred = Effect.gen(function* () {
  const api = yield* GitHubRest.GitHubRest;
  return Effect.fn("GitHubDriver.isRepositoryStarred")(
    function* (host: string, repository: string) {
      const segments = repository.split("/");
      if (segments.length !== 2) return false;
      const response = yield* api.rest({
        host,
        operation: "isRepositoryStarred",
        path: `user/starred/${segments.map(encodeURIComponent).join("/")}`,
        allowReserve: false,
      });
      return response.status === 204;
    },
    Effect.orElseSucceed(() => false),
  );
});

// Settings token, then GH_TOKEN/GITHUB_TOKEN, then `gh auth token`: what every GitHub call here uses.
const makeCredentialToken = Effect.gen(function* () {
  const credentials = yield* GitHubCredentials.GitHubCredentials;
  return (host: string) =>
    credentials.get(host).pipe(
      Effect.map((credential) => Option.some(credential.token)),
      Effect.orElseSucceed(() => Option.none<Redacted.Redacted<string>>()),
    );
});

const makeInstance = Effect.all({
  sourceControl: GitHubSourceControlProvider.make,
  discovery: GitHubSourceControlProvider.makeDiscovery,
  pullRequests: GitHubPullRequestProvider.make,
  fetchMedia: GitHubMediaFetch.make,
  signIn: makeSignIn,
  isRepositoryStarred: makeIsRepositoryStarred,
  credentialToken: makeCredentialToken,
});

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, services),
});
