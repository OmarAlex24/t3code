import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

export const RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";

/** A bounded reason that never carries a token or a response body. */
export class RailwayApiError extends Schema.TaggedError<RailwayApiError>()("RailwayApiError", {
  detail: Schema.String,
  status: Schema.optional(Schema.Number),
  /** Railway answered "Not Authorized": the token is wrong, revoked, or lacks the access. */
  unauthorized: Schema.optional(Schema.Boolean),
}) {}

/** The saved token and its workspace, or undefined until both are saved. */
export const railwayCredentialsOf = (tooling: {
  readonly railwayToken: string;
  readonly railwayWorkspaceId: string;
}) =>
  tooling.railwayToken === "" || tooling.railwayWorkspaceId === ""
    ? undefined
    : { token: Redacted.make(tooling.railwayToken), workspaceId: tooling.railwayWorkspaceId };

/** The token T3 makes for one sandbox; unique, so a revoke can find it again by name. */
export const railwaySandboxTokenName = (sandboxId: string) => `t3-sandbox-${sandboxId}`;

// GraphQL answers 200 with `errors` when it refuses, so a status check alone would pass them.
const GraphqlResponse = Schema.Struct({
  data: Schema.optional(Schema.NullOr(Schema.Unknown)),
  errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.optional(Schema.String) }))),
});

const Workspace = Schema.Struct({ id: Schema.String, name: Schema.String });
const TokenWorkspaces = Schema.Struct({
  apiToken: Schema.Struct({ workspaces: Schema.Array(Workspace) }),
});
const WorkspaceName = Schema.Struct({ workspace: Schema.Struct({ name: Schema.String }) });
const CreatedToken = Schema.Struct({ apiTokenCreate: Schema.String });
const TokenPage = Schema.Struct({
  workspaceApiTokens: Schema.Struct({
    edges: Schema.Array(
      Schema.Struct({ node: Schema.Struct({ id: Schema.String, name: Schema.String }) }),
    ),
    pageInfo: Schema.Struct({
      hasNextPage: Schema.Boolean,
      endCursor: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  }),
});

const UNAUTHORIZED = /not authori[sz]ed/iu;

const isRailwayApiError = Schema.is(RailwayApiError);

const describeFailure = (action: string) => (error: unknown) => {
  if (isRailwayApiError(error)) return error;
  if (Cause.isTimeoutError(error)) {
    return new RailwayApiError({ detail: `Railway did not answer while ${action}.` });
  }
  if (HttpClientError.isHttpClientError(error) && error.reason._tag === "StatusCodeError") {
    const status = error.reason.response.status;
    return new RailwayApiError({
      detail: `Railway answered with HTTP ${status} while ${action}.`,
      status,
      ...(status === 401 || status === 403 ? { unauthorized: true } : {}),
    });
  }
  return new RailwayApiError({ detail: `Could not reach Railway while ${action}.` });
};

// The `data` of a GraphQL answer, or a bounded failure for the `errors` Railway answers with.
const dataOf = (action: string) => (body: typeof GraphqlResponse.Type) => {
  const errors = body.errors ?? [];
  if (errors.length === 0) return Effect.succeed(body.data);
  const unauthorized = errors.some((error) => UNAUTHORIZED.test(error.message ?? ""));
  return Effect.fail(
    new RailwayApiError({
      detail: unauthorized
        ? `Railway did not accept the token while ${action}.`
        : `Railway refused the request while ${action}.`,
      ...(unauthorized ? { unauthorized: true } : {}),
    }),
  );
};

export const makeRailwayApi = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  const graphql = <S extends Schema.Decoder<unknown>>(
    action: string,
    token: Redacted.Redacted<string>,
    query: string,
    variables: Readonly<Record<string, unknown>>,
    schema: S,
  ): Effect.Effect<S["Type"], RailwayApiError> =>
    client
      .execute(
        HttpClientRequest.post(RAILWAY_GRAPHQL_URL).pipe(
          HttpClientRequest.setHeader("user-agent", "t3code"),
          HttpClientRequest.bearerToken(Redacted.value(token)),
          HttpClientRequest.bodyJsonUnsafe({ query, variables }),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(GraphqlResponse)),
        Effect.flatMap(dataOf(action)),
        Effect.flatMap(Schema.decodeUnknownEffect(schema)),
        Effect.timeout("20 seconds"),
        Effect.mapError(describeFailure(action)),
      );

  /** The workspaces a token can act on; workspace tokens reach exactly one. */
  const tokenWorkspaces = Effect.fn("RailwayApi.tokenWorkspaces")(function* (
    token: Redacted.Redacted<string>,
  ) {
    const data = yield* graphql(
      "reading the token's workspaces",
      token,
      "query { apiToken { workspaces { id name } } }",
      {},
      TokenWorkspaces,
    );
    return data.apiToken.workspaces;
  });

  /** The workspace's name, which also proves the token can read it. */
  const workspaceName = Effect.fn("RailwayApi.workspaceName")(function* (
    token: Redacted.Redacted<string>,
    workspaceId: string,
  ) {
    const data = yield* graphql(
      "reading the workspace",
      token,
      "query($w: String!) { workspace(workspaceId: $w) { name } }",
      { w: workspaceId },
      WorkspaceName,
    );
    return data.workspace.name;
  });

  /** A new workspace token; Railway returns only its value, so it is found again by `name`. */
  const createToken = Effect.fn("RailwayApi.createToken")(function* (
    token: Redacted.Redacted<string>,
    workspaceId: string,
    name: string,
  ) {
    const data = yield* graphql(
      "making a token for the sandbox",
      token,
      "mutation($i: ApiTokenCreateInput!) { apiTokenCreate(input: $i) }",
      { i: { name, workspaceId } },
      CreatedToken,
    );
    return Redacted.make(data.apiTokenCreate);
  });

  /**
   * Deletes every workspace token named `name` and returns how many went. None is not an error:
   * a token deleted in Railway's dashboard, or never made, is already gone.
   */
  const deleteTokensNamed = Effect.fn("RailwayApi.deleteTokensNamed")(function* (
    token: Redacted.Redacted<string>,
    workspaceId: string,
    name: string,
  ) {
    const ids: Array<string> = [];
    let after: string | null = null;
    for (let page = 0; page < 50; page += 1) {
      const data: typeof TokenPage.Type = yield* graphql(
        "looking up the sandbox's token",
        token,
        "query($w: String!, $after: String) { workspaceApiTokens(workspaceId: $w, first: 100, after: $after) { edges { node { id name } } pageInfo { hasNextPage endCursor } } }",
        { w: workspaceId, after },
        TokenPage,
      );
      for (const edge of data.workspaceApiTokens.edges) {
        if (edge.node.name === name) ids.push(edge.node.id);
      }
      const next = data.workspaceApiTokens.pageInfo;
      if (!next.hasNextPage || next.endCursor === undefined || next.endCursor === null) break;
      after = next.endCursor;
    }
    for (const id of ids) {
      yield* graphql(
        "revoking the sandbox's token",
        token,
        "mutation($id: String!, $w: String!) { workspaceApiTokenDelete(id: $id, workspaceId: $w) }",
        { id, w: workspaceId },
        Schema.Unknown,
      );
    }
    return ids.length;
  });

  return { tokenWorkspaces, workspaceName, createToken, deleteTokensNamed };
});
