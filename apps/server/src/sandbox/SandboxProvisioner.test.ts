// @effect-diagnostics nodeBuiltinImport:off - a real HTTP server holds a response the way a provider's exec does.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as EffectNodeCrypto from "@effect/platform-node/NodeCrypto";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  SandboxProviderError,
  SecretProviderId,
  ThreadId,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  UrlParams,
} from "effect/http";
import * as Undici from "undici";
import { describe, expect } from "vite-plus/test";

import * as SandboxProvisioner from "./SandboxProvisioner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SandboxRecords from "../persistence/SandboxRecords.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SandboxHostAccess from "./SandboxHostAccess.ts";
import type {
  SandboxEnvironmentConfig,
  SandboxRecord,
  SandboxSetupSnapshot,
} from "@t3tools/contracts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { layerHttpClient, requestJson } from "./SandboxProvider.ts";
import { bridgeLinkSecretName } from "@t3tools/sandbox-bridge/link";
import { boatDriver } from "./providers/boat.ts";
import { celestoDriver } from "./providers/celesto.ts";
import { daytonaDriver } from "./providers/daytona.ts";
import { upstashDriver } from "./providers/upstash.ts";
import { vercelDriver } from "./providers/vercel.ts";

// Read once outside Effect code; stubbed shells only need the machine's PATH.
const HOST_PATH = process.env.PATH ?? "";

const boatSandboxId = "bx_abcdefgh";
const testEnvironmentId = EnvironmentId.make("11111111-1111-4111-8111-111111111111");
const descriptor = {
  environmentId: testEnvironmentId,
  label: "Boat live test",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.1.6",
  orchestrationProtocolVersion: 2,
  capabilities: {},
};

const hostEnvironmentId = EnvironmentId.make("99999999-9999-4999-8999-999999999999");

const memoryRepository = (initial: ReadonlyArray<SandboxRecord> = []) => {
  const records = new Map(initial.map((record) => [record.instanceId, record]));
  const layer = Layer.succeed(
    SandboxRecords.SandboxRecordRepository,
    SandboxRecords.SandboxRecordRepository.of({
      list: Effect.sync(() => [...records.values()]),
      get: (instanceId) => Effect.sync(() => Option.fromUndefinedOr(records.get(instanceId))),
      findByEnvironmentId: (environmentId) =>
        Effect.sync(() =>
          Option.fromUndefinedOr(
            [...records.values()].find((record) => record.environmentId === environmentId),
          ),
        ),
      put: (record) =>
        Effect.sync(() => {
          records.set(record.instanceId, record);
        }),
      remove: (instanceId) =>
        Effect.sync(() => {
          records.delete(instanceId);
        }),
    }),
  );
  /** The record of the sandbox that answers as `environmentId`. */
  const byEnvironment = (environmentId: string) =>
    [...records.values()].find((record) => record.environmentId === environmentId);
  return { layer, records, byEnvironment };
};

// Keeps nothing, so a test can create several sandboxes that answer as the same environment.
const discardingRepository = Layer.succeed(
  SandboxRecords.SandboxRecordRepository,
  SandboxRecords.SandboxRecordRepository.of({
    list: Effect.succeed([]),
    get: () => Effect.succeedNone,
    findByEnvironmentId: () => Effect.succeedNone,
    put: () => Effect.void,
    remove: () => Effect.void,
  }),
);

const memoryConfigs = (initial: ReadonlyArray<SandboxEnvironmentConfig> = []) => {
  const configs = new Map(initial.map((config) => [config.id, config]));
  const layer = Layer.succeed(
    SandboxRecords.SandboxConfigRepository,
    SandboxRecords.SandboxConfigRepository.of({
      list: Effect.sync(() => [...configs.values()]),
      get: (configId) => Effect.sync(() => Option.fromUndefinedOr(configs.get(configId))),
      put: (config) =>
        Effect.sync(() => {
          configs.set(config.id, config);
        }),
      remove: (configId) =>
        Effect.sync(() => {
          configs.delete(configId);
        }),
    }),
  );
  return { layer, configs };
};

/** The host's checkout: ignored files listed for env-file copies, and their contents. */
const memoryWorkspace = (files: Readonly<Record<string, string>> = {}) =>
  Layer.mergeAll(
    Layer.succeed(
      WorkspaceEntries.WorkspaceEntries,
      WorkspaceEntries.WorkspaceEntries.of({
        browse: () => Effect.die("unused"),
        list: () => Effect.die("unused"),
        search: () => Effect.die("unused"),
        searchContents: () => Effect.die("unused"),
        refresh: () => Effect.void,
        listIgnoredFiles: () =>
          Effect.succeed({
            files: Object.entries(files).map(([path, contents]) => ({
              path,
              byteLength: new TextEncoder().encode(contents).length,
            })),
            truncated: false,
          }),
      }),
    ),
    Layer.succeed(
      WorkspaceFileSystem.WorkspaceFileSystem,
      WorkspaceFileSystem.WorkspaceFileSystem.of({
        getMetadata: () => Effect.die("unused"),
        writeFile: () => Effect.die("unused"),
        readFile: (input) =>
          Effect.succeed({
            relativePath: input.relativePath,
            contents: files[input.relativePath] ?? "",
            byteLength: new TextEncoder().encode(files[input.relativePath] ?? "").length,
            truncated: false,
            exists: files[input.relativePath] !== undefined,
          }),
      }),
    ),
  );

/** Projects on the host: env files are read only from one of these. */
const hostProjects = (
  projects: Readonly<Record<string, string>> = { "project-host": "/host/hello" },
) =>
  Layer.succeed(
    ProjectStore.ProjectStoreV2,
    ProjectStore.ProjectStoreV2.of({
      apply: () => Effect.die("unused"),
      get: (projectId) =>
        Effect.succeed(
          projects[projectId] === undefined
            ? Option.none()
            : Option.some({
                projectId,
                title: "hello",
                workspaceRoot: projects[projectId]!,
                defaultModelSelection: null,
                defaultThreadEnvMode: null,
                autoPull: false,
                faviconPath: null,
                projectIcon: null,
                scripts: [],
                pinnedAt: null,
                archivedAt: null,
                createdAt: "2026-11-01T00:00:00.000Z",
                updatedAt: "2026-11-01T00:00:00.000Z",
                deletedAt: null,
              }),
        ),
      list: () => Effect.die("unused"),
      findActiveByWorkspaceRoot: () => Effect.die("unused"),
      getShell: () => Effect.die("unused"),
      listShells: () => Effect.die("unused"),
    }),
  );

const hostIdentity = Layer.succeed(
  ServerEnvironment.ServerEnvironmentIdentity,
  ServerEnvironment.ServerEnvironmentIdentity.of({
    getEnvironmentId: Effect.succeed(hostEnvironmentId),
  }),
);

const memorySecrets = () => {
  const values = new Map<string, Uint8Array>();
  const layer = Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: (name) => Effect.sync(() => Option.fromUndefinedOr(values.get(name))),
      set: (name, value) => Effect.sync(() => void values.set(name, value)),
      create: (name, value) => Effect.sync(() => void values.set(name, value)),
      getOrCreateRandom: (name) => Effect.sync(() => values.get(name) ?? new Uint8Array(32)),
      remove: (name) => Effect.sync(() => void values.delete(name)),
    }),
  );
  return { layer, values };
};

const provisionerLayer = (
  settings: Parameters<typeof ServerSettings.layerTest>[0] = {},
  repository: Layer.Layer<SandboxRecords.SandboxRecordRepository> = discardingRepository,
  options: {
    readonly host?: Parameters<typeof SandboxHostAccess.layerTest>[0];
    readonly secrets?: Layer.Layer<ServerSecretStore.ServerSecretStore>;
    readonly configs?: Layer.Layer<SandboxRecords.SandboxConfigRepository>;
    readonly workspace?: Readonly<Record<string, string>>;
  } = {},
) =>
  SandboxProvisioner.layer.pipe(
    Layer.provideMerge(ServerSettings.layerTest(settings)),
    Layer.provide(repository),
    Layer.provide(options.configs ?? memoryConfigs().layer),
    Layer.provide(hostIdentity),
    Layer.provide(memoryWorkspace(options.workspace)),
    Layer.provide(hostProjects()),
    Layer.provide(SandboxHostAccess.layerTest(options.host)),
    Layer.provide(options.secrets ?? memorySecrets().layer),
    Layer.provide(secretResolver),
    Layer.provide(EffectNodeCrypto.layer),
  );

// Reads only `hub#key`; every other reference is a secret its provider cannot read.
const secretResolver = Layer.succeed(SecretResolver.SecretResolver, {
  read: (references) =>
    Effect.succeed(
      references.map((reference) =>
        reference.reference === "hub#key" ? "resolved-mgmt-key" : undefined,
      ),
    ),
  invalidate: () => Effect.void,
  label: (provider) => Effect.succeed(provider),
});

const testLayer = provisionerLayer();

// Shaped like a live `GET /limits` response, with invented numbers and no account ids.
const boatLimitsFixture = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  type: "limits.info",
  accessTier: "standard",
  blockedReason: null,
  currentLimits: { activeSandboxes: 300, creationRatePerMinute: 30 },
  wallet: { balanceDollars: 12.5 },
  planIncluded: { vmHours: 2000, vmHoursRemaining: 1500, periodEnd: "2026-11-30T00:00:00.000Z" },
  sandboxPlanKey: "box_100",
  sandboxPlanDollars: 100,
  billingStatus: "active",
  checkoutRequired: false,
  canStart: true,
  startBlockedReason: null,
  starts: {
    unlimited: false,
    minute: { limit: 30, used: 1, remaining: 29 },
    hour: { limit: 210, used: 8, remaining: 202 },
    day: null,
  },
  nextStartDollars: 0,
  startWindowFull: null,
  activeSandboxes: 1,
  maxActiveSandboxes: 300,
  machineTypes: [
    { type: "default", available: true, reason: null },
    { type: "xlarge", available: false, reason: "Needs the $500 plan." },
  ],
  keepGoing: { available: true, enabled: false, capDollars: 400 },
  ...overrides,
});

const trialLimits = boatLimitsFixture({
  accessTier: "trial",
  sandboxPlanKey: "trial",
  sandboxPlanDollars: null,
});

const boatResponse = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClientResponse.fromWeb(
    request,
    Response.json({
      ok: true,
      type: "sandbox.created",
      sandbox: { id: boatSandboxId, name: "Boat sandbox" },
      hostedPorts: [{ port: 3773, url: "https://boat.example/t3" }],
    }),
  );

const bodyTextOf = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";

// What the pair command prints once it has sealed `token` to the public key in its text (a
// command, or the JSON body that carries one); any other command prints `otherwise`.
const pairOr = (command: string, token: string, otherwise: string) => {
  const key = /-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/u.exec(
    command.replaceAll("\\n", "\n"),
  )?.[0];
  if (key === undefined) return otherwise;
  const sealed = NodeCrypto.publicEncrypt(
    { key, padding: NodeCrypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(token),
  );
  return `T3_PAIR_TOKEN: ${sealed.toString("base64")}\n`;
};

// What the bridge credential script prints once it has minted `token`: its id and expiry in clear
// and the token sealed, in order, to the key in the command.
const bridgeOutput = (
  command: string,
  minted: { readonly sessionId: string; readonly token: string; readonly expiresAt: string },
) => {
  const key = /-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/u.exec(command)?.[0];
  if (key === undefined) return "T3_BRIDGE_ERROR: seal\n";
  const parts = (minted.token.match(/.{1,180}/gu) ?? []).map((part) =>
    NodeCrypto.publicEncrypt(
      { key, padding: NodeCrypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(part),
    ).toString("base64"),
  );
  return [
    `T3_BRIDGE_SESSION: ${minted.sessionId}`,
    `T3_BRIDGE_EXPIRES: ${minted.expiresAt}`,
    ...parts.map((part) => `T3_BRIDGE_PART: ${part}`),
    "T3_BRIDGE_END",
    "",
  ].join("\n");
};

// Runs a provider's command with this machine's sh, as the sandbox would, against a `t3` that
// prints what `t3 pair` prints.
const runWithStubT3 = (command: string, token: string) => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-stub-"));
  try {
    const bin = NodePath.join(home, ".local", "bin");
    NodeFS.mkdirSync(bin, { recursive: true });
    const url = `https://boat.example/t3/pair#token=${token}`;
    NodeFS.writeFileSync(
      NodePath.join(bin, "t3"),
      `#!/bin/sh
[ "$1" = pair ] || exit 64
cat <<'EOF'
Pairing with My sandbox (https://boat.example/t3).

█▀▀▀▀▀█ ▄▀▄ █▀▀▀▀▀█
█ ███ █ ▀▄▀ █ ███ █

Pairing URL: ${url}
App link: t3code://pair?url=${encodeURIComponent(url)}
Token: ${token}
Expires: 2026-11-04T13:30:00.000Z
EOF
`,
      { mode: 0o755 },
    );
    const result = NodeChildProcess.spawnSync("sh", ["-c", command], {
      env: { PATH: process.env.PATH, HOME: home },
      encoding: "utf8",
    });
    return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
};

// JSON for JSON bodies, the raw text for form posts such as Tailscale's OAuth token request.
const decodeBody = (body: Uint8Array): unknown => {
  const text = new TextDecoder().decode(body);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const recording = (
  requests: Array<{
    readonly method: string;
    readonly url: string;
    readonly body: unknown;
    readonly authorization?: string | undefined;
  }>,
  respond: (request: HttpClientRequest.HttpClientRequest) => Response,
) =>
  HttpClient.make((request) => {
    const query = UrlParams.toString(request.urlParams);
    requests.push({
      method: request.method,
      url: query === "" ? request.url : `${request.url}?${query}`,
      body: request.body._tag === "Uint8Array" ? decodeBody(request.body.body) : undefined,
      authorization: request.headers.authorization,
    });
    return Effect.succeed(HttpClientResponse.fromWeb(request, respond(request)));
  });

// Answers like `recording`, except that `lost` requests never get an answer through.
const losing = (
  requests: Array<{ readonly method: string; readonly url: string; readonly body: unknown }>,
  lost: (request: HttpClientRequest.HttpClientRequest) => boolean,
  respond: (request: HttpClientRequest.HttpClientRequest) => Response,
) => {
  const answering = recording(requests, respond);
  return HttpClient.make((request) =>
    lost(request)
      ? answering.execute(request).pipe(
          Effect.andThen(
            Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request }),
              }),
            ),
          ),
        )
      : answering.execute(request),
  );
};

const vercelConfig = { apiKey: "vcp_test", settings: {} };
const vercelTeam = (plan: string) => ({ id: "team_1", slug: "acme", billing: { plan } });
// Shaped like live `GET /v2/sandboxes/{name}` responses, with invented ids.
const vercelSandbox = (
  sandbox: Record<string, unknown> = {},
  session: Record<string, unknown> = {},
) => ({
  sandbox: {
    name: "box-attempt1",
    status: "running",
    currentSessionId: "sbx_current",
    currentSnapshotId: "snap_source",
    createdAt: 1793318400000,
    vcpus: 2,
    expiresAt: 20 * 60_000,
    ...sandbox,
  },
  session: { id: "sbx_current", status: "running", timeout: 20 * 60_000, ...session },
  routes: [
    { port: 3773, url: "https://sb-t3.vercel.run", subdomain: "sb-t3" },
    { port: 26661, url: "https://sb-system.vercel.run", subdomain: "sb-system", system: true },
  ],
});
const ndjson = (lines: ReadonlyArray<unknown>) =>
  new Response(lines.map((line) => JSON.stringify(line)).join("\n") + "\n", {
    headers: { "content-type": "application/x-ndjson" },
  });
const vercelCommand = (exitCode: number | null) => ({
  command: { id: "cmd_1", name: "sh", sessionId: "sbx_current", exitCode },
});

describe("boatDriver", () => {
  it.effect("creates a sandbox with a public T3 port and reads its URL", () =>
    Effect.gen(function* () {
      const requests: Array<{
        method: string;
        url: string;
        authorization: string | undefined;
        idempotencyKey: string | undefined;
        body: string;
      }> = [];
      const client = HttpClient.make((request) => {
        requests.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
          idempotencyKey: request.headers["idempotency-key"],
          body:
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        });
        return Effect.succeed(boatResponse(request));
      });

      const created = yield* boatDriver
        .create({
          config: { apiKey: "boat_test", settings: {} },
          name: "Boat sandbox",
          size: "default",
          idempotencyKey: "attempt-1",
        })
        .pipe(Effect.provideService(HttpClient.HttpClient, client));

      expect(created).toEqual({
        id: boatSandboxId,
        name: "Boat sandbox",
        publicUrl: "https://boat.example/t3",
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        method: "POST",
        url: "https://boat.dev/api/v1/sandboxes",
        authorization: "Bearer boat_test",
        // Every Boat start bills, so a retried create must replay instead of starting a second one.
        idempotencyKey: "attempt-1",
      });
      // The environment is reachable only if the T3 port is published, and the provider's own TTL
      // must cover T3's default lifetime instead of stopping a paired environment after an hour.
      expect(JSON.parse(requests[0]!.body)).toMatchObject({
        hostedPorts: [{ port: 3773, public: true }],
        ttlSeconds: 480 * 60,
        // The sweep reads every T3 sandbox's cost in one list call filtered by this label.
        labels: { "t3.code/role": "environment" },
      });
    }),
  );

  it.effect("maps Boat's sandbox states to the states T3 records", () =>
    Effect.gen(function* () {
      const cases = [
        ...["ready", "idle", "running"].map((state) => ({ state, expected: "running" })),
        ...["init", "provisioning", "provisioned", "cloning", "archiving"].map((state) => ({
          state,
          expected: "starting",
        })),
        { state: "archived", expected: "stopped" },
        // Boat drops the disk 14 days after a stop; resume then fails.
        { state: "archived", dataExpiredAt: "2026-10-01T00:00:00.000Z", expected: "expired" },
        { state: "error", error: "echo boat_live_secret", expected: "error" },
        { state: "cancelled", expected: "deleted" },
        { status: 404, expected: "deleted" },
        { state: "hibernating", expected: null },
      ] as const;
      for (const testCase of cases) {
        const client = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              "status" in testCase
                ? Response.json({ ok: false, code: "not_found" }, { status: testCase.status })
                : Response.json({ sandbox: { id: boatSandboxId, ...testCase } }),
            ),
          ),
        );
        const status = yield* boatDriver.status!({
          config: { apiKey: "boat_test", settings: {} },
          sandboxId: boatSandboxId,
        }).pipe(Effect.provideService(HttpClient.HttpClient, client));
        expect(status, JSON.stringify(testCase)).toBe(testCase.expected);
      }
    }),
  );

  it.effect(
    "turns a failed command into a bounded error that keeps output only in the cause",
    () => {
      const bodies: Array<string> = [];
      const client = HttpClient.make((request) => {
        bodies.push(
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        );
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ exitCode: 2, stdout: "", stderr: "t3 CLI did not install" }),
          ),
        );
      });

      return Effect.gen(function* () {
        const error = yield* boatDriver
          .execute({
            config: { apiKey: "boat_test", settings: {} },
            sandboxId: boatSandboxId,
            command: "echo 'ok'; exit 0",
            timeoutSeconds: 60,
          })
          .pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.flip);

        // The script runs in a child shell so its own exit status is what Boat reports.
        expect(JSON.parse(bodies[0]!)).toMatchObject({
          command: `sh -c 'echo '\\''ok'\\''; exit 0'`,
        });

        expect(error).toBeInstanceOf(SandboxProviderError);
        expect(error.stage).toBe("install");
        // Raw output can carry credentials, so it never becomes an attribute or part of the message.
        expect(error.detail).toBe("The command exited with 2.");
        expect(error.message).not.toContain("t3 CLI did not install");
        expect(String(error.cause)).toContain("t3 CLI did not install");
      });
    },
  );

  it.effect(
    "hands secrets over in a private file, since Boat keeps every command's text for 90 days",
    () => {
      const requests: Array<{ method: string; url: string; body: unknown }> = [];
      let failCommand = false;
      const client = recording(requests, (request) =>
        request.method === "POST" && failCommand && requests.length > 2
          ? Response.json({ ok: false, code: "sandbox_direct_failed" }, { status: 502 })
          : Response.json({ ok: true, exitCode: 0, stdout: "", stderr: "", path: "", size: 0 }),
      );
      const secret = "hub-key-'$(touch pwned)\"";
      const run = boatDriver
        .execute({
          config: { apiKey: "boat_test", settings: {} },
          sandboxId: boatSandboxId,
          command: "printf '%s' \"$T3_TEST_SECRET\" >out",
          timeoutSeconds: 60,
          secrets: { T3_TEST_SECRET: secret },
        })
        .pipe(Effect.provideService(HttpClient.HttpClient, client));
      return Effect.gen(function* () {
        yield* run;
        const calls = requests.map((request) => `${request.method} ${request.url}`);
        const commands = requests
          .filter((request) => request.url.endsWith("/commands"))
          .map((request) => (request.body as { command: string }).command);
        expect(calls).toEqual([
          `POST https://boat.dev/api/v1/sandboxes/${boatSandboxId}/commands`,
          `PUT https://boat.dev/api/v1/sandboxes/${boatSandboxId}/files`,
          `POST https://boat.dev/api/v1/sandboxes/${boatSandboxId}/commands`,
        ]);
        for (const command of commands) expect(command).not.toContain("hub-key");
        const file = requests[1]!.body as { path: string; content: string };
        const dir = file.path.replace(/\/env$/u, "");
        expect(dir).toMatch(/^\/tmp\/t3-secrets-[0-9a-z]+$/u);
        // The file is created empty and private before its content is written.
        expect(commands[0]).toContain(`umask 077`);
        expect(commands[0]).toContain(`mkdir ${dir}`);
        expect(file.content).toBe(`export T3_TEST_SECRET='hub-key-'\\''$(touch pwned)"'\n`);
        // The command reads the file and removes it before it runs.
        expect(commands[1]).toContain(`. ${file.path}\n`);
        expect(commands[1]).toContain(`rm -rf ${dir}\n`);

        // A command that never ran leaves no file behind.
        requests.length = 0;
        failCommand = true;
        yield* run.pipe(Effect.flip);
        expect(requests.at(-1)).toMatchObject({
          method: "DELETE",
          url: expect.stringMatching(
            /\/files\?path=%2Ftmp%2Ft3-secrets-[0-9a-z]+&recursive=true$/u,
          ),
        });
      });
    },
  );

  it.effect("sends a create again with its key when the answer never came", () => {
    const requests: Array<{ method: string; url: string; key: string | undefined; body: string }> =
      [];
    const client = HttpClient.make((request) => {
      requests.push({
        method: request.method,
        url: request.url,
        key: request.headers["idempotency-key"],
        body: request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
      });
      return requests.length === 1 ? Effect.never : Effect.succeed(boatResponse(request));
    });
    return Effect.gen(function* () {
      const create = yield* boatDriver
        .create({
          config: { apiKey: "boat_test", settings: {} },
          name: "Boat sandbox",
          size: "default",
          idempotencyKey: "attempt-1",
        })
        .pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.forkChild);
      yield* TestClock.adjust("300 seconds");
      // Boat returns the sandbox the lost request made instead of starting a second one.
      expect(yield* Fiber.join(create)).toMatchObject({ id: boatSandboxId });
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual({ ...requests[0], key: "attempt-1" });
    });
  });

  it.effect(
    "keeps a sandbox up with a key scoped to it alone, revoking one Boat makes wider",
    () => {
      const config = { apiKey: "boat_test", settings: {} };
      const requests: Array<{ method: string; url: string; body: unknown }> = [];
      let scope: unknown = [boatSandboxId];
      const client = recording(requests, (request) =>
        request.url.endsWith("/api-keys/scoped")
          ? Response.json(
              {
                ok: true,
                secret: "boat_keepalive_SECRET",
                apiKey: { id: "apk_keep", scope: { sandboxes: scope, environments: [] } },
              },
              { status: 201 },
            )
          : Response.json({ ok: true }),
      );
      const keepAlive = boatDriver.keepAlive!;
      return Effect.gen(function* () {
        const minted = yield* keepAlive.mintKey({
          config,
          sandboxId: boatSandboxId,
          name: "t3-keepalive-hello-1a2b3c4d",
          ttlMinutes: 43200,
        });
        expect(minted.id).toBe("apk_keep");
        // Reading and moving its own auto-stop is all the sandbox's key may do, and only there.
        expect(requests[0]).toMatchObject({
          method: "POST",
          url: "https://boat.dev/api/v1/api-keys/scoped",
        });
        expect(requests[0]?.body).toEqual({
          name: "t3-keepalive-hello-1a2b3c4d",
          ttl: "43200m",
          actions: ["sandbox.read", "sandbox.update"],
          sandboxIds: [boatSandboxId],
        });

        yield* keepAlive.extend({ config, sandboxId: boatSandboxId, ttlMinutes: 35 });
        expect(requests[1]).toMatchObject({
          method: "PATCH",
          url: `https://boat.dev/api/v1/sandboxes/${boatSandboxId}`,
        });
        expect(requests[1]?.body).toEqual({ ttlSeconds: 2100 });
        // The sandbox sends the same request itself, with the same body.
        expect(keepAlive.extendRequest(boatSandboxId)).toEqual({
          method: "PATCH",
          url: `https://boat.dev/api/v1/sandboxes/${boatSandboxId}`,
        });

        for (const wider of ["*", [boatSandboxId, "bx_other"]]) {
          requests.length = 0;
          scope = wider;
          const refused = yield* keepAlive
            .mintKey({ config, sandboxId: boatSandboxId, name: "t3-keepalive-x", ttlMinutes: 60 })
            .pipe(Effect.flip);
          expect(refused.detail).toBe(
            "Boat made the keep-alive key wider than this sandbox, so T3 Code revoked it.",
          );
          expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
            "POST https://boat.dev/api/v1/api-keys/scoped",
            "DELETE https://boat.dev/api/v1/api-keys/apk_keep",
          ]);
        }
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));
    },
  );

  it.effect("reads a sandbox's auto-stop with its state", () => {
    const config = { apiKey: "boat_test", settings: {} };
    let sandbox: unknown = {};
    const client = recording([], (request) =>
      request.url.endsWith("/sandboxes/bx_gone")
        ? Response.json({ ok: false, code: "not_found" }, { status: 404 })
        : Response.json({ sandbox }),
    );
    const keepAlive = boatDriver.keepAlive!;
    const read = (sandboxId: string) => keepAlive.status({ config, sandboxId });
    return Effect.gen(function* () {
      sandbox = {
        id: boatSandboxId,
        state: "ready",
        archiveAfter: "2026-01-01T00:35:00.000Z",
        ttlSeconds: 2100,
      };
      expect(yield* read(boatSandboxId)).toEqual({
        status: "running",
        autoStopAt: "2026-01-01T00:35:00.000Z",
      });
      // Off is null; a Boat that leaves the field out says nothing.
      sandbox = { id: boatSandboxId, state: "ready", archiveAfter: null, ttlSeconds: null };
      expect(yield* read(boatSandboxId)).toEqual({ status: "running", autoStopAt: null });
      sandbox = { id: boatSandboxId, state: "archived" };
      expect(yield* read(boatSandboxId)).toEqual({ status: "stopped" });
      expect(yield* read("bx_gone")).toEqual({ status: "deleted" });
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));
  });
});

describe("celestoDriver", () => {
  const celestoConfig = { apiKey: "celesto_test", settings: {} };
  type Sent = {
    method: string;
    url: string;
    body: unknown;
    authorization: string | undefined;
    key: string | undefined;
    client: string | undefined;
  };
  const celestoRecording = (
    requests: Array<Sent>,
    respond: (request: HttpClientRequest.HttpClientRequest) => Response | null,
  ) =>
    HttpClient.make((request) => {
      requests.push({
        method: request.method,
        url: request.url,
        body: request.body._tag === "Uint8Array" ? decodeBody(request.body.body) : undefined,
        authorization: request.headers.authorization,
        key: request.headers["idempotency-key"],
        client: request.headers["x-celesto-client"],
      });
      const response = respond(request);
      return response === null
        ? Effect.never
        : Effect.succeed(HttpClientResponse.fromWeb(request, response));
    });
  const commandOf = (request: Sent) => (request.body as { command: string }).command;

  it.effect("creates a sandbox by named size, replaying a lost create with its key", () => {
    const requests: Array<Sent> = [];
    let polls = 0;
    const client = celestoRecording(requests, (request) => {
      if (request.method === "POST") {
        return requests.length === 1 ? null : Response.json({ id: "cmp_1", status: "creating" });
      }
      return Response.json({ id: "cmp_1", status: ++polls < 2 ? "creating" : "running" });
    });
    return Effect.gen(function* () {
      const create = yield* celestoDriver
        .create({
          config: celestoConfig,
          name: "Celesto sandbox",
          size: "celesto-micro",
          ttlMinutes: 480,
          idempotencyKey: "attempt-1",
        })
        .pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.forkChild);
      yield* TestClock.adjust("300 seconds");
      yield* TestClock.adjust("2 seconds");
      expect(yield* Fiber.join(create)).toEqual({ id: "cmp_1", name: "Celesto sandbox" });
      expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        "POST https://api.celesto.ai/v1/computers",
        "POST https://api.celesto.ai/v1/computers",
        "GET https://api.celesto.ai/v1/computers/cmp_1",
        "GET https://api.celesto.ai/v1/computers/cmp_1",
      ]);
      // Celesto takes no name or label, so the same key is the only way back to a lost create.
      expect(requests[1]).toEqual(requests[0]);
      expect(requests[0]).toMatchObject({
        authorization: "Bearer celesto_test",
        key: "attempt-1",
        client: "sdk",
      });
      // Celesto refuses CPU and memory overrides, and the template's own default is Standard, not
      // Micro. Its coding-agent machines cannot take an external volume.
      expect(requests[0]!.body).toEqual({ template_id: "coding-agent", size_id: "micro" });
    });
  });

  it.effect("waits out an operation still in progress before deleting or starting", () => {
    const requests: Array<Sent> = [];
    const refused = new Set<string>();
    const client = celestoRecording(requests, (request) => {
      // A create or a stop that has not finished yet; a start or delete after it goes through.
      if (request.method !== "GET" && !refused.has(request.url)) {
        refused.add(request.url);
        return Response.json(
          { detail: "A computer operation is already in progress", status_code: 409 },
          { status: 409 },
        );
      }
      if (request.url.endsWith("/published-ports")) {
        return Response.json([
          { port: 3773, status: "published", url: "https://p-abc.celesto.dev" },
        ]);
      }
      return Response.json({ id: "cmp_1", status: "running" });
    });
    return Effect.gen(function* () {
      const destroy = yield* celestoDriver
        .destroy({ config: celestoConfig, sandboxId: "cmp_1" })
        .pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(destroy);
      const resume = yield* celestoDriver.resume!({
        config: celestoConfig,
        sandboxId: "cmp_1",
      }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      expect(yield* Fiber.join(resume)).toEqual({ publicUrl: "https://p-abc.celesto.dev" });
      expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        "DELETE https://api.celesto.ai/v1/computers/cmp_1",
        "DELETE https://api.celesto.ai/v1/computers/cmp_1",
        "POST https://api.celesto.ai/v1/computers/cmp_1/start",
        "POST https://api.celesto.ai/v1/computers/cmp_1/start",
        "GET https://api.celesto.ai/v1/computers/cmp_1",
        "GET https://api.celesto.ai/v1/computers/cmp_1/published-ports",
      ]);
    });
  });

  it.effect("publishes the T3 port and waits until its route has a URL", () => {
    const requests: Array<Sent> = [];
    let lists = 0;
    const client = celestoRecording(requests, (request) => {
      if (request.method === "POST") {
        return Response.json({ computer_id: "cmp_1", port: 3773, status: "publishing" });
      }
      lists++;
      return Response.json(
        lists === 1
          ? []
          : lists === 2
            ? [{ computer_id: "cmp_1", port: 3773, status: "publishing", url: null }]
            : [
                {
                  computer_id: "cmp_1",
                  port: 3773,
                  status: "published",
                  url: "https://p-abc.celesto.ai",
                },
              ],
      );
    });
    return Effect.gen(function* () {
      const expose = yield* celestoDriver
        .exposePort({ config: celestoConfig, sandboxId: "cmp_1", port: 3773 })
        .pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      expect(yield* Fiber.join(expose)).toBe("https://p-abc.celesto.ai");
      expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        "GET https://api.celesto.ai/v1/computers/cmp_1/published-ports",
        "POST https://api.celesto.ai/v1/computers/cmp_1/published-ports",
        "GET https://api.celesto.ai/v1/computers/cmp_1/published-ports",
        "GET https://api.celesto.ai/v1/computers/cmp_1/published-ports",
      ]);
      expect(requests[1]!.body).toEqual({ port: 3773 });
    });
  });

  it.effect("maps Celesto's computer states to the states T3 records", () =>
    Effect.gen(function* () {
      const cases = [
        { state: "running", expected: "running" },
        ...["creating", "starting", "restoring"].map((state) => ({ state, expected: "starting" })),
        { state: "stopping", expected: "stopped" },
        { state: "stopped", expected: "stopped" },
        { state: "stopped", disk_delete_at: "2026-12-01T00:00:00Z", expected: "stopped" },
        // Celesto deletes a stopped disk after 30 days.
        { state: "stopped", disk_delete_at: "1970-01-01T00:00:00Z", expected: "expired" },
        { state: "error", expected: "error" },
        { state: "lost", expected: "error" },
        { state: "deleting", expected: "deleted" },
        { state: "deleted", expected: "deleted" },
        { status: 404, expected: "deleted" },
        { state: "restorable", expected: null },
      ] as const;
      for (const testCase of cases) {
        const client = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              "status" in testCase
                ? Response.json({ detail: "Computer not found" }, { status: testCase.status })
                : Response.json({ id: "cmp_1", status: testCase.state, ...testCase }),
            ),
          ),
        );
        const status = yield* celestoDriver.status!({
          config: celestoConfig,
          sandboxId: "cmp_1",
        }).pipe(Effect.provideService(HttpClient.HttpClient, client));
        expect(status, JSON.stringify(testCase)).toBe(testCase.expected);
      }
    }),
  );

  it.effect("runs a long command detached past Celesto's 300 s cap, with secrets sealed", () => {
    const requests: Array<Sent> = [];
    let exitCode = "0";
    let pollFailed = false;
    const sandboxKey = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 3072 });
    let publicKeyAnswer = `${sandboxKey.publicKey.export({ type: "spki", format: "pem" })}`;
    const client = celestoRecording(requests, () => {
      const command = commandOf(requests.at(-1)!);
      if (command.includes("genpkey")) {
        return Response.json({ exit_code: 0, stdout: publicKeyAnswer, stderr: "" });
      }
      if (command.includes("/rc 2>/dev/null")) {
        if (!pollFailed) {
          pollFailed = true;
          return Response.json({ detail: "host busy" }, { status: 502 });
        }
        return Response.json({ exit_code: 0, stdout: `${exitCode}\n`, stderr: "" });
      }
      if (command.includes("tail -c")) {
        return Response.json({ exit_code: 0, stdout: "T3_TOOLS_MISSING: \n", stderr: "warn" });
      }
      return Response.json({ exit_code: 0, stdout: "", stderr: "" });
    });
    const secret = "hub-key-'$(touch pwned)\"";
    const run = celestoDriver
      .execute({
        config: celestoConfig,
        sandboxId: "cmp_1",
        command: "printf '%s' \"$T3_TEST_SECRET\" >out",
        timeoutSeconds: 600,
        secrets: { T3_TEST_SECRET: secret },
      })
      .pipe(Effect.provideService(HttpClient.HttpClient, client));
    return Effect.gen(function* () {
      const fiber = yield* run.pipe(Effect.forkChild);
      yield* TestClock.adjust("5 seconds");
      const result = yield* Fiber.join(fiber);
      expect(result.stdout).toBe("T3_TOOLS_MISSING: \n");

      const commands = requests.map(commandOf);
      expect(requests.every((request) => request.url.endsWith("/computers/cmp_1/exec"))).toBe(true);
      // Every step stays inside Celesto's limits, whatever the caller asked for.
      for (const request of requests) {
        const body = request.body as { command: string; timeout: number };
        expect(body.timeout).toBeLessThanOrEqual(300);
        expect(body.command.length).toBeLessThanOrEqual(10_000);
      }
      // No command carries the secret, plain or encoded: the sandbox makes a key pair, sends back
      // only its public half, and the server seals the secrets file to it.
      const envLine = `export T3_TEST_SECRET='hub-key-'\\''$(touch pwned)"'\n`;
      for (const command of commands) {
        expect(command).not.toContain("hub-key");
        expect(command).not.toContain(Buffer.from(secret).toString("base64"));
        expect(command).not.toContain(Buffer.from(envLine).toString("base64"));
      }
      expect(commands[0]).toContain("umask 077");
      expect(commands[0]).toContain("genpkey");
      const sealed = commands
        .flatMap((command) => [...command.matchAll(/printf %s ([A-Za-z0-9+/=]+) \| part /gu)])
        .map((match) =>
          NodeCrypto.privateDecrypt(
            {
              key: sandboxKey.privateKey,
              padding: NodeCrypto.constants.RSA_PKCS1_OAEP_PADDING,
              oaepHash: "sha256",
            },
            Buffer.from(match[1]!, "base64"),
          ),
        );
      expect(Buffer.concat(sealed).toString("utf8")).toBe(envLine);
      // The script runs under `setsid` and the caller's own time, and reports through a file.
      const start = commands.find((command) => command.includes("setsid -f"));
      expect(start).toContain("timeout -k 10 600 sh");
      expect(commands.filter((command) => command.includes("/rc 2>/dev/null"))).toHaveLength(2);
      expect(commands.at(-1)).toMatch(/rm -rf \/tmp\/t3-job-[0-9a-z]+/u);

      // A failed script keeps its output in the cause and removes the secrets file.
      requests.length = 0;
      exitCode = "3";
      const failed = yield* run.pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("5 seconds");
      const error = yield* Fiber.join(failed);
      expect(error.detail).toBe("The command exited with 3.");
      expect(String(error.cause)).toContain("warn");
      expect(commandOf(requests.at(-1)!)).toMatch(/rm -rf \/tmp\/t3-secrets-[0-9a-z]+/u);

      // Anything but a strong RSA public key seals nothing and removes the sandbox's key.
      const weakKey = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey;
      for (const answer of [
        "",
        "no key here",
        `${weakKey.export({ type: "spki", format: "pem" })}`,
      ]) {
        requests.length = 0;
        publicKeyAnswer = answer;
        const refused = yield* run.pipe(Effect.flip);
        expect(refused.detail).toBe("The sandbox did not return a usable key for its secrets.");
        expect(requests).toHaveLength(2);
        expect(commandOf(requests[1]!)).toMatch(/^sh -c 'rm -rf \/tmp\/t3-secrets-[0-9a-z]+'$/u);
      }
    });
  });

  it.effect("runs a short command in one exec and reads trial limits", () => {
    const requests: Array<Sent> = [];
    const client = celestoRecording(requests, (request) =>
      request.url.endsWith("/usage-overview")
        ? Response.json({ state: "trial", running_count: 0, running_limit: 1, retained_count: 0 })
        : Response.json({ exit_code: 0, stdout: "Token: pair_xyz\n", stderr: "" }),
    );
    return Effect.gen(function* () {
      const executed = yield* celestoDriver
        .execute({
          config: celestoConfig,
          sandboxId: "cmp_1",
          command: "t3 pair",
          timeoutSeconds: 60,
        })
        .pipe(Effect.provideService(HttpClient.HttpClient, client));
      expect(executed.stdout).toContain("Token: pair_xyz");
      expect(requests[0]!.body).toEqual({ command: "sh -c 't3 pair'", timeout: 60 });

      const limits = yield* celestoDriver.limits!({ config: celestoConfig }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(limits).toMatchObject({
        canStart: true,
        concurrency: { active: 0, max: 1 },
        plan: "Trial",
      });
      expect(limits?.sizes?.filter((size) => size.available).map((size) => size.id)).toEqual([
        "celesto-micro",
      ]);
      const refused = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(
              { detail: { error_code: "api_key_endpoint_not_allowed" } },
              { status: 403 },
            ),
          ),
        ),
      );
      expect(
        yield* celestoDriver.limits!({ config: celestoConfig }).pipe(
          Effect.provideService(HttpClient.HttpClient, refused),
        ),
      ).toBeNull();
    });
  });
});

describe("daytonaDriver", () => {
  it.effect("starts a sandbox, runs through the toolbox proxy, and reads a preview URL", () =>
    Effect.gen(function* () {
      const requests: Array<{ method: string; url: string; body: string }> = [];
      const client = HttpClient.make((request) => {
        requests.push({
          method: request.method,
          url: request.url,
          body:
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        });
        if (request.url.endsWith("/sandbox")) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ id: "sandbox_1", name: "Daytona sandbox", state: "creating" }),
            ),
          );
        }
        if (request.url.endsWith("/sandbox/sandbox_1/toolbox-proxy-url")) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ url: "https://toolbox.example/toolbox" }),
            ),
          );
        }
        if (request.url.endsWith("/process/execute")) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ exitCode: 0, result: "Token: pair_xyz" }),
            ),
          );
        }
        if (request.url.endsWith("/ports/3773/preview-url")) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ url: "https://3773-sandbox_1.proxy.daytona.works" }),
            ),
          );
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ id: "sandbox_1", name: "Daytona sandbox", state: "started" }),
          ),
        );
      });

      const created = yield* daytonaDriver
        .create({
          config: { apiKey: "dtn_test", settings: {} },
          name: "Daytona sandbox",
          size: "daytona-medium",
          ttlMinutes: 480,
          idempotencyKey: "attempt-1",
        })
        .pipe(Effect.provideService(HttpClient.HttpClient, client));
      const executed = yield* daytonaDriver
        .execute({
          config: { apiKey: "dtn_test", settings: {} },
          sandboxId: created.id,
          command: "t3 pair",
          timeoutSeconds: 30,
          secrets: { T3_TEST_SECRET: "daytona-env-secret" },
        })
        .pipe(Effect.provideService(HttpClient.HttpClient, client));
      const preview = yield* daytonaDriver
        .exposePort({
          config: { apiKey: "dtn_test", settings: {} },
          sandboxId: created.id,
          port: 3773,
        })
        .pipe(Effect.provideService(HttpClient.HttpClient, client));

      expect(created).toEqual({ id: "sandbox_1", name: "Daytona sandbox" });
      expect(executed.stdout).toContain("Token: pair_xyz");
      expect(preview).toBe("https://3773-sandbox_1.proxy.daytona.works");
      yield* daytonaDriver.resume!({
        config: { apiKey: "dtn_test", settings: {} },
        sandboxId: created.id,
        ttlMinutes: 180,
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));

      // Daytona deletes at its TTL, so the backstop sits a day past T3's non-destructive stop.
      expect(JSON.parse(requests[0]!.body)).toMatchObject({ ttlMinutes: 480 + 1440 });
      // `/ttl/{minutes}` counts from the call, so each start gets the same day past its running limit.
      expect(requests.at(-1)).toMatchObject({
        method: "POST",
        url: "https://app.daytona.io/api/sandbox/sandbox_1/ttl/1620",
      });
      // `/process/execute` keeps no command history, and its env is not part of the command.
      const execute = requests.find((request) => request.url.endsWith("/process/execute"));
      expect(execute?.url).toBe("https://toolbox.example/toolbox/sandbox_1/process/execute");
      expect(JSON.parse(execute!.body)).toEqual({
        command: "t3 pair",
        envs: { T3_TEST_SECRET: "daytona-env-secret" },
        timeout: 30,
      });
    }),
  );

  it.effect("maps Daytona's sandbox states to the states T3 records", () =>
    Effect.gen(function* () {
      const cases = [
        { state: "started", expected: "running" },
        ...["creating", "restoring", "starting", "pulling_snapshot", "resuming"].map((state) => ({
          state,
          expected: "starting",
        })),
        ...["stopped", "stopping", "archived", "archiving", "paused", "pausing"].map((state) => ({
          state,
          expected: "stopped",
        })),
        { state: "error", expected: "error" },
        { state: "build_failed", expected: "error" },
        { state: "destroyed", expected: "deleted" },
        { state: "destroying", expected: "deleted" },
        { status: 404, expected: "deleted" },
        { state: "snapshotting", expected: null },
      ] as const;
      for (const testCase of cases) {
        const client = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              "status" in testCase
                ? Response.json({ message: "Sandbox not found" }, { status: testCase.status })
                : Response.json({ id: "sandbox_1", state: testCase.state }),
            ),
          ),
        );
        const status = yield* daytonaDriver.status!({
          config: { apiKey: "dtn_test", settings: {} },
          sandboxId: "sandbox_1",
        }).pipe(Effect.provideService(HttpClient.HttpClient, client));
        expect(status, JSON.stringify(testCase)).toBe(testCase.expected);
      }
    }),
  );

  it.effect("deletes a sandbox whose create answer was lost", () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const client = losing(
      requests,
      (request) => request.method === "POST",
      () => Response.json({ id: "sandbox_lost", name: "box-0f1e2d3c", state: "creating" }),
    );
    return Effect.gen(function* () {
      const error = yield* daytonaDriver
        .create({
          config: { apiKey: "dtn_test", settings: {} },
          name: "Box",
          size: "daytona-small",
          idempotencyKey: "0f1e2d3c-aaaa-bbbb",
        })
        .pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.flip);
      expect(error).toMatchObject({ stage: "create" });
      expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        "POST https://app.daytona.io/api/sandbox",
        "DELETE https://app.daytona.io/api/sandbox/box-0f1e2d3c",
      ]);
      // Daytona has no idempotency key, so each attempt gets its own name.
      expect(requests[0]?.body).toMatchObject({ name: "box-0f1e2d3c" });
    });
  });
});

describe("upstashDriver", () => {
  const upstashConfig = { apiKey: "box_test", settings: {} };
  const upstashRecording = (
    requests: Array<{ method: string; url: string; body: unknown; key: string | undefined }>,
    respond: (request: HttpClientRequest.HttpClientRequest) => Response,
  ) =>
    HttpClient.make((request) => {
      requests.push({
        method: request.method,
        url: request.url,
        body: request.body._tag === "Uint8Array" ? decodeBody(request.body.body) : undefined,
        key: request.headers["x-box-api-key"],
      });
      return Effect.succeed(HttpClientResponse.fromWeb(request, respond(request)));
    });

  it.effect(
    "creates a box, waits for it, runs commands under timeout, and opens a public URL",
    () => {
      const requests: Array<{
        method: string;
        url: string;
        body: unknown;
        key: string | undefined;
      }> = [];
      let polls = 0;
      const client = upstashRecording(requests, (request) => {
        if (request.url.endsWith("/exec")) {
          return Response.json({ exit_code: 0, output: "Token: pair_xyz\n" });
        }
        if (request.url.endsWith("/preview")) {
          return Response.json({ url: "https://box_1-3773.preview.box.upstash.com", port: 3773 });
        }
        if (request.method === "POST") return Response.json({ id: "box_1", status: "creating" });
        return Response.json({ id: "box_1", status: ++polls < 2 ? "creating" : "idle" });
      });
      return Effect.gen(function* () {
        const create = yield* upstashDriver
          .create({
            config: upstashConfig,
            name: "Upstash sandbox",
            size: "small",
            ttlMinutes: 480,
            idempotencyKey: "0f1e2d3c-aaaa-bbbb",
          })
          .pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.forkChild);
        yield* TestClock.adjust("2 seconds");
        expect(yield* Fiber.join(create)).toEqual({ id: "box_1", name: "Upstash sandbox" });
        const executed = yield* upstashDriver
          .execute({
            config: upstashConfig,
            sandboxId: "box_1",
            command: "t3 pair",
            timeoutSeconds: 900,
          })
          .pipe(Effect.provideService(HttpClient.HttpClient, client));
        const url = yield* upstashDriver
          .exposePort({ config: upstashConfig, sandboxId: "box_1", port: 3773 })
          .pipe(Effect.provideService(HttpClient.HttpClient, client));

        expect(executed.stdout).toContain("Token: pair_xyz");
        expect(url).toBe("https://box_1-3773.preview.box.upstash.com");
        expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
          "POST https://us-east-1.box.upstash.com/v2/box",
          "GET https://us-east-1.box.upstash.com/v2/box/box_1",
          "GET https://us-east-1.box.upstash.com/v2/box/box_1",
          "POST https://us-east-1.box.upstash.com/v2/box/box_1/exec",
          "POST https://us-east-1.box.upstash.com/v2/box/box_1/preview",
        ]);
        // Upstash reads its own header, not a bearer token.
        for (const request of requests) expect(request.key).toBe("box_test");
        const body = requests[0]!.body as Record<string, unknown>;
        // No idempotency key, so the attempt's own name is how a lost create is found again.
        expect(body).toMatchObject({
          name: "upstash-sandbox-0f1e2d3c",
          size: "small",
          runtime: "node",
        });
        // Upstash restarts T3 itself when a URL visit wakes a paused box, but not before T3 ran once.
        expect(body.init_command).toContain('[ -d "$HOME/.t3/userdata" ]');
        expect(body.init_command).toContain("t3 serve --host 0.0.0.0 --port 3773");
        // There is no server-side timeout, so the box ends the command itself, capped at ten minutes.
        expect(requests[3]!.body).toEqual({
          command: ["timeout", "-k", "5", "600", "sh", "-c", "t3 pair"],
        });
        // Browsers cannot send a bearer token or basic auth, so the URL is public.
        expect(requests[4]!.body).toEqual({ port: 3773 });
      });
    },
  );

  it.effect("maps Upstash's box states to the states T3 records", () =>
    Effect.gen(function* () {
      const cases = [
        { state: "idle", expected: "running" },
        { state: "running", expected: "running" },
        { state: "creating", expected: "starting" },
        { state: "paused", expected: "stopped" },
        { state: "error", expected: "error" },
        { state: "deleted", expected: "deleted" },
        { status: 404, expected: "deleted" },
        { state: "migrating", expected: null },
      ] as const;
      for (const testCase of cases) {
        const requests: Array<string> = [];
        const client = HttpClient.make((request) => {
          requests.push(`${request.method} ${request.url}`);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              "status" in testCase
                ? Response.json({ error: "box not found" }, { status: testCase.status })
                : Response.json({ status: testCase.state }),
            ),
          );
        });
        const status = yield* upstashDriver.status!({
          config: upstashConfig,
          sandboxId: "box_1",
        }).pipe(Effect.provideService(HttpClient.HttpClient, client));
        expect(status, JSON.stringify(testCase)).toBe(testCase.expected);
        expect(requests).toEqual(["GET https://us-east-1.box.upstash.com/v2/box/box_1/status"]);
      }
    }),
  );

  it.effect("hands secrets over in a private file and fails a command by its exit status", () => {
    const requests: Array<{ method: string; url: string; body: unknown; key: string | undefined }> =
      [];
    let exitCode = 0;
    const client = upstashRecording(requests, (request) =>
      request.url.endsWith("/exec")
        ? Response.json({
            exit_code: requests.length > 2 ? exitCode : 0,
            output: "",
            error: "boom",
          })
        : new Response(null, { status: 200 }),
    );
    const secret = "hub-key-'$(touch pwned)\"";
    const run = upstashDriver
      .execute({
        config: upstashConfig,
        sandboxId: "box_1",
        command: "printf '%s' \"$T3_TEST_SECRET\" >out",
        timeoutSeconds: 60,
        secrets: { T3_TEST_SECRET: secret },
      })
      .pipe(Effect.provideService(HttpClient.HttpClient, client));
    return Effect.gen(function* () {
      yield* run;
      expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        "POST https://us-east-1.box.upstash.com/v2/box/box_1/exec",
        "POST https://us-east-1.box.upstash.com/v2/box/box_1/files/write",
        "POST https://us-east-1.box.upstash.com/v2/box/box_1/exec",
      ]);
      const commands = requests
        .filter((request) => request.url.endsWith("/exec"))
        .map((request) => (request.body as { command: Array<string> }).command.join(" "));
      for (const command of commands) expect(command).not.toContain("hub-key");
      const file = requests[1]!.body as { path: string; content: string };
      const dir = file.path.replace(/\/env$/u, "");
      expect(dir).toMatch(/^\/tmp\/t3-secrets-[0-9a-z]+$/u);
      expect(commands[0]).toContain("umask 077");
      expect(commands[0]).toContain(`mkdir ${dir}`);
      expect(file.content).toBe(`export T3_TEST_SECRET='hub-key-'\\''$(touch pwned)"'\n`);
      expect(commands[1]).toContain(`. ${file.path}\nrm -rf ${dir}\n`);

      // A failed command keeps its output in the cause only, and leaves no file behind.
      requests.length = 0;
      exitCode = 2;
      const error = yield* run.pipe(Effect.flip);
      expect(error.detail).toBe("The command exited with 2.");
      expect(error.message).not.toContain("boom");
      expect(String(error.cause)).toContain("boom");
      expect(requests.at(-1)).toMatchObject({
        method: "POST",
        url: "https://us-east-1.box.upstash.com/v2/box/box_1/files/remove",
        body: { path: expect.stringMatching(/^\/tmp\/t3-secrets-[0-9a-z]+$/u), recursive: true },
      });
    });
  });

  it.effect("deletes a box whose create answer was lost, found by the attempt's name", () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const client = losing(
      requests,
      (request) => request.method === "POST",
      (request) =>
        request.method === "DELETE"
          ? new Response(null, { status: 200 })
          : Response.json({ id: "box_lost", status: "creating" }),
    );
    return Effect.gen(function* () {
      const error = yield* upstashDriver
        .create({
          config: upstashConfig,
          name: "Box",
          size: "small",
          idempotencyKey: "0f1e2d3c-aaaa-bbbb",
        })
        .pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.flip);
      expect(error).toMatchObject({ stage: "create" });
      expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        "POST https://us-east-1.box.upstash.com/v2/box",
        "GET https://us-east-1.box.upstash.com/v2/box/box-0f1e2d3c",
        "DELETE https://us-east-1.box.upstash.com/v2/box/box_lost",
      ]);
    });
  });
});

describe("vercelDriver", () => {
  it.effect("creates a sandbox in the T3 project, making the project once", () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const client = recording(requests, (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v2/teams") return Response.json({ teams: [vercelTeam("pro")] });
      if (url.pathname === "/v9/projects/t3-sandboxes") {
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      }
      if (url.pathname === "/v11/projects") return Response.json({ id: "prj_1" });
      return Response.json(vercelSandbox());
    });
    return Effect.gen(function* () {
      const created = yield* vercelDriver.create({
        config: vercelConfig,
        name: "My Box!",
        size: "vercel-4",
        ttlMinutes: 480,
        idempotencyKey: "0f1e2d3c-aaaa-bbbb",
      });

      // The sandbox name is the record's id, since sessions change on every resume, and the
      // detected team is reported so the record keeps it.
      expect(created).toEqual({
        id: "box-attempt1",
        name: "My Box!",
        publicUrl: "https://sb-t3.vercel.run",
        settings: { teamId: "team_1", projectId: "t3-sandboxes" },
      });
      expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        "GET https://api.vercel.com/v2/teams?limit=20",
        "GET https://api.vercel.com/v9/projects/t3-sandboxes?teamId=team_1",
        "POST https://api.vercel.com/v11/projects?teamId=team_1",
        "POST https://api.vercel.com/v4/sandboxes?teamId=team_1",
      ]);
      expect(requests[2]?.body).toEqual({ name: "t3-sandboxes" });
      expect(requests[3]?.body).toEqual({
        // Names are URL-safe and unique per project.
        name: "my-box-0f1e2d3c",
        projectId: "t3-sandboxes",
        ports: [3773],
        timeout: 480 * 60_000,
        resources: { vcpus: 4 },
        persistent: true,
        tags: { "t3.code/role": "environment" },
        snapshotExpiration: 30 * 24 * 60 * 60 * 1000,
        keepLastSnapshots: { count: 1 },
      });
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));
  });

  it.effect("keeps a Hobby session inside the plan and refuses a size it cannot run", () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const client = recording(requests, (request) =>
      new URL(request.url).pathname === "/v2/teams"
        ? Response.json({ teams: [vercelTeam("hobby")] })
        : Response.json(vercelSandbox()),
    );
    return Effect.gen(function* () {
      yield* vercelDriver.create({
        config: vercelConfig,
        name: "Box",
        size: "vercel-2",
        ttlMinutes: 480,
        idempotencyKey: "attempt1",
      });
      expect(requests.at(-1)?.body).toMatchObject({ timeout: 45 * 60_000 });

      requests.length = 0;
      const refused = yield* vercelDriver
        .create({ config: vercelConfig, name: "Box", size: "vercel-8", idempotencyKey: "attempt2" })
        .pipe(Effect.flip);
      expect(refused).toMatchObject({ code: "size_unavailable", stage: "config" });
      expect(requests.map((request) => request.method)).toEqual(["GET"]);
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));
  });

  it.effect("finds the team from the token or the Team setting", () =>
    Effect.gen(function* () {
      const teamsOf = (respond: (pathname: string) => Response) => {
        const requests: Array<{ method: string; url: string; body: unknown }> = [];
        const client = recording(requests, (request) => respond(new URL(request.url).pathname));
        return { requests, client };
      };
      const status = (
        settings: Record<string, string>,
        respond: (pathname: string) => Response,
      ) => {
        const { requests, client } = teamsOf(respond);
        return vercelDriver.status!({
          config: { apiKey: "vcp_test", settings },
          sandboxId: "box-attempt1",
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.map((result) => ({ result, urls: requests.map((request) => request.url) })),
        );
      };
      const sandbox = Response.json(vercelSandbox());

      // A personal account has no team, so no `teamId` is sent.
      const personal = yield* status({}, (path) =>
        path === "/v2/teams" ? Response.json({ teams: [] }) : sandbox.clone(),
      );
      expect(personal.urls.at(-1)).toBe(
        "https://api.vercel.com/v2/sandboxes/box-attempt1?projectId=t3-sandboxes",
      );

      const several = yield* status({}, () =>
        Response.json({
          teams: ["a", "b", "c", "d", "e", "f"].map((slug) => ({ id: `team_${slug}`, slug })),
        }),
      ).pipe(Effect.flip);
      expect(several).toMatchObject({ stage: "config" });
      expect(several.detail).toBe(
        "This Vercel token can see 6 teams. Enter one under Team: a, b, c, d, e, ….",
      );

      // A slug in the setting resolves to the team's id, and the project setting replaces the default.
      const chosen = yield* status({ teamId: "acme", projectId: "mine" }, (path) =>
        path === "/v2/teams/acme" ? Response.json(vercelTeam("pro")) : sandbox.clone(),
      );
      expect(chosen.urls).toEqual([
        "https://api.vercel.com/v2/teams/acme",
        "https://api.vercel.com/v2/sandboxes/box-attempt1?teamId=team_1&projectId=mine",
      ]);

      // Vercel answers 403 for a team the token cannot see, which is not a rejected token.
      const hidden = yield* status({ teamId: "other" }, (path) =>
        path === "/v2/teams"
          ? Response.json({ teams: [vercelTeam("pro")] })
          : Response.json({ error: { code: "forbidden" } }, { status: 403 }),
      ).pipe(Effect.flip);
      expect(hidden).toMatchObject({ stage: "config" });
      expect(hidden.code).toBeUndefined();
      expect(hidden.detail).toContain("cannot see a team named other");

      const badToken = yield* status({ teamId: "acme" }, () =>
        Response.json({ error: { code: "forbidden", invalidToken: true } }, { status: 403 }),
      ).pipe(Effect.flip);
      expect(badToken).toMatchObject({ code: "api_key_rejected" });
    }),
  );

  it.effect(
    "runs a command in the current session and keeps a failure's output only in the cause",
    () => {
      const requests: Array<{ method: string; url: string; body: unknown }> = [];
      let exitCode = 0;
      const client = recording(requests, (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/v2/teams") return Response.json({ teams: [] });
        if (url.pathname.endsWith("/cmd")) {
          return ndjson([
            vercelCommand(null),
            { data: "Token: pair_vercel\n", stream: "stdout" },
            { data: "vcp_live_secret\n", stream: "stderr" },
            vercelCommand(exitCode),
          ]);
        }
        return Response.json(vercelSandbox({ currentSessionId: "sbx_resumed" }));
      });
      return Effect.gen(function* () {
        const run = vercelDriver.execute({
          config: vercelConfig,
          sandboxId: "box-attempt1",
          command: "t3 pair",
          timeoutSeconds: 60,
          secrets: { T3_TEST_SECRET: "vercel-env-secret" },
        });
        const ok = yield* run;
        expect(ok).toEqual({
          exitCode: 0,
          stdout: "Token: pair_vercel\n",
          stderr: "vcp_live_secret\n",
        });
        expect(requests.at(-1)).toMatchObject({
          method: "POST",
          url: "https://api.vercel.com/v2/sandboxes/sessions/sbx_resumed/cmd",
          body: {
            command: "sh",
            args: ["-c", "t3 pair"],
            // Vercel lists a session's commands with their args, but not their env.
            env: { T3_TEST_SECRET: "vercel-env-secret" },
            wait: true,
            logs: true,
            timeout: 60_000,
          },
        });

        exitCode = 3;
        const error = yield* run.pipe(Effect.flip);
        expect(error).toMatchObject({ stage: "install", detail: "The command exited with 3." });
        expect(error.message).not.toContain("vcp_live_secret");
        expect(String(error.cause)).toContain("vcp_live_secret");
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));
    },
  );

  it.effect("maps Vercel's sandbox states to the states T3 records", () =>
    Effect.gen(function* () {
      const cases = [
        { status: "running", expected: "running" },
        { status: "stopping", expected: "stopped" },
        { status: "stopped", expected: "stopped" },
        { httpStatus: 404, expected: "deleted" },
        { status: "snapshotting", expected: null },
      ] as const;
      for (const testCase of cases) {
        const client = recording([], (request) =>
          new URL(request.url).pathname === "/v2/teams"
            ? Response.json({ teams: [] })
            : "httpStatus" in testCase
              ? Response.json({ error: { code: "not_found" } }, { status: testCase.httpStatus })
              : Response.json(vercelSandbox({ status: testCase.status })),
        );
        const status = yield* vercelDriver.status!({
          config: vercelConfig,
          sandboxId: "box-attempt1",
        }).pipe(Effect.provideService(HttpClient.HttpClient, client));
        expect(status, JSON.stringify(testCase)).toBe(testCase.expected);
      }
    }),
  );

  it.effect("stops the current session and resumes into a new one", () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const plan = "pro";
    let running = true;
    const client = recording(requests, (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v2/teams") return Response.json({ teams: [vercelTeam(plan)] });
      if (request.method === "POST" || request.method === "PATCH") return Response.json({});
      return Response.json(
        url.searchParams.get("resume") === "true"
          ? vercelSandbox({ currentSessionId: "sbx_next" }, { id: "sbx_next" })
          : vercelSandbox({ status: running ? "running" : "stopped" }),
      );
    });
    const calls = () => requests.map((request) => `${request.method} ${request.url}`);
    return Effect.gen(function* () {
      yield* vercelDriver.stop!({ config: vercelConfig, sandboxId: "box-attempt1" });
      expect(calls().at(-1)).toBe(
        "POST https://api.vercel.com/v2/sandboxes/sessions/sbx_current/stop?teamId=team_1",
      );
      // Vercel answers 415 to a POST without a JSON body.
      expect(requests.at(-1)?.body).toEqual({});

      requests.length = 0;
      const resumed = yield* vercelDriver.resume!({
        config: vercelConfig,
        sandboxId: "box-attempt1",
        ttlMinutes: 120,
      });
      expect(resumed).toEqual({ publicUrl: "https://sb-t3.vercel.run" });
      // The new session takes the sandbox's timeout, so it is set before the resume.
      expect(calls().slice(1)).toEqual([
        "PATCH https://api.vercel.com/v2/sandboxes/box-attempt1?teamId=team_1&projectId=t3-sandboxes",
        "GET https://api.vercel.com/v2/sandboxes/box-attempt1?teamId=team_1&projectId=t3-sandboxes&resume=true",
      ]);
      expect(requests[1]?.body).toEqual({ timeout: 120 * 60_000 });

      // A stopped sandbox is not stopped again.
      requests.length = 0;
      running = false;
      yield* vercelDriver.stop!({ config: vercelConfig, sandboxId: "box-attempt1" });
      expect(requests.map((request) => request.method)).not.toContain("POST");
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));
  });

  it.effect("deletes a sandbox whose create answer was lost", () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const client = losing(
      requests,
      (request) => request.method === "POST" && request.url.endsWith("/v4/sandboxes"),
      (request) =>
        new URL(request.url).pathname === "/v2/teams"
          ? Response.json({ teams: [] })
          : Response.json(vercelSandbox({ name: "box-0f1e2d3c" })),
    );
    return Effect.gen(function* () {
      const error = yield* vercelDriver
        .create({
          config: vercelConfig,
          name: "Box",
          size: "vercel-2",
          idempotencyKey: "0f1e2d3c-aaaa-bbbb",
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ stage: "create" });
      expect(requests.slice(-2).map((request) => `${request.method} ${request.url}`)).toEqual([
        "POST https://api.vercel.com/v4/sandboxes",
        "DELETE https://api.vercel.com/v2/sandboxes/box-0f1e2d3c?projectId=t3-sandboxes&deleteOrphanSnapshots=true",
      ]);
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));
  });
});

describe("sandbox templates", () => {
  it.effect("lists Boat's ready saved snapshots with the allowance and deletes one", () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const client = recording(requests, (request) =>
      request.method === "DELETE"
        ? Response.json({ ok: true })
        : Response.json({
            snapshots: [
              {
                name: "web-stack",
                status: "ready",
                type: "large",
                sizeBytes: 2048,
                createdAt: "2026-10-30T00:00:00.000Z",
              },
              { name: "half-saved", status: "saving", type: "small" },
              { name: "broken", status: "failed", error: "echo boat_live_secret" },
            ],
            allowance: {
              included: 50,
              used: 3,
              extra: 0,
              pricePerExtraDailyDollars: 0.056,
              extraMonthlyDollars: 0,
            },
          }),
    );
    return Effect.gen(function* () {
      const listed = yield* boatDriver.listTemplates!({
        config: { apiKey: "boat_test", settings: {} },
      });
      yield* boatDriver.deleteTemplate!({
        config: { apiKey: "boat_test", settings: {} },
        name: "web-stack",
      });

      // Only a ready snapshot can start a sandbox.
      expect(listed).toEqual({
        templates: [
          {
            name: "web-stack",
            size: "large",
            sizeBytes: 2048,
            createdAt: "2026-10-30T00:00:00.000Z",
          },
        ],
        templateAllowance: { included: 50, used: 3, extra: 0, pricePerExtraDailyDollars: 0.056 },
      });
      expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        "GET https://boat.dev/api/v1/saved-snapshots",
        "DELETE https://boat.dev/api/v1/saved-snapshots/web-stack",
      ]);
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));
  });

  it.effect("saves, lists, deletes, and starts from Daytona snapshots T3 made", () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    let snapshotPolls = 0;
    let sandboxPolls = 0;
    const snapshot = {
      id: "snap_1",
      name: "t3-web-stack",
      state: "active",
      cpu: 2,
      mem: 4,
      sourceSandboxId: "sandbox_1",
      createdAt: "2026-10-30T00:00:00.000Z",
    };
    const client = recording(requests, (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/sandbox/sandbox_1" && request.method === "GET") {
        sandboxPolls += 1;
        return Response.json({ id: "sandbox_1", state: sandboxPolls < 2 ? "stopping" : "stopped" });
      }
      if (url.pathname === "/api/snapshots/t3-web-stack") {
        snapshotPolls += 1;
        return snapshotPolls < 2
          ? Response.json({ message: "Not found" }, { status: 404 })
          : Response.json(snapshotPolls < 3 ? { ...snapshot, state: "snapshotting" } : snapshot);
      }
      if (url.pathname === "/api/snapshots") {
        return Response.json({
          items: [
            snapshot,
            // A base image and a snapshot someone else made: neither is a T3 template.
            { id: "base", name: "daytonaio/sandbox:0.4", state: "active", general: true },
            { id: "other", name: "t3-imported", state: "active", sourceSandboxId: null },
          ],
          total: 3,
          page: 1,
          totalPages: 1,
        });
      }
      if (url.pathname === "/api/sandbox" && request.method === "POST") {
        return Response.json({ id: "sandbox_2", state: "started" });
      }
      return Response.json({ id: "sandbox_1", state: "started" });
    });
    return Effect.gen(function* () {
      const config = { apiKey: "dtn_test", settings: {} };
      const fiber = yield* daytonaDriver.saveTemplate!({
        config,
        sandboxId: "sandbox_1",
        name: "web-stack",
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      const saved = yield* Fiber.join(fiber);
      const listed = yield* daytonaDriver.listTemplates!({ config });
      yield* daytonaDriver.deleteTemplate!({ config, name: "web-stack" });
      const createFiber = yield* daytonaDriver
        .create({
          config,
          name: "From template",
          size: "daytona-small",
          idempotencyKey: "attempt-1",
          template: "web-stack",
        })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(createFiber);

      expect(saved).toEqual({
        name: "web-stack",
        createdAt: "2026-10-30T00:00:00.000Z",
        size: "daytona-medium",
      });
      expect(listed.templates.map((template) => template.name)).toEqual(["web-stack"]);
      const calls = requests.map((request) => `${request.method} ${request.url}`);
      // A cold snapshot needs a stopped sandbox, and `/stop` returns while it is still stopping.
      expect(calls.slice(0, 3)).toEqual([
        "GET https://app.daytona.io/api/sandbox/sandbox_1",
        "GET https://app.daytona.io/api/sandbox/sandbox_1",
        "POST https://app.daytona.io/api/sandbox/sandbox_1/snapshot",
      ]);
      expect(requests[2]?.body).toEqual({ name: "t3-web-stack" });
      expect(calls).toContain("GET https://app.daytona.io/api/snapshots?name=t3-&limit=200");
      expect(calls).toContain("DELETE https://app.daytona.io/api/snapshots/snap_1");
      expect(
        requests.find((request) => request.method === "POST" && request.url.endsWith("/sandbox"))
          ?.body,
      ).toMatchObject({ snapshot: "t3-web-stack" });
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));
  });

  it.effect("saves, lists, deletes, and starts from Vercel template sandboxes", () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const polls = new Map<string, number>();
    let templateExists = true;
    const client = recording(requests, (request) => {
      const url = new URL(request.url);
      const poll = (name: string) => {
        polls.set(name, (polls.get(name) ?? 0) + 1);
        return polls.get(name)!;
      };
      if (url.pathname === "/v2/teams") return Response.json({ teams: [] });
      if (url.pathname === "/v2/sandboxes" && request.method === "GET") {
        return Response.json({
          sandboxes: [
            vercelSandbox({ name: "t3-template-web", status: "stopped", vcpus: 4 }).sandbox,
            // A template mid-save is still running and has no disk yet.
            vercelSandbox({ name: "t3-template-saving", status: "running" }).sandbox,
            vercelSandbox({ name: "someone-elses", status: "stopped" }).sandbox,
          ],
        });
      }
      if (url.pathname === "/v2/sandboxes/box-attempt1" && request.method === "GET") {
        return Response.json(
          vercelSandbox({ status: poll("source") < 2 ? "stopping" : "stopped" }),
        );
      }
      if (url.pathname === "/v2/sandboxes/t3-template-web" && request.method === "GET") {
        if (templateExists) {
          templateExists = false;
          return Response.json(vercelSandbox({ name: "t3-template-web", status: "stopped" }));
        }
        return Response.json(
          vercelSandbox({
            name: "t3-template-web",
            status: poll("template") < 2 ? "stopping" : "stopped",
            currentSnapshotId: "snap_template",
            vcpus: 4,
          }),
        );
      }
      if (url.pathname.endsWith("/fork")) {
        return Response.json(
          vercelSandbox(
            {
              name: url.pathname.includes("t3-template-web/") ? "copy-attempt1" : "t3-template-web",
              currentSessionId: "sbx_fork",
            },
            { id: "sbx_fork" },
          ),
        );
      }
      return Response.json({});
    });
    const calls = () => requests.map((request) => `${request.method} ${request.url}`);
    return Effect.gen(function* () {
      const fiber = yield* vercelDriver.saveTemplate!({
        config: vercelConfig,
        sandboxId: "box-attempt1",
        name: "web",
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      const saved = yield* Fiber.join(fiber);
      expect(saved).toEqual({
        name: "web",
        createdAt: "2026-10-30T00:00:00.000Z",
        size: "vercel-4",
      });
      const base = "https://api.vercel.com/v2/sandboxes";
      expect(calls()).toEqual([
        "GET https://api.vercel.com/v2/teams?limit=20",
        // The provisioner's stop returns while Vercel still snapshots the disk.
        `GET ${base}/box-attempt1?projectId=t3-sandboxes`,
        `GET ${base}/box-attempt1?projectId=t3-sandboxes`,
        // Saving under an existing name replaces that template.
        `GET ${base}/t3-template-web?projectId=t3-sandboxes`,
        `DELETE ${base}/t3-template-web?projectId=t3-sandboxes&deleteOrphanSnapshots=true`,
        `POST ${base}/box-attempt1/fork?projectId=t3-sandboxes`,
        `POST ${base}/sessions/sbx_fork/stop`,
        `GET ${base}/t3-template-web?projectId=t3-sandboxes`,
        `GET ${base}/t3-template-web?projectId=t3-sandboxes`,
        // The template has its own snapshot now, so the source's stop snapshot is not kept.
        `DELETE ${base}/snapshots/snap_source`,
      ]);
      expect(requests[5]?.body).toEqual({
        name: "t3-template-web",
        timeout: 5 * 60_000,
        tags: { "t3.code/role": "template" },
        persistent: true,
        snapshotExpiration: 0,
        keepLastSnapshots: { count: 1 },
      });

      requests.length = 0;
      const listed = yield* vercelDriver.listTemplates!({ config: vercelConfig });
      expect(listed).toEqual({
        templates: [{ name: "web", createdAt: "2026-10-30T00:00:00.000Z", size: "vercel-4" }],
      });
      expect(calls()[1]).toBe(
        `GET ${base}?project=t3-sandboxes&tags=t3.code%2Frole%3Atemplate&limit=50`,
      );

      requests.length = 0;
      const created = yield* vercelDriver.create({
        config: vercelConfig,
        name: "Copy",
        size: "vercel-2",
        ttlMinutes: 480,
        idempotencyKey: "attempt1",
        template: "web",
      });
      expect(created).toMatchObject({ id: "copy-attempt1", publicUrl: "https://sb-t3.vercel.run" });
      expect(calls().at(-1)).toBe(`POST ${base}/t3-template-web/fork?projectId=t3-sandboxes`);
      // A fork copies the template's tags, ports, timeout, and never-expiring disk unless overridden.
      expect(requests.at(-1)?.body).toEqual({
        name: "copy-attempt1",
        ports: [3773],
        timeout: 45 * 60_000,
        tags: { "t3.code/role": "environment" },
        persistent: true,
        snapshotExpiration: 30 * 24 * 60 * 60 * 1000,
        keepLastSnapshots: { count: 1 },
      });

      requests.length = 0;
      yield* vercelDriver.deleteTemplate!({ config: vercelConfig, name: "web" });
      expect(calls().at(-1)).toBe(
        `DELETE ${base}/t3-template-web?projectId=t3-sandboxes&deleteOrphanSnapshots=true`,
      );
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));
  });

  it.effect("tells a Daytona key without snapshot permission apart from a bad key", () => {
    const client = recording([], () => Response.json({ message: "Forbidden" }, { status: 403 }));
    return Effect.gen(function* () {
      const error = yield* daytonaDriver.listTemplates!({
        config: { apiKey: "dtn_test", settings: {} },
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ code: "api_key_rejected", status: 403, stage: "template" });
      expect(error.detail).toContain("cannot manage snapshots");
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));
  });
});

describe("boat credential environments", () => {
  it.effect("lists only credential flags and never returns environment secrets", () => {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            environments: [
              {
                name: "base",
                isDefault: true,
                safeForThirdParties: false,
                passGithub: true,
                passSecrets: true,
                passSandboxCredentials: true,
                passAgentsCredentials: true,
                proxyAiCredentials: false,
                envContents: "OPENAI_API_KEY=sk-live-secret",
                secretFiles: [{ path: ".env", contents: "TOKEN=secret" }],
              },
            ],
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const environments = yield* boatDriver.listEnvironments!({
        config: { apiKey: "boat_test", settings: {} },
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));

      expect(environments).toEqual([
        {
          name: "base",
          isDefault: true,
          safeForThirdParties: false,
          passGithub: true,
          passSecrets: true,
          passSandboxCredentials: true,
          passAgentsCredentials: true,
          proxyAiCredentials: false,
        },
      ]);
      expect(JSON.stringify(environments)).not.toContain("sk-live-secret");
      expect(JSON.stringify(environments)).not.toContain("TOKEN=secret");
    });
  });

  it.effect("refuses a credential environment until the caller confirms it", () => {
    const requests: Array<string> = [];
    const client = HttpClient.make((request) => {
      requests.push(`${request.method} ${request.url}`);
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({})));
    });

    return Effect.gen(function* () {
      const error = yield* SandboxProvisioner.SandboxProvisioner.pipe(
        Effect.flatMap((provisioner) =>
          provisioner.create({
            provider: "boat",
            apiKey: "boat_test",
            environment: "base",
          }),
        ),
        Effect.provide(testLayer),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
      );

      expect(error._tag).toBe("SandboxProviderError");
      if (error._tag !== "SandboxProviderError") return;
      expect(error.stage).toBe("config");
      expect(requests).toEqual([]);
    });
  });
});

describe("provider limits", () => {
  const respondWith = (body: unknown, status = 200) =>
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status }))),
    );

  it.effect("normalizes Boat's limits and ignores the fields T3 does not use", () =>
    Effect.gen(function* () {
      const readLimits = (body: unknown) =>
        boatDriver.limits!({ config: { apiKey: "boat_test", settings: {} } }).pipe(
          Effect.provideService(HttpClient.HttpClient, respondWith(body)),
        );

      expect(yield* readLimits(boatLimitsFixture())).toEqual({
        canStart: true,
        // A null window is one the plan does not limit.
        starts: [
          { window: "minute", limit: 30, used: 1, remaining: 29 },
          { window: "hour", limit: 210, used: 8, remaining: 202 },
        ],
        concurrency: { active: 1, max: 300 },
        startCost: "included",
        maxTtlMinutes: 43200,
        canSaveTemplates: true,
        sizes: [
          { id: "default", available: true },
          { id: "xlarge", available: false, reason: "Needs the $500 plan." },
        ],
        plan: "$100 plan",
      });
      expect(
        yield* readLimits(
          boatLimitsFixture({
            accessTier: "trial",
            sandboxPlanKey: "trial",
            sandboxPlanDollars: null,
            nextStartDollars: 0.03,
            starts: { hour: { limit: 25, used: 25, remaining: 0 } },
            startWindowFull: { window: "hour", limit: 25, freesAt: "2026-10-31T15:00:00.000Z" },
          }),
        ),
      ).toMatchObject({
        starts: [
          {
            window: "hour",
            limit: 25,
            used: 25,
            remaining: 0,
            resetsAt: "2026-10-31T15:00:00.000Z",
          },
        ],
        startCost: "paid",
        startDollars: 0.03,
        maxTtlMinutes: 120,
        // Boat refuses saved snapshots on a trial, but only after T3 would have been reset.
        canSaveTemplates: false,
        plan: "Trial",
      });
      expect(yield* readLimits(boatLimitsFixture({ nextStartDollars: null }))).toMatchObject({
        startCost: "refused",
      });
    }),
  );

  it.effect("reports Daytona limits as unknown when the key cannot read the organization", () => {
    const requests: Array<string> = [];
    const client = HttpClient.make((request) => {
      requests.push(`${request.method} ${request.url}`);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          request.url.endsWith("/api-keys/current")
            ? Response.json({ organizationId: "org_1", permissions: ["write:sandboxes"] })
            : Response.json({ message: "Forbidden" }, { status: 403 }),
        ),
      );
    });
    return Effect.gen(function* () {
      const limits = yield* daytonaDriver.limits!({
        config: { apiKey: "dtn_test", settings: {} },
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));
      expect(limits).toBeNull();
      expect(requests).toEqual([
        "GET https://app.daytona.io/api/api-keys/current",
        "GET https://app.daytona.io/api/organizations/org_1/usage",
      ]);
    });
  });

  it.effect("maps provider refusals to stable codes without echoing the body", () =>
    Effect.gen(function* () {
      const cases = [
        {
          provider: "boat",
          status: 429,
          body: {
            ok: false,
            code: "rate_limited",
            message: "echo boat_live_secret",
            error: { code: "rate_limited", details: { window: "hour", retryAfterSeconds: 720 } },
          },
          code: "rate_limited",
          retryAfterSeconds: 720,
          detail: "Boat's start limit for this hour is used up. Try again in 12 min.",
        },
        {
          provider: "boat",
          status: 429,
          body: { error: { code: "IP_RATE_LIMIT_EXCEEDED" } },
          headers: { "Retry-After": "30" },
          code: "rate_limited",
          retryAfterSeconds: 30,
          detail: "Boat is limiting requests right now. Try again in 30 s.",
        },
        {
          provider: "boat",
          status: 429,
          body: { code: "limit_reached" },
          code: "concurrency_full",
        },
        {
          provider: "boat",
          status: 429,
          body: { code: "member_limit_reached" },
          code: "concurrency_full",
        },
        {
          provider: "boat",
          status: 402,
          body: { error: { code: "billing_required" } },
          code: "billing_required",
        },
        {
          provider: "boat",
          status: 402,
          body: { code: "credit_required" },
          code: "billing_required",
        },
        {
          provider: "boat",
          status: 429,
          body: { code: "trial_compute_limit_reached" },
          code: "billing_required",
        },
        {
          provider: "boat",
          status: 402,
          body: { code: "team_member_cap_reached" },
          code: "billing_required",
        },
        // A plan refusal is a 403 but not a bad key.
        {
          provider: "boat",
          status: 403,
          body: { code: "machine_class_plan_required" },
          code: "size_unavailable",
        },
        {
          provider: "boat",
          status: 403,
          body: { code: "trial_machine_class_not_allowed" },
          code: "size_unavailable",
        },
        { provider: "boat", status: 400, body: { code: "invalid_type" }, code: "size_unavailable" },
        {
          provider: "boat",
          status: 409,
          body: { code: "snapshot_data_expired" },
          code: "snapshot_expired",
        },
        {
          provider: "boat",
          status: 503,
          body: { code: "no_ready_machine" },
          code: "capacity_unavailable",
        },
        {
          provider: "boat",
          status: 503,
          body: { code: "out_of_capacity", retryAfterSeconds: 120 },
          code: "capacity_unavailable",
          retryAfterSeconds: 120,
        },
        {
          provider: "boat",
          status: 403,
          body: { code: "trial_saved_snapshots_not_allowed" },
          code: "templates_unavailable",
          detail: "Your Boat plan cannot save templates.",
        },
        {
          provider: "boat",
          status: 409,
          body: { code: "save_in_progress" },
          code: "template_saving",
        },
        { provider: "boat", status: 404, body: { code: "snapshot_not_found" }, code: "not_found" },
        { provider: "boat", status: 401, body: { code: "unauthorized" }, code: "api_key_rejected" },
        { provider: "boat", status: 404, body: {}, code: "not_found" },
        {
          provider: "vercel",
          status: 403,
          body: { error: { code: "forbidden", message: "Not authorized", invalidToken: true } },
          code: "api_key_rejected",
        },
        {
          provider: "vercel",
          status: 429,
          body: { error: { code: "rate_limited", message: "echo boat_live_secret" } },
          headers: { "Retry-After": "30" },
          code: "rate_limited",
          retryAfterSeconds: 30,
          detail: "Vercel is limiting requests right now. Try again in 30 s.",
        },
        // HTTP 402 is a payment refusal whatever the provider calls it.
        {
          provider: "vercel",
          status: 402,
          body: { error: { code: "payment_required" } },
          code: "billing_required",
        },
        {
          provider: "vercel",
          status: 404,
          body: {
            error: { code: "not_found", message: "Sandbox 'x' not found for this project." },
          },
          code: "not_found",
        },
        {
          provider: "daytona",
          status: 429,
          body: { message: "Too many requests" },
          headers: { "Retry-After-Sandbox-Create": "45" },
          code: "rate_limited",
          retryAfterSeconds: 45,
        },
        {
          provider: "celesto",
          status: 429,
          body: { detail: { error_code: "trial_retained_sandbox_limit_reached" } },
          code: "concurrency_full",
          // Stopped sandboxes count on the trial, and waiting never frees the slot.
          detail:
            "The Celesto trial keeps one sandbox, stopped ones included. Delete it or add credit first.",
        },
        {
          provider: "celesto",
          status: 429,
          body: { detail: { error_code: "concurrency_limit_reached", running_limit: 10 } },
          code: "concurrency_full",
        },
        {
          provider: "celesto",
          status: 403,
          body: { detail: { error_code: "trial_micro_only" } },
          code: "size_unavailable",
        },
        {
          provider: "celesto",
          status: 422,
          body: { detail: { error_code: "resource_overrides_unavailable" } },
          code: "size_unavailable",
        },
        {
          provider: "celesto",
          status: 422,
          body: { detail: { error_code: "invalid_sandbox_size", message: "Unknown sandbox size" } },
          code: "size_unavailable",
        },
        {
          provider: "celesto",
          status: 402,
          body: { detail: { error_code: "trial_credit_depleted" } },
          code: "billing_required",
        },
        {
          provider: "celesto",
          status: 403,
          body: {
            detail: { error_code: "api_key_scope_required", required_scope: "computers:admin" },
          },
          code: "api_key_rejected",
        },
        {
          provider: "celesto",
          status: 401,
          body: { detail: "Invalid API key" },
          code: "api_key_rejected",
        },
        {
          provider: "daytona",
          status: 500,
          body: "not json",
          code: "unknown",
          detail: "The provider responded with HTTP 500.",
        },
      ] as const;
      for (const testCase of cases) {
        const client = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                typeof testCase.body === "string" ? testCase.body : JSON.stringify(testCase.body),
                { status: testCase.status, headers: "headers" in testCase ? testCase.headers : {} },
              ),
            ),
          ),
        );
        const error = yield* requestJson({
          provider: testCase.provider,
          stage: "create",
          schema: Schema.Struct({}),
          request: HttpClientRequest.post("https://provider.example/sandboxes"),
        }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.flip);

        expect(error, testCase.code).toMatchObject({
          status: testCase.status,
          code: testCase.code,
          ...("detail" in testCase ? { detail: testCase.detail } : {}),
        });
        expect(error.retryAfterSeconds).toBe(
          "retryAfterSeconds" in testCase ? testCase.retryAfterSeconds : undefined,
        );
        expect(error.message).not.toContain("boat_live_secret");
      }
    }),
  );
});

describe("sandbox provider requests", () => {
  // Boat and Daytona answer a command only when it ends, which can be ten minutes after the request.
  it.live("keeps a command's request open past the header timeout of the server's fetch", () =>
    Effect.gen(function* () {
      const received = yield* Deferred.make<void>();
      const held: Array<NodeHttp.ServerResponse> = [];
      const server = NodeHttp.createServer((request, response) => {
        held.push(response);
        if (request.url === "/held") Deferred.doneUnsafe(received, Exit.void);
      });
      yield* Effect.acquireRelease(
        Effect.callback<void>((resume) => {
          server.listen(0, "127.0.0.1", () => resume(Effect.void));
        }),
        () =>
          Effect.sync(() => server.closeAllConnections()).pipe(
            Effect.andThen(Effect.sync(() => server.close())),
          ),
      );
      const origin = `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
      // The global dispatcher's 300 s header timeout, in miniature.
      const previous = Undici.getGlobalDispatcher();
      yield* Effect.acquireRelease(
        Effect.sync(() => Undici.setGlobalDispatcher(new Undici.Agent({ headersTimeout: 1 }))),
        () => Effect.sync(() => Undici.setGlobalDispatcher(previous)),
      );

      const command = yield* requestJson({
        provider: "boat",
        stage: "install",
        schema: Schema.Struct({ exitCode: Schema.Number }),
        request: HttpClientRequest.post(`${origin}/held`),
        timeoutSeconds: 660,
      }).pipe(Effect.provide(layerHttpClient), Effect.forkChild);
      yield* Deferred.await(received);

      const capped = yield* HttpClient.get(`${origin}/capped`).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.flip,
      );
      expect(capped.cause).toMatchObject({ cause: { code: "UND_ERR_HEADERS_TIMEOUT" } });

      held[0]!.writeHead(200, { "content-type": "application/json" }).end('{"exitCode":0}');
      expect(yield* Fiber.join(command)).toEqual({ exitCode: 0 });
    }).pipe(Effect.scoped),
  );

  it.effect("gives up on a provider that never answers once the command's own time is over", () =>
    Effect.gen(function* () {
      const silent = HttpClient.make(() => Effect.never);
      const command = yield* boatDriver
        .execute({
          config: { apiKey: "boat_test", settings: {} },
          sandboxId: boatSandboxId,
          command: "sleep 1000",
          timeoutSeconds: 600,
        })
        .pipe(Effect.provideService(HttpClient.HttpClient, silent), Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("600 seconds");
      expect(command.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("60 seconds");
      const error = yield* Fiber.join(command);
      expect(error).toMatchObject({
        provider: "boat",
        stage: "install",
        detail: "The sandbox provider did not answer in time.",
      });

      // Every other call is bounded by the five minutes Node's fetch used to give it.
      const status = yield* boatDriver.status!({
        config: { apiKey: "boat_test", settings: {} },
        sandboxId: boatSandboxId,
      }).pipe(Effect.provideService(HttpClient.HttpClient, silent), Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("300 seconds");
      expect((yield* Fiber.join(status)).detail).toBe(
        "The sandbox provider did not answer in time.",
      );
    }),
  );

  it.effect("sends a request again only where the provider says that is safe", () =>
    Effect.gen(function* () {
      const restoring = {
        ok: false,
        code: "sandbox_direct_failed",
        message: "sandbox_restoring",
        error: {
          code: "sandbox_direct_failed",
          details: { retryable: true, message: "sandbox_restoring" },
        },
      };
      const cases = [
        // Boat mounts a resumed or forked sandbox's files first; a command refused then never ran.
        { provider: "boat", method: "POST", status: 502, body: restoring, sent: 2 },
        {
          provider: "boat",
          method: "POST",
          status: 409,
          body: { code: "sandbox_starting" },
          sent: 2,
        },
        // Any other machine failure means the command possibly ran.
        {
          provider: "boat",
          method: "POST",
          status: 502,
          body: { code: "sandbox_direct_failed", message: "process_lost" },
          sent: 1,
        },
        {
          provider: "boat",
          method: "PUT",
          status: 502,
          body: { code: "sandbox_direct_failed" },
          sent: 2,
        },
        // A create with an idempotency key returns the same sandbox when sent again.
        {
          provider: "boat",
          method: "POST",
          key: true,
          status: 409,
          body: { code: "idempotency_in_progress" },
          sent: 2,
        },
        { provider: "boat", method: "POST", key: true, unreachable: true, sent: 2 },
        { provider: "boat", method: "POST", unreachable: true, sent: 1 },
        { provider: "vercel", method: "GET", unreachable: true, sent: 2 },
        { provider: "daytona", method: "GET", status: 503, body: {}, sent: 2 },
        { provider: "daytona", method: "DELETE", status: 500, body: {}, sent: 2 },
        { provider: "daytona", method: "POST", status: 502, body: {}, sent: 1 },
        // A refusal the user can act on is reported, not waited out.
        {
          provider: "boat",
          method: "GET",
          status: 503,
          body: { code: "no_ready_machine" },
          sent: 1,
        },
        // A rate limit ran nothing, so any request waits for it, but only a short wait.
        {
          provider: "daytona",
          method: "POST",
          status: 429,
          headers: { "Retry-After-Sandbox-Create": "5" },
          body: {},
          sent: 2,
        },
        {
          provider: "daytona",
          method: "POST",
          status: 429,
          headers: { "Retry-After-Sandbox-Create": "45" },
          body: {},
          sent: 1,
        },
        { provider: "boat", method: "POST", status: 429, body: { code: "limit_reached" }, sent: 1 },
        // A full plan is not a rate limit, even with a wait attached.
        {
          provider: "celesto",
          method: "POST",
          status: 429,
          headers: { "Retry-After": "5" },
          body: { detail: { error_code: "concurrency_limit_reached" } },
          sent: 1,
        },
        { provider: "daytona", method: "GET", status: 503, body: {}, failures: 9, sent: 4 },
      ] as const;
      for (const testCase of cases) {
        let sent = 0;
        const client = HttpClient.make((request) => {
          sent++;
          if (sent > ("failures" in testCase ? testCase.failures : 1)) {
            return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({})));
          }
          if ("unreachable" in testCase) {
            return Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request }),
              }),
            );
          }
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(testCase.body, {
                status: testCase.status,
                headers: "headers" in testCase ? testCase.headers : {},
              }),
            ),
          );
        });
        const base = HttpClientRequest.make(testCase.method)("https://provider.example/sandboxes");
        const fiber = yield* requestJson({
          provider: testCase.provider,
          stage: "install",
          schema: Schema.Struct({}),
          request:
            "key" in testCase
              ? HttpClientRequest.setHeaders(base, { "Idempotency-Key": "attempt-1" })
              : base,
        }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.forkChild);
        yield* TestClock.adjust("60 seconds");
        const exit = yield* Fiber.await(fiber);
        expect(sent, JSON.stringify(testCase)).toBe(testCase.sent);
        expect(Exit.isSuccess(exit), JSON.stringify(testCase)).toBe(
          testCase.sent > ("failures" in testCase ? testCase.failures : 1),
        );
      }

      // The provider's own wait is honored before the request goes again.
      let sent = 0;
      const limited = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            ++sent === 1
              ? Response.json({}, { status: 429, headers: { "Retry-After-Sandbox-Create": "5" } })
              : Response.json({}),
          ),
        ),
      );
      const waiting = yield* requestJson({
        provider: "daytona",
        stage: "create",
        schema: Schema.Struct({}),
        request: HttpClientRequest.post("https://provider.example/sandbox"),
      }).pipe(Effect.provideService(HttpClient.HttpClient, limited), Effect.forkChild);
      yield* TestClock.adjust("4 seconds");
      expect(sent).toBe(1);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(waiting);
      expect(sent).toBe(2);
    }),
  );
});

describe("SandboxProvisioner lifecycle", () => {
  const lifecycleClient = (
    requests: Array<string>,
    options: {
      readonly commands?: Array<string>;
      readonly commandExitCode?: number;
      /** `GET /limits` answers with this body; without it the provider fails to report limits. */
      readonly limits?: unknown;
      readonly bodies?: Array<{ readonly url: string; readonly body: unknown }>;
    } = {},
  ) =>
    HttpClient.make((request) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.body._tag === "Uint8Array") {
        options.bodies?.push({
          url: request.url,
          body: JSON.parse(new TextDecoder().decode(request.body.body)),
        });
      }
      if (request.url.endsWith("/limits")) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            options.limits === undefined
              ? Response.json({ ok: false, code: "unauthorized" }, { status: 401 })
              : Response.json(options.limits),
          ),
        );
      }
      if (request.url.endsWith("/.well-known/t3/environment")) {
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(descriptor)));
      }
      if (request.url.endsWith("/commands")) {
        options.commands?.push(
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body)).command
            : "",
        );
        if (options.commandExitCode !== undefined && options.commandExitCode !== 0) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ exitCode: options.commandExitCode, stdout: "", stderr: "boom" }),
            ),
          );
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(
              requests.filter((entry) => entry.endsWith("/commands")).length === 1
                ? { exitCode: 0, stdout: "", stderr: "" }
                : {
                    exitCode: 0,
                    stdout: pairOr(bodyTextOf(request), "pair_lifecycle", ""),
                    stderr: "",
                  },
            ),
          ),
        );
      }
      if (request.url.endsWith("/stop") || request.url.endsWith("/resume")) {
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ ok: true })));
      }
      if (request.url.endsWith(`/sandboxes/${boatSandboxId}`)) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ sandbox: { id: boatSandboxId, state: "ready", error: null } }),
          ),
        );
      }
      return Effect.succeed(boatResponse(request));
    });

  it.effect("stores a record, stops it, and resumes it", () => {
    const requests: Array<string> = [];
    const commands: Array<string> = [];
    const repository = memoryRepository();
    return Effect.gen(function* () {
      const result = yield* SandboxProvisioner.SandboxProvisioner.pipe(
        Effect.flatMap((provisioner) =>
          Effect.gen(function* () {
            const created = yield* provisioner.create({
              provider: "boat",
              apiKey: "boat_test",
              label: "Lifecycle sandbox",
            });
            const listed = yield* provisioner.list;
            const stopped = yield* provisioner.stop({
              instanceId: created.instanceId,
            });
            const resumed = yield* provisioner.resume({
              instanceId: created.instanceId,
            });
            return { created, listed, stopped, resumed };
          }),
        ),
        Effect.provide(provisionerLayer({}, repository.layer)),
        Effect.provideService(HttpClient.HttpClient, lifecycleClient(requests, { commands })),
      );

      expect(result.created.environmentId).toBe(testEnvironmentId);
      expect(result.listed.sandboxes).toHaveLength(1);
      expect(result.listed.sandboxes[0]?.state).toBe("running");
      expect(result.listed.sandboxes[0]?.maxRunningMinutes).toBe(480);
      expect(result.listed.sandboxes[0]?.runningSince).not.toBeNull();
      expect(result.listed.sandboxes[0]?.threadId).toBeUndefined();
      expect(result.listed.orphans).toEqual([]);
      // The running limit counts from the last start, so a stop clears it and a resume restarts it.
      expect(result.stopped.sandbox.state).toBe("stopped");
      expect(result.stopped.sandbox.runningSince).toBeNull();
      expect(result.stopped.sandbox.stoppedAt).toBeDefined();
      expect(result.resumed.sandbox.state).toBe("running");
      expect(result.resumed.sandbox.runningSince).not.toBeNull();
      expect(result.resumed.sandbox.stoppedAt).toBeUndefined();
      expect(requests.some((request) => request.endsWith("/stop"))).toBe(true);
      expect(requests.some((request) => request.endsWith("/resume"))).toBe(true);
      // Providers without systemd come back without `t3 serve`, so resume restarts it and only
      // then reports the sandbox as running.
      expect(requests.findLastIndex((request) => request.endsWith("/commands"))).toBeGreaterThan(
        requests.findIndex((request) => request.endsWith("/resume")),
      );
      expect(commands.at(-1)).toContain("nohup t3 serve --host 0.0.0.0 --port 3773");
    });
  });

  it.effect("marks a resumed sandbox as errored when T3 does not start on it", () => {
    const stopped: SandboxRecord = {
      instanceId: testEnvironmentId,
      environmentId: testEnvironmentId,
      provider: "boat",
      sandboxId: boatSandboxId,
      label: "Stopped sandbox",
      size: "small",
      state: "stopped",
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
      httpBaseUrl: "https://boat.example/t3",
      runningSince: null,
      maxRunningMinutes: 480,
    };
    const repository = memoryRepository([stopped]);
    const requests: Array<string> = [];
    return Effect.gen(function* () {
      const failure = yield* SandboxProvisioner.SandboxProvisioner.pipe(
        Effect.flatMap((provisioner) =>
          provisioner.resume({ instanceId: testEnvironmentId }).pipe(Effect.flip),
        ),
        Effect.provide(
          provisionerLayer(
            { sandboxProviders: { boat: { apiKey: "boat_test" } } },
            repository.layer,
          ),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          lifecycleClient(requests, { commandExitCode: 1 }),
        ),
      );

      expect(failure.stage).toBe("start");
      expect(failure.detail).toBe("The sandbox resumed, but T3 Code did not start on it.");
      expect(failure.message).not.toContain("boom");
      // The machine is running and billing, so the record must not claim it is still stopped.
      expect(repository.byEnvironment(testEnvironmentId)?.state).toBe("error");
      expect(requests.some((request) => request.endsWith("/resume"))).toBe(true);
    });
  });

  it.effect("refuses to resume a sandbox whose disk the provider no longer keeps", () => {
    const diskExpired: SandboxRecord = {
      instanceId: testEnvironmentId,
      environmentId: testEnvironmentId,
      provider: "boat",
      sandboxId: boatSandboxId,
      label: "Expired sandbox",
      size: "small",
      state: "expired",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      httpBaseUrl: "https://boat.example/t3",
      runningSince: null,
      maxRunningMinutes: 480,
    };
    const repository = memoryRepository([diskExpired]);
    const requests: Array<string> = [];
    return Effect.gen(function* () {
      const failure = yield* SandboxProvisioner.SandboxProvisioner.pipe(
        Effect.flatMap((provisioner) =>
          provisioner.resume({ instanceId: diskExpired.instanceId }).pipe(Effect.flip),
        ),
        Effect.provide(
          provisionerLayer(
            { sandboxProviders: { boat: { apiKey: "boat_test" } } },
            repository.layer,
          ),
        ),
        Effect.provideService(HttpClient.HttpClient, lifecycleClient(requests)),
      );

      expect(failure).toMatchObject({
        stage: "start",
        code: "snapshot_expired",
        detail: "Boat no longer keeps this stopped sandbox's disk. Delete it and create a new one.",
      });
      expect(repository.records.get(diskExpired.instanceId)?.state).toBe("expired");
      // It neither spends a start nor reads the provider's limits.
      expect(requests).toEqual([]);
    });
  });

  it.effect("refuses a start the provider would refuse before creating a machine", () =>
    Effect.gen(function* () {
      const cases = [
        {
          limits: boatLimitsFixture({
            canStart: false,
            startBlockedReason: "Add a card to keep starting sandboxes.",
          }),
          code: "billing_required",
          detail: "Add a card to keep starting sandboxes.",
        },
        {
          limits: boatLimitsFixture({
            nextStartDollars: null,
            starts: { hour: { limit: 60, used: 60, remaining: 0 } },
            startWindowFull: { window: "hour", limit: 60, freesAt: "1970-01-01T00:12:00.000Z" },
          }),
          code: "rate_limited",
          detail: "Boat's start limit for this hour is used up. Try again in 12 min.",
        },
        {
          limits: boatLimitsFixture({ activeSandboxes: 300 }),
          code: "concurrency_full",
          detail: "All 300 of your Boat sandbox slots are in use. Stop or delete one first.",
        },
        {
          limits: boatLimitsFixture(),
          size: "xlarge",
          code: "size_unavailable",
          detail: "Needs the $500 plan.",
        },
      ] as const;
      for (const testCase of cases) {
        const requests: Array<string> = [];
        const failure = yield* SandboxProvisioner.SandboxProvisioner.pipe(
          Effect.flatMap((provisioner) =>
            provisioner.create({
              provider: "boat",
              apiKey: "boat_test",
              ...("size" in testCase ? { size: testCase.size } : {}),
            }),
          ),
          Effect.provide(testLayer),
          Effect.provideService(
            HttpClient.HttpClient,
            lifecycleClient(requests, { limits: testCase.limits }),
          ),
          Effect.flip,
        );
        expect(failure).toMatchObject({
          stage: "config",
          code: testCase.code,
          detail: testCase.detail,
        });
        expect(requests).toEqual(["GET https://boat.dev/api/v1/limits"]);
      }
    }),
  );

  it.effect("caps a trial sandbox at the plan's two-hour auto-stop and records it", () => {
    const requests: Array<string> = [];
    const bodies: Array<{ readonly url: string; readonly body: unknown }> = [];
    const repository = memoryRepository();
    return Effect.gen(function* () {
      yield* SandboxProvisioner.SandboxProvisioner.pipe(
        Effect.flatMap((provisioner) =>
          provisioner.create({ provider: "boat", apiKey: "boat_test", label: "Trial sandbox" }),
        ),
        Effect.provide(provisionerLayer({}, repository.layer)),
        Effect.provideService(
          HttpClient.HttpClient,
          lifecycleClient(requests, { limits: trialLimits, bodies }),
        ),
      );

      // Boat rejects a trial create above two hours with `400 trial_auto_stop_required`.
      expect(
        bodies.find((entry) => entry.url === "https://boat.dev/api/v1/sandboxes")?.body,
      ).toMatchObject({ ttlSeconds: 7200 });
      const record = repository.byEnvironment(testEnvironmentId);
      // The provider's auto-stop is the backstop, so the running limit cannot outlast it.
      expect(record?.maxRunningMinutes).toBe(120);
      expect(record?.runningSince).toBe("1970-01-01T00:00:00.000Z");
    });
  });

  it.effect("checks the provider's limits before resuming, since a resume is a start", () => {
    const stopped: SandboxRecord = {
      instanceId: testEnvironmentId,
      environmentId: testEnvironmentId,
      provider: "boat",
      sandboxId: boatSandboxId,
      label: "Stopped sandbox",
      size: "default",
      state: "stopped",
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
      httpBaseUrl: "https://boat.example/t3",
      runningSince: null,
      maxRunningMinutes: 480,
    };
    const repository = memoryRepository([stopped]);
    const requests: Array<string> = [];
    return Effect.gen(function* () {
      const failure = yield* SandboxProvisioner.SandboxProvisioner.pipe(
        Effect.flatMap((provisioner) =>
          provisioner.resume({ instanceId: testEnvironmentId }).pipe(Effect.flip),
        ),
        Effect.provide(
          provisionerLayer(
            { sandboxProviders: { boat: { apiKey: "boat_test" } } },
            repository.layer,
          ),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          lifecycleClient(requests, { limits: boatLimitsFixture({ nextStartDollars: null }) }),
        ),
      );

      expect(failure).toMatchObject({ stage: "config", code: "billing_required" });
      expect(requests).toEqual(["GET https://boat.dev/api/v1/limits"]);
      expect(repository.byEnvironment(testEnvironmentId)?.state).toBe("stopped");
    });
  });

  it.effect("stops a running sandbox once it has run past its limit", () => {
    const expired: SandboxRecord = {
      instanceId: testEnvironmentId,
      environmentId: testEnvironmentId,
      provider: "boat",
      sandboxId: boatSandboxId,
      label: "Expired sandbox",
      size: "small",
      state: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      httpBaseUrl: "https://boat.example/t3",
      runningSince: "1969-12-31T16:00:00.000Z",
      maxRunningMinutes: 480,
    };
    // A resume that could not start T3 leaves the machine running under an `error` record.
    const errored: SandboxRecord = {
      ...expired,
      instanceId: "errored",
      environmentId: EnvironmentId.make("22222222-2222-4222-8222-222222222222"),
      state: "error",
    };
    // Started a minute short of its limit, so it keeps running.
    const fresh: SandboxRecord = {
      ...expired,
      instanceId: "fresh",
      environmentId: EnvironmentId.make("33333333-3333-4333-8333-333333333333"),
      sandboxId: "bx_fresh",
      runningSince: "1969-12-31T16:01:00.000Z",
    };
    // Keeps itself up while it works, so only Boat's idle deadline stops it, however long it runs.
    const keptUp: SandboxRecord = {
      ...expired,
      instanceId: "kept",
      environmentId: EnvironmentId.make("44444444-4444-4444-8444-444444444444"),
      sandboxId: "bx_kept",
      idleMinutes: 30,
      keepAliveKey: {
        name: "t3-keepalive-kept",
        id: "apk_kept",
        expiresAt: "1970-01-31T00:00:00.000Z",
      },
    };
    // Unless the config sets a hard limit, which it has run past.
    const capped: SandboxRecord = {
      ...keptUp,
      instanceId: "capped",
      environmentId: EnvironmentId.make("55555555-5555-4555-8555-555555555555"),
      sandboxId: "bx_capped",
      runningCapMinutes: 60,
    };
    const repository = memoryRepository([expired, errored, fresh, keptUp, capped]);
    const requests: Array<string> = [];
    return Effect.gen(function* () {
      yield* SandboxProvisioner.SandboxProvisioner.pipe(
        Effect.flatMap((provisioner) => provisioner.sweep),
        Effect.provide(
          provisionerLayer(
            { sandboxProviders: { boat: { apiKey: "boat_test" } } },
            repository.layer,
          ),
        ),
        Effect.provideService(HttpClient.HttpClient, lifecycleClient(requests)),
      );

      expect(repository.byEnvironment(testEnvironmentId)?.state).toBe("stopped");
      expect(repository.byEnvironment(testEnvironmentId)).toMatchObject({
        runningSince: null,
        stoppedAt: "1970-01-01T00:00:00.000Z",
      });
      expect(repository.records.get("errored")?.state).toBe("stopped");
      expect(repository.records.get("fresh")?.state).toBe("running");
      expect(repository.records.get("kept")?.state).toBe("running");
      expect(repository.records.get("capped")?.state).toBe("stopped");
      expect(requests.filter((request) => request.endsWith("/stop"))).toEqual([
        `POST https://boat.dev/api/v1/sandboxes/${boatSandboxId}/stop`,
        `POST https://boat.dev/api/v1/sandboxes/${boatSandboxId}/stop`,
        "POST https://boat.dev/api/v1/sandboxes/bx_capped/stop",
      ]);
      // One provider call per record per sweep: the limit stop replaces the status check.
      expect(requests).not.toContain(`GET https://boat.dev/api/v1/sandboxes/${boatSandboxId}`);
    });
  });

  it.effect("caps a reset auto-stop at the plan's longest TTL", () => {
    // A trial allows 120 minutes, so a 180-minute idle window would be refused as it is.
    const record: SandboxRecord = {
      instanceId: "bx_trial",
      environmentId: testEnvironmentId,
      provider: "boat",
      sandboxId: "bx_trial",
      label: "Trial sandbox",
      size: "small",
      state: "running",
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
      httpBaseUrl: "https://boat.example/t3",
      runningSince: "1970-01-01T00:00:00.000Z",
      maxRunningMinutes: 480,
      idleMinutes: 180,
      keepAliveKey: {
        name: "t3-keepalive-trial",
        id: "apk_trial",
        expiresAt: "1970-01-31T00:00:00.000Z",
      },
    };
    const repository = memoryRepository([record]);
    const patches: Array<unknown> = [];
    const client = HttpClient.make((request) => {
      const reply = (body: unknown) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body)));
      if (request.url.endsWith("/limits")) return reply(trialLimits);
      if (request.method === "PATCH") {
        patches.push(JSON.parse(bodyTextOf(request)));
        return reply({ ok: true });
      }
      return reply({
        sandbox: { id: "bx_trial", state: "ready", archiveAfter: null, ttlSeconds: null },
      });
    });
    return Effect.gen(function* () {
      yield* SandboxProvisioner.SandboxProvisioner.pipe(
        Effect.flatMap((provisioner) => provisioner.sweep),
        Effect.provide(
          provisionerLayer(
            { sandboxProviders: { boat: { apiKey: "boat_test" } } },
            repository.layer,
          ),
        ),
        Effect.provideService(HttpClient.HttpClient, client),
      );

      expect(patches).toEqual([{ ttlSeconds: 120 * 60 }]);
      expect(repository.records.get("bx_trial")?.state).toBe("running");
    });
  });

  it.effect("puts back an auto-stop a sandbox's own key turned off or moved far out", () => {
    const base: SandboxRecord = {
      instanceId: "bx_off",
      environmentId: testEnvironmentId,
      provider: "boat",
      sandboxId: "bx_off",
      label: "Kept sandbox",
      size: "small",
      state: "running",
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
      httpBaseUrl: "https://boat.example/t3",
      runningSince: "1970-01-01T00:00:00.000Z",
      maxRunningMinutes: 480,
      idleMinutes: 30,
      keepAliveKey: {
        name: "t3-keepalive-kept",
        id: "apk_kept",
        expiresAt: "1970-01-31T00:00:00.000Z",
      },
    };
    const record = (sandboxId: string, digit: string, plain = false) => {
      const { keepAliveKey: _key, idleMinutes: _idle, ...withoutKeepAlive } = base;
      return {
        ...(plain ? withoutKeepAlive : base),
        instanceId: sandboxId,
        sandboxId,
        environmentId: EnvironmentId.make(
          `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`,
        ),
      } satisfies SandboxRecord;
    };
    // What Boat says of each sandbox's auto-stop; a missing key is a Boat that does not say.
    const archiveAfter: Record<string, string | null | undefined> = {
      // An agent sent `ttlSeconds: null` with the sandbox's key.
      bx_off: null,
      // Or a TTL far past the idle window the loop ever sets.
      bx_far: "1970-01-01T08:00:00.000Z",
      // The loop's own deadline, and one at the edge of the slack.
      bx_loop: "1970-01-01T00:35:00.000Z",
      bx_edge: "1970-01-01T00:45:00.000Z",
      bx_unsaid: undefined,
      // No keep-alive key: its running limit applies, and its auto-stop is not this check's.
      bx_plain: null,
    };
    const repository = memoryRepository([
      base,
      record("bx_far", "2"),
      record("bx_loop", "3"),
      record("bx_edge", "4"),
      record("bx_unsaid", "5"),
      record("bx_plain", "6", true),
    ]);
    const patches: Array<{
      readonly url: string;
      readonly body: unknown;
      readonly authorization: string | undefined;
    }> = [];
    const client = HttpClient.make((request) => {
      const id = /\/sandboxes\/(bx_[a-z]+)$/u.exec(request.url)?.[1];
      if (request.method === "PATCH") {
        patches.push({
          url: request.url,
          body: JSON.parse(bodyTextOf(request)),
          authorization: request.headers.authorization,
        });
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ ok: true })));
      }
      if (request.method === "GET" && id !== undefined) {
        const after = archiveAfter[id];
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              sandbox: {
                id,
                state: "ready",
                ...(after === undefined ? {} : { archiveAfter: after, ttlSeconds: null }),
              },
            }),
          ),
        );
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json({ ok: false }, { status: 404 })),
      );
    });
    return Effect.gen(function* () {
      yield* SandboxProvisioner.SandboxProvisioner.pipe(
        Effect.flatMap((provisioner) => provisioner.sweep),
        Effect.provide(
          provisionerLayer(
            { sandboxProviders: { boat: { apiKey: "boat_test" } } },
            repository.layer,
          ),
        ),
        Effect.provideService(HttpClient.HttpClient, client),
      );

      // Back to the idle window plus one check, with the host's own key.
      expect(patches.toSorted((a, b) => a.url.localeCompare(b.url))).toEqual([
        {
          url: "https://boat.dev/api/v1/sandboxes/bx_far",
          body: { ttlSeconds: 2100 },
          authorization: "Bearer boat_test",
        },
        {
          url: "https://boat.dev/api/v1/sandboxes/bx_off",
          body: { ttlSeconds: 2100 },
          authorization: "Bearer boat_test",
        },
      ]);
      for (const id of Object.keys(archiveAfter)) {
        expect(repository.records.get(id)?.state).toBe("running");
      }
    });
  });

  it.effect("syncs records with what the provider reports and fills their cost", () => {
    const environmentId = (digit: string) =>
      EnvironmentId.make(
        `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`,
      );
    const base = {
      provider: "boat",
      label: "Synced sandbox",
      size: "small",
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
      httpBaseUrl: "https://boat.example/t3",
      runningSince: null,
      maxRunningMinutes: 480,
    } as const;
    const records = {
      stoppedOutside: {
        ...base,
        instanceId: environmentId("1"),
        environmentId: environmentId("1"),
        sandboxId: "bx_stopped",
        state: "running",
      },
      diskExpired: {
        ...base,
        instanceId: environmentId("2"),
        environmentId: environmentId("2"),
        sandboxId: "bx_expired",
        state: "stopped",
      },
      unreachable: {
        ...base,
        instanceId: environmentId("3"),
        environmentId: environmentId("3"),
        sandboxId: "bx_unreach",
        state: "running",
      },
      gone: {
        ...base,
        instanceId: environmentId("4"),
        environmentId: environmentId("4"),
        sandboxId: "bx_gone",
        state: "stopped",
      },
      // The machine runs but T3 did not start on it; "running" would hide that.
      notServing: {
        ...base,
        instanceId: environmentId("5"),
        environmentId: environmentId("5"),
        sandboxId: "bx_errored",
        state: "error",
      },
      resumedMeanwhile: {
        ...base,
        instanceId: environmentId("6"),
        environmentId: environmentId("6"),
        sandboxId: "bx_raced",
        state: "running",
      },
    } satisfies Record<string, SandboxRecord>;
    const repository = memoryRepository(Object.values(records));
    const requests: Array<string> = [];
    const respond = (request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status })));
    const client = HttpClient.make((request) => {
      const query = UrlParams.toString(request.urlParams);
      requests.push(`${request.method} ${request.url}${query === "" ? "" : `?${query}`}`);
      const id = request.url.split("/").at(-1);
      if (request.url.endsWith("/sandboxes")) {
        return respond(request, {
          sandboxes: [
            {
              id: "bx_stopped",
              cost: { since: "1970-01-01T00:00:00.000Z", seconds: 60, dollars: 0.42 },
            },
            {
              id: "bx_unreach",
              cost: { since: "1970-01-01T00:00:00.000Z", seconds: 90, dollars: 1.5 },
            },
          ],
        });
      }
      switch (id) {
        case "bx_stopped":
          return respond(request, { sandbox: { id, state: "archived", dataExpiredAt: null } });
        case "bx_expired":
          return respond(request, {
            sandbox: { id, state: "archived", dataExpiredAt: "1970-01-01T00:00:00.000Z" },
          });
        case "bx_unreach":
          return respond(request, { ok: false, code: "internal_error" }, 503);
        case "bx_gone":
          return respond(request, { ok: false, code: "not_found" }, 404);
        case "bx_errored":
          return respond(request, { sandbox: { id, state: "ready" } });
        case "bx_raced":
          // The provider auto-stopped it, and the user resumes it while this read is in flight.
          repository.records.set(records.resumedMeanwhile.instanceId, {
            ...records.resumedMeanwhile,
            state: "running",
            updatedAt: "1970-01-01T00:00:30.000Z",
          });
          return respond(request, { sandbox: { id, state: "archived" } });
      }
      return respond(request, { ok: true });
    });
    return Effect.gen(function* () {
      const swept = yield* SandboxProvisioner.SandboxProvisioner.pipe(
        Effect.flatMap((provisioner) =>
          provisioner.sweep.pipe(
            Effect.andThen(
              provisioner.delete({
                provider: "boat",
                sandboxId: records.gone.sandboxId,
                instanceId: records.gone.instanceId,
              }),
            ),
          ),
        ),
        Effect.provide(
          provisionerLayer(
            { sandboxProviders: { boat: { apiKey: "boat_test" } } },
            repository.layer,
          ),
        ),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.forkChild,
      );
      // The unreachable provider's status read is sent again before the sweep gives up on it.
      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(swept);

      const stateOf = (record: SandboxRecord) => repository.records.get(record.instanceId)?.state;
      expect(stateOf(records.stoppedOutside)).toBe("stopped");
      expect(stateOf(records.diskExpired)).toBe("expired");
      // An unreachable provider says nothing about the machine.
      expect(stateOf(records.unreachable)).toBe("running");
      expect(stateOf(records.notServing)).toBe("error");
      expect(repository.byEnvironment(records.resumedMeanwhile.environmentId)).toMatchObject({
        state: "running",
        updatedAt: "1970-01-01T00:00:30.000Z",
      });
      expect(repository.byEnvironment(records.stoppedOutside.environmentId)).toMatchObject({
        costDollars: 0.42,
        costSince: "1970-01-01T00:00:00.000Z",
      });
      // Cost alone is not a lifecycle change.
      expect(repository.byEnvironment(records.unreachable.environmentId)).toMatchObject({
        costDollars: 1.5,
        updatedAt: "1970-01-01T00:00:00.000Z",
      });
      // The 404 record was marked deleted, so deleting it only drops the record.
      expect(repository.byEnvironment(records.gone.environmentId) !== undefined).toBe(false);
      expect(requests.filter((request) => request.startsWith("DELETE"))).toEqual([]);
      expect(requests.filter((request) => request.includes("include=cost"))).toEqual([
        "GET https://boat.dev/api/v1/sandboxes?include=cost&label=t3.code%2Frole%3Denvironment&limit=200",
      ]);
      // One status read per record, and three more for the one that kept failing.
      expect(requests.filter((request) => /\/sandboxes\/bx_/.test(request))).toHaveLength(9);
    });
  });
  const runningRecord: SandboxRecord = {
    instanceId: testEnvironmentId,
    environmentId: testEnvironmentId,
    provider: "boat",
    sandboxId: boatSandboxId,
    label: "Prepared sandbox",
    size: "large",
    state: "running",
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
    httpBaseUrl: "https://boat.example/t3",
    runningSince: null,
    maxRunningMinutes: 480,
  };

  // Boat as the save sees it: archived only after `/stop`, the saved snapshot `saving` until its
  // second poll, and a fresh environment id once T3's state is gone.
  const templateClient = (
    requests: Array<string>,
    options: {
      readonly saveStatus?: "ready" | "failed";
      readonly commands?: Array<string>;
      /** `GET /limits` answers with this; without it the provider fails to report limits. */
      readonly limits?: () => unknown;
    } = {},
  ) => {
    let stopped = false;
    let scrubbed = false;
    let polls = 0;
    const json = (request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status })));
    return HttpClient.make((request) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.url.endsWith("/limits")) {
        const limits = options.limits?.();
        return limits === undefined ? json(request, { ok: false }, 401) : json(request, limits);
      }
      if (request.url.endsWith("/commands")) {
        const command =
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body)).command
            : "";
        options.commands?.push(command);
        if (command.includes("rm -rf")) scrubbed = true;
        return json(request, { exitCode: 0, stdout: "", stderr: "" });
      }
      if (request.url.endsWith("/stop")) {
        stopped = true;
        return json(request, { ok: true });
      }
      if (request.url.endsWith("/resume")) {
        stopped = false;
        return json(request, { ok: true });
      }
      if (request.url.endsWith(`/sandboxes/${boatSandboxId}`) && request.method === "GET") {
        return json(request, {
          sandbox: { id: boatSandboxId, state: stopped ? "archived" : "ready" },
        });
      }
      if (request.url.endsWith("/saved-snapshots") && request.method === "POST") {
        return json(request, { ok: true, status: "saving" }, 202);
      }
      if (request.url.endsWith("/saved-snapshots/web-stack")) {
        polls += 1;
        return json(request, {
          snapshot: {
            name: "web-stack",
            status: polls < 2 ? "saving" : (options.saveStatus ?? "ready"),
            type: "large",
            sizeBytes: 1024,
            createdAt: "2026-10-31T00:00:00.000Z",
            ...(options.saveStatus === "failed" ? { error: "disk read failed" } : {}),
          },
        });
      }
      if (request.url.endsWith("/.well-known/t3/environment")) {
        return json(request, {
          ...descriptor,
          ...(scrubbed ? { environmentId: "33333333-3333-4333-8333-333333333333" } : {}),
        });
      }
      return json(request, { ok: true });
    });
  };

  it.effect("resets T3, stops, and saves a sandbox as a template, then deletes the source", () => {
    const requests: Array<string> = [];
    const commands: Array<string> = [];
    const repository = memoryRepository([runningRecord]);
    let limits: unknown = trialLimits;
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      // A plan that cannot save is refused before anything on the machine changes.
      const refused = yield* provisioner
        .saveTemplate({ instanceId: testEnvironmentId, name: "web-stack" })
        .pipe(Effect.flip);
      expect(refused.code).toBe("templates_unavailable");
      expect(requests).toEqual(["GET https://boat.dev/api/v1/limits"]);
      limits = undefined;
      requests.length = 0;

      const fiber = yield* provisioner
        .saveTemplate({ instanceId: testEnvironmentId, name: "web-stack" })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      const saved = yield* Fiber.join(fiber);

      expect(saved.template).toEqual({
        name: "web-stack",
        createdAt: "2026-10-31T00:00:00.000Z",
        sizeBytes: 1024,
        size: "large",
      });
      // The snapshot copies the disk, so T3's identity and sessions are gone before the stop that
      // the save captures, and the save waits for the stop to finish.
      expect(requests).toEqual([
        "GET https://boat.dev/api/v1/limits",
        `POST https://boat.dev/api/v1/sandboxes/${boatSandboxId}/commands`,
        `POST https://boat.dev/api/v1/sandboxes/${boatSandboxId}/stop`,
        `GET https://boat.dev/api/v1/sandboxes/${boatSandboxId}`,
        "POST https://boat.dev/api/v1/saved-snapshots",
        "GET https://boat.dev/api/v1/saved-snapshots/web-stack",
        "GET https://boat.dev/api/v1/saved-snapshots/web-stack",
        `DELETE https://boat.dev/api/v1/sandboxes/${boatSandboxId}`,
      ]);
      expect(commands[0]).toContain("t3 service uninstall");
      expect(commands[0]).toContain(`rm -rf "$HOME/.t3/userdata" "$HOME/.t3/environment-label"`);
      expect(commands[0]).not.toContain("pkill");
      // Without its T3 identity the source could only come back as a different environment.
      expect(repository.byEnvironment(testEnvironmentId) !== undefined).toBe(false);
    }).pipe(
      Effect.provide(
        provisionerLayer({ sandboxProviders: { boat: { apiKey: "boat_test" } } }, repository.layer),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        templateClient(requests, { commands, limits: () => limits }),
      ),
    );
  });

  it.effect("keeps the source when the save fails and refuses to resume it as itself", () => {
    const requests: Array<string> = [];
    const repository = memoryRepository([runningRecord]);
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      const fiber = yield* provisioner
        .saveTemplate({ instanceId: testEnvironmentId, name: "web-stack" })
        .pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      const failure = yield* Fiber.join(fiber);

      expect(failure.stage).toBe("template");
      expect(failure.detail).toBe(
        "Boat could not save the template. T3 Code on this sandbox was already reset, so it cannot reconnect. Delete it.",
      );
      expect(failure.message).not.toContain("disk read failed");
      expect(requests.some((request) => request.startsWith("DELETE"))).toBe(false);
      expect(repository.byEnvironment(testEnvironmentId)?.state).toBe("stopped");

      // A resumed source answers with a new id that no client holds a session for.
      const resumeFiber = yield* provisioner
        .resume({ instanceId: testEnvironmentId })
        .pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      const resumeFailure = yield* Fiber.join(resumeFiber);
      expect(resumeFailure.detail).toContain("cannot reconnect as this environment");
      expect(repository.byEnvironment(testEnvironmentId)?.state).toBe("error");
    }).pipe(
      Effect.provide(
        provisionerLayer({ sandboxProviders: { boat: { apiKey: "boat_test" } } }, repository.layer),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        templateClient(requests, { saveStatus: "failed" }),
      ),
    );
  });

  it.effect(
    "starts from a template, and destroys a copy that answers as a known environment",
    () => {
      const requests: Array<string> = [];
      const bodies: Array<{ readonly url: string; readonly body: unknown }> = [];
      let environmentId: string = testEnvironmentId;
      const repository = memoryRepository([runningRecord]);
      const client = HttpClient.make((request) => {
        requests.push(`${request.method} ${request.url}`);
        if (request.body._tag === "Uint8Array") {
          bodies.push({
            url: request.url,
            body: JSON.parse(new TextDecoder().decode(request.body.body)),
          });
        }
        const json = (body: unknown) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body)));
        if (request.url.endsWith("/saved-snapshots")) {
          return json({
            snapshots: [
              { name: "web-stack", status: "ready", type: "large", sourceSandboxId: "bx_x" },
            ],
          });
        }
        if (request.method === "POST" && request.url.endsWith("/sandboxes")) {
          return Effect.succeed(boatResponse(request));
        }
        if (request.url.endsWith("/.well-known/t3/environment")) {
          return json({ ...descriptor, environmentId });
        }
        if (request.method === "GET" && request.url.endsWith(`/sandboxes/${boatSandboxId}`)) {
          return json({ sandbox: { id: boatSandboxId, state: "ready" } });
        }
        if (request.url.endsWith("/host")) {
          return json({ url: "https://boat.example/t3" });
        }
        if (request.url.endsWith("/commands")) {
          return json({
            exitCode: 0,
            stdout: pairOr(bodyTextOf(request), "pair_tpl", ""),
            stderr: "",
          });
        }
        return json({ ok: true });
      });
      return Effect.gen(function* () {
        const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
        const collision = yield* provisioner
          .create({ provider: "boat", template: "web-stack", size: "small" })
          .pipe(Effect.flip);
        expect(collision.stage).toBe("pair");
        expect(collision.detail).toContain("already exists");
        // Never paired: the destroy follows the identity check directly.
        expect(requests.slice(-2)).toEqual([
          "GET https://boat.example/t3/.well-known/t3/environment",
          `DELETE https://boat.dev/api/v1/sandboxes/${boatSandboxId}`,
        ]);

        environmentId = "44444444-4444-4444-8444-444444444444";
        const created = yield* provisioner.create({ provider: "boat", template: "web-stack" });
        const createBody = bodies.findLast((entry) => entry.url.endsWith("/sandboxes"))?.body;
        // The template carries its size; sending `type` could ask for a smaller disk than it holds.
        expect(createBody).toMatchObject({ from: "web-stack", noEnv: true });
        expect(createBody).not.toHaveProperty("type");
        // Boat relays a copy's port to loopback only once it is hosted again on the running machine.
        expect(bodies.findLast((entry) => entry.url.endsWith("/host"))?.body).toMatchObject({
          port: 3773,
          public: true,
          localhost: true,
        });
        expect(repository.byEnvironment(created.environmentId)).toMatchObject({
          template: "web-stack",
          size: "large",
        });

        const missing = yield* provisioner
          .create({ provider: "boat", template: "gone" })
          .pipe(Effect.flip);
        expect(missing.code).toBe("not_found");
        expect(requests.at(-1)).toBe("GET https://boat.dev/api/v1/saved-snapshots");
      }).pipe(
        Effect.provide(
          provisionerLayer(
            { sandboxProviders: { boat: { apiKey: "boat_test" } } },
            repository.layer,
          ),
        ),
        Effect.provideService(HttpClient.HttpClient, client),
      );
    },
  );
});

describe("SandboxProvisioner", () => {
  it.effect("pairs a freshly created Boat sandbox and saves the API key", () => {
    let commandCall = 0;
    const requests: Array<string> = [];
    const idempotencyKeys: Array<string | undefined> = [];
    const token = "7KQ2M9XRTW4H";
    // Boat keeps every command's text and output for 90 days.
    const keptByBoat: Array<string> = [];
    const printed: Array<string> = [];
    const client = HttpClient.make((request) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.url.endsWith("/limits")) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({ ok: false }, { status: 401 })),
        );
      }
      if (request.method === "POST" && request.url.endsWith("/sandboxes")) {
        idempotencyKeys.push(request.headers["idempotency-key"]);
        return Effect.succeed(boatResponse(request));
      }
      if (request.url.endsWith("/.well-known/t3/environment")) {
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(descriptor)));
      }
      if (request.url.endsWith("/commands")) {
        commandCall += 1;
        const command =
          request.body._tag === "Uint8Array"
            ? (JSON.parse(new TextDecoder().decode(request.body.body)) as { command: string })
                .command
            : "";
        // The pair step really runs, so what it prints is what Boat would keep.
        const result =
          commandCall === 1
            ? { exitCode: 0, stdout: "t3 is running", stderr: "" }
            : commandCall === 2
              ? // Boat's image ships every tool, so nothing is installed or missing.
                { exitCode: 0, stdout: "T3_TOOLS_MISSING: \n", stderr: "" }
              : commandCall === 3
                ? { exitCode: 0, stdout: "", stderr: "" }
                : runWithStubT3(command, token);
        keptByBoat.push(command, result.stdout, result.stderr);
        printed.push(result.stdout, result.stderr);
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(result)));
      }
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({})));
    });

    return Effect.gen(function* () {
      const { result, providers } = yield* SandboxProvisioner.SandboxProvisioner.pipe(
        Effect.flatMap((provisioner) =>
          Effect.gen(function* () {
            const created = yield* provisioner.create({
              provider: "boat",
              apiKey: "boat_saved",
              label: "My sandbox",
            });
            return { result: created, providers: yield* provisioner.providers };
          }),
        ),
        Effect.provide(testLayer),
        Effect.provideService(HttpClient.HttpClient, client),
      );

      expect(result).toEqual({
        instanceId: expect.any(String),
        provider: "boat",
        sandboxId: boatSandboxId,
        environmentId: testEnvironmentId,
        label: "My sandbox",
        httpBaseUrl: "https://boat.example/t3",
        pairingCode: token,
        setup: { claude: "skipped", github: "skipped", tailscale: "skipped", warnings: [] },
      });
      // The token reaches this server and nothing the provider keeps, the QR code's URL included.
      expect(keptByBoat.filter((text) => text.includes(token))).toEqual([]);
      expect(printed.filter((text) => /Token:|Pairing URL:|█/u.test(text))).toEqual([]);
      expect(providers.providers.find((provider) => provider.kind === "boat")?.configured).toBe(
        true,
      );
      // Limits that cannot be read never block a start; the provider stays the authority. T3 is
      // installed, the tools are checked, T3 starts, and the environment's identity is checked
      // before a pairing code is minted on it.
      expect(requests).toEqual([
        "GET https://boat.dev/api/v1/limits",
        "POST https://boat.dev/api/v1/sandboxes",
        `POST https://boat.dev/api/v1/sandboxes/${boatSandboxId}/commands`,
        `POST https://boat.dev/api/v1/sandboxes/${boatSandboxId}/commands`,
        `POST https://boat.dev/api/v1/sandboxes/${boatSandboxId}/commands`,
        "GET https://boat.example/t3/.well-known/t3/environment",
        `POST https://boat.dev/api/v1/sandboxes/${boatSandboxId}/commands`,
      ]);
      expect(idempotencyKeys).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/u)]);
    });
  });

  it.effect("saves a provider's settings fields with its key and passes them to the driver", () => {
    const requests: Array<{
      method: string;
      url: string;
      body: unknown;
      authorization?: string | undefined;
    }> = [];
    const repository = memoryRepository();
    const client = recording(requests, (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v2/teams/acme" || url.pathname === "/v2/teams/team_1") {
        return Response.json(vercelTeam("pro"));
      }
      if (url.pathname === "/v2/teams/beta") {
        return Response.json({ ...vercelTeam("pro"), id: "team_2", slug: "beta" });
      }
      if (url.pathname === "/v2/teams") return Response.json({ teams: [vercelTeam("pro")] });
      if (url.pathname === "/.well-known/t3/environment") return Response.json(descriptor);
      if (url.pathname.endsWith("/cmd")) {
        return ndjson([
          { data: pairOr(bodyTextOf(request), "pair_vercel", ""), stream: "stdout" },
          vercelCommand(0),
        ]);
      }
      if (url.pathname === "/v2/sandboxes" && request.method === "GET") {
        return Response.json({ sandboxes: [] });
      }
      return Response.json(vercelSandbox());
    });
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      yield* provisioner.templates({ provider: "vercel" });
      // The saved Team reaches the driver without the client sending it again.
      expect(requests[0]).toMatchObject({
        url: "https://api.vercel.com/v2/teams/acme",
        authorization: "Bearer vcp_saved",
      });

      requests.length = 0;
      const created = yield* provisioner.create({
        provider: "vercel",
        settings: { teamId: "", projectId: " mine ", unknown: "ignored" },
      });
      expect(created.pairingCode).toBe("pair_vercel");
      // A cleared Team falls back to the token's only team, and the saved key is kept.
      expect(requests[0]).toMatchObject({
        url: "https://api.vercel.com/v2/teams?limit=20",
        authorization: "Bearer vcp_saved",
      });
      expect(requests.find((request) => request.url.includes("/v4/sandboxes"))?.body).toMatchObject(
        { projectId: "mine" },
      );
      const vercel = (yield* provisioner.providers).providers.find(
        (provider) => provider.kind === "vercel",
      );
      expect(vercel).toMatchObject({
        configured: true,
        settings: { teamId: "", projectId: "mine" },
      });
      expect(vercel?.settingsFields?.map((field) => field.id)).toEqual(["teamId", "projectId"]);

      // The record keeps the team the driver detected, so a later Team change cannot strand it.
      // A record from before records kept settings follows the current ones.
      const record = repository.byEnvironment(testEnvironmentId)!;
      expect(record.providerSettings).toEqual({ teamId: "team_1", projectId: "mine" });
      const { providerSettings: _, ...legacy } = record;
      const legacyId = EnvironmentId.make("22222222-2222-4222-8222-222222222222");
      repository.records.set(legacyId, { ...legacy, environmentId: legacyId, sandboxId: "legacy" });
      yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
        sandboxProviders: {
          vercel: { apiKey: "vcp_saved", settings: { teamId: "beta", projectId: "other" } },
        },
      });
      requests.length = 0;
      yield* provisioner.sweep;
      expect(requests.map((request) => request.url)).toEqual(
        expect.arrayContaining([
          "https://api.vercel.com/v2/sandboxes/box-attempt1?teamId=team_1&projectId=mine",
          "https://api.vercel.com/v2/sandboxes/legacy?teamId=team_2&projectId=other",
        ]),
      );
      expect(repository.byEnvironment(testEnvironmentId)?.state).toBe("running");
    }).pipe(
      Effect.provide(
        provisionerLayer(
          { sandboxProviders: { vercel: { apiKey: "vcp_saved", settings: { teamId: "acme" } } } },
          repository.layer,
        ),
      ),
      Effect.provideService(HttpClient.HttpClient, client),
    );
  });

  it.effect("starts t3 serve with the driver's serve environment only for Daytona", () => {
    const commands: Array<{ provider: string; command: string }> = [];
    const bodyOf = (request: HttpClientRequest.HttpClientRequest) =>
      request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
    const client = HttpClient.make((request) => {
      const reply = (value: unknown) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(value)));
      if (request.url.endsWith("/.well-known/t3/environment")) return reply(descriptor);
      if (request.url.startsWith("https://boat.dev/")) {
        if (request.url.endsWith("/limits")) return reply(boatLimitsFixture());
        if (request.url.endsWith("/sandboxes")) return Effect.succeed(boatResponse(request));
        commands.push({ provider: "boat", command: JSON.parse(bodyOf(request)).command });
        return reply({ exitCode: 0, stdout: pairOr(bodyOf(request), "pair_boat", ""), stderr: "" });
      }
      if (request.url.endsWith("/toolbox-proxy-url")) {
        return reply({ url: "https://toolbox.example/toolbox" });
      }
      if (request.url.endsWith("/ports/3773/preview-url")) {
        return reply({ url: "https://3773-sandbox_1.proxy.daytona.works" });
      }
      if (request.url.endsWith("/process/execute")) {
        commands.push({ provider: "daytona", command: JSON.parse(bodyOf(request)).command });
        return reply({ exitCode: 0, result: pairOr(bodyOf(request), "pair_daytona", "") });
      }
      return reply({ id: "sandbox_1", name: "Daytona sandbox", state: "started" });
    });

    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      yield* provisioner.create({ provider: "daytona", apiKey: "dtn_test" });
      yield* provisioner.create({ provider: "boat", apiKey: "boat_test" });

      const startOf = (provider: string) =>
        commands.find((entry) => entry.provider === provider && entry.command.includes("nohup "))
          ?.command ?? "";
      const serveLine = (provider: string) =>
        startOf(provider)
          .split("\n")
          .find((line) => line.trimStart().startsWith("nohup "));
      // Daytona's preview proxy answers CORS, so the server must not add a second origin header,
      // and the service unit cannot carry that variable.
      expect(serveLine("daytona")).toContain("env T3CODE_PROXY_HANDLES_CORS='true' t3 serve");
      expect(startOf("daytona")).not.toContain("t3 service install");
      // Boat's hosted port does not touch CORS, so its server keeps answering it.
      expect(serveLine("boat")).toContain("nohup t3 serve");
      expect(serveLine("boat")).not.toContain("T3CODE_PROXY_HANDLES_CORS");

      // A server that never answers gets its log's tail reported, minus what headless serve
      // prints to pair with it, since providers keep the output.
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-serve-stub-"));
      try {
        const bin = NodePath.join(home, ".local", "bin");
        NodeFS.mkdirSync(bin, { recursive: true });
        NodeFS.mkdirSync(NodePath.join(home, ".t3"));
        const stubs = {
          t3: `[ "$1" = serve ] || exit 1
printf '%s\\n' 'listen EADDRINUSE 0.0.0.0:3773' 'Token: 7KQ2M9XRTW4H' 'Pairing URL: http://h/pair#token=7KQ2M9XRTW4H' 'App link: t3code://pair?url=x' '█▀▀▀▀▀█ ▄▀▄'`,
          curl: "exit 7",
          sleep: "exit 0",
        };
        for (const [name, body] of Object.entries(stubs)) {
          NodeFS.writeFileSync(NodePath.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
        }
        const started = NodeChildProcess.spawnSync("sh", ["-c", startOf("boat")], {
          env: { PATH: `${bin}:${HOST_PATH}`, HOME: home },
          encoding: "utf8",
        });
        expect(started.status).toBe(1);
        expect(`${started.stdout}${started.stderr}`.trim()).toBe("listen EADDRINUSE 0.0.0.0:3773");
      } finally {
        NodeFS.rmSync(home, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(testLayer), Effect.provideService(HttpClient.HttpClient, client));
  });

  it.effect("deletes the sandbox when the public port cannot be exposed", () => {
    const requests: Array<string> = [];
    const client = HttpClient.make((request) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.method === "POST" && request.url.endsWith("/sandboxes")) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ ok: true, sandbox: { id: boatSandboxId, name: "Boat sandbox" } }),
          ),
        );
      }
      if (request.method === "GET" && request.url.endsWith(`/sandboxes/${boatSandboxId}`)) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ sandbox: { id: boatSandboxId, state: "ready" } }),
          ),
        );
      }
      if (request.url.endsWith("/host")) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ error: "no ports left" }, { status: 503 }),
          ),
        );
      }
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({})));
    });

    return Effect.gen(function* () {
      const error = yield* SandboxProvisioner.SandboxProvisioner.pipe(
        Effect.flatMap((provisioner) =>
          provisioner.create({ provider: "boat", apiKey: "boat_test" }),
        ),
        Effect.provide(testLayer),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
      );

      expect(error._tag).toBe("SandboxProviderError");
      if (error._tag !== "SandboxProviderError") return;
      expect(error.stage).toBe("expose");
      // A machine that could not be reached must not keep billing.
      expect(requests.at(-1)).toBe(`DELETE https://boat.dev/api/v1/sandboxes/${boatSandboxId}`);
    });
  });

  it.effect("deletes the sandbox when pairing fails", () => {
    const requests: Array<string> = [];
    const deleteHeaders: Array<string | undefined> = [];
    const client = HttpClient.make((request) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.method === "DELETE") {
        deleteHeaders.push(request.headers["x-ascii-confirm-delete"]);
      }
      if (request.method === "POST" && request.url.endsWith("/sandboxes")) {
        return Effect.succeed(boatResponse(request));
      }
      if (request.url.endsWith("/commands")) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ exitCode: 0, stdout: "", stderr: "" }),
          ),
        );
      }
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({})));
    });

    return Effect.gen(function* () {
      const error = yield* SandboxProvisioner.SandboxProvisioner.pipe(
        Effect.flatMap((provisioner) =>
          provisioner.create({ provider: "boat", apiKey: "boat_test" }),
        ),
        Effect.provide(testLayer),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
      );

      expect(error._tag).toBe("SandboxProviderError");
      if (error._tag !== "SandboxProviderError") return;
      expect(error.stage).toBe("pair");
      expect(requests.at(-1)).toBe(`DELETE https://boat.dev/api/v1/sandboxes/${boatSandboxId}`);
      // Boat refuses to delete without this confirmation header.
      expect(deleteHeaders).toEqual([boatSandboxId]);
    });
  });
});

describe("sandbox agent access", () => {
  const hubSettings = {
    usageLimitSources: {
      hub: {
        kind: "cliproxy",
        url: "https://hub.test",
        managementKey: "mgmt-secret",
        enabled: true,
      },
    },
  } as const;
  const host = {
    claude: { baseUrl: "https://api.example.test", authToken: Redacted.make("host-claude-token") },
    githubToken: "ghp_host_token",
    gitIdentity: { name: "Ada Lovelace", email: "ada@example.test" },
  };
  const noTooling = {
    northflank: false,
    maple: false,
    railway: false,
    tooling: { claudeMd: false, skills: [], mcpServers: [] },
  };
  const HUB_KEY = /^t3-sandbox-web-stack-[0-9a-f]{16}$/u;
  const TS_CLIENT_SECRET = "tskey-client-kSECRET-oauth";
  const TS_ACCESS_TOKEN = "tskey-api-ACCESS-token";
  const TS_AUTH_KEY = "tskey-auth-kEPHEMERAL-key";
  const tailnetSettings = {
    ...hubSettings,
    sandboxTailscale: {
      clientId: "kCLIENT",
      clientSecret: TS_CLIENT_SECRET,
      tag: "tag:t3-sandbox",
    },
  } as const;
  // Boat keeps every command's text, so a secret must not be in it, not even base64-encoded.
  const revealsSecret = (commands: ReadonlyArray<string>, secret: string) =>
    commands.some((command) =>
      [command, ...(command.match(/[A-Za-z0-9+/=]{12,}/gu) ?? [])]
        .map((run) => (run === command ? run : Buffer.from(run, "base64").toString("utf8")))
        .some((candidate) => candidate.includes(secret)),
    );

  // A Boat account plus a CLIProxyAPI hub. `failCommand` fails the steps whose script contains it;
  // the options are read on every request, so a test can change them between creates.
  const agentClient = (
    requests: Array<{ method: string; url: string; body: unknown; auth?: string | undefined }>,
    options: {
      failCommand?: string | undefined;
      hubStatus?: number;
      missingTools?: string;
      endpointStatus?: string;
      /** tailscaled's state before a join; `Running` means a resumed sandbox is still connected. */
      tailnetIdleState?: string;
      tailnetMode?: "kernel" | "userspace";
      tailnetNode?: string;
      tokenStatus?: number;
      hubModels?: ReadonlyArray<string>;
    } = {},
  ) => {
    const commands: Array<string> = [];
    const files = new Map<string, string>();
    const client = recording(requests, (request) => {
      if (request.method === "PUT" && request.url.endsWith("/files")) {
        const file = decodeBody((request.body as { body: Uint8Array }).body) as {
          path: string;
          content: string;
        };
        files.set(file.path, file.content);
        return Response.json({ ok: true, path: file.path });
      }
      if (request.url.startsWith("https://hub.test/")) {
        return Response.json({ status: "ok" }, { status: options.hubStatus ?? 200 });
      }
      // Claude's endpoint is the hub's client API, which lists models for any key it accepts.
      if (request.url.endsWith("/v1/models") && options.hubModels !== undefined) {
        return Response.json({ object: "list", data: options.hubModels.map((id) => ({ id })) });
      }
      if (request.url === "https://api.tailscale.com/api/v2/oauth/token") {
        return Response.json(
          { access_token: TS_ACCESS_TOKEN, token_type: "Bearer", expires_in: 3600 },
          { status: options.tokenStatus ?? 200 },
        );
      }
      if (request.url === "https://api.tailscale.com/api/v2/tailnet/-/keys") {
        return Response.json({ id: "k123", key: TS_AUTH_KEY });
      }
      if (request.url.startsWith("https://api.tailscale.com/api/v2/device/")) {
        return new Response(null, { status: 200 });
      }
      if (request.url.endsWith("/resume")) return Response.json({ ok: true });
      if (request.method === "GET" && request.url.endsWith(`/sandboxes/${boatSandboxId}`)) {
        return Response.json({ sandbox: { id: boatSandboxId, state: "ready", error: null } });
      }
      if (request.url.endsWith("/limits")) return Response.json({}, { status: 401 });
      if (request.url.endsWith("/.well-known/t3/environment")) return Response.json(descriptor);
      if (request.method === "POST" && request.url.endsWith("/sandboxes")) {
        return Response.json({
          ok: true,
          sandbox: { id: boatSandboxId, name: "Web Stack" },
          hostedPorts: [{ port: 3773, url: "https://boat.example/t3" }],
        });
      }
      if (request.url.endsWith("/commands")) {
        const command = String(
          (
            JSON.parse(new TextDecoder().decode((request.body as { body: Uint8Array }).body)) as {
              command: string;
            }
          ).command,
        );
        commands.push(command);
        const failed = options.failCommand !== undefined && command.includes(options.failCommand);
        return Response.json({
          exitCode: failed ? 1 : 0,
          stdout: command.includes("t3 pair")
            ? pairOr(command, "pair_agent", "")
            : command.includes("T3_TAILSCALE_")
              ? [
                  "T3_TAILSCALE_DAEMON: nohup",
                  `T3_TAILSCALE_MODE: ${options.tailnetMode ?? "kernel"}`,
                  command.includes('--auth-key="file:')
                    ? `T3_TAILSCALE_STATE: Running\nT3_TAILSCALE_NODE: ${options.tailnetNode ?? "nNODE1CNTRL"}`
                    : `T3_TAILSCALE_STATE: ${options.tailnetIdleState ?? "NeedsLogin"}\nT3_TAILSCALE_NODE: `,
                ].join("\n")
              : command.includes("T3_TOOLS_MISSING")
                ? `T3_TOOLS_MISSING: ${options.missingTools ?? ""}\n`
                : command.includes("T3_ENDPOINT_STATUS")
                  ? `T3_ENDPOINT_STATUS:${options.endpointStatus ?? "200"}\n`
                  : "",
          // A failing step's output is the most likely place for a secret to leak from.
          stderr: failed ? command : "",
        });
      }
      return Response.json({});
    });
    // The secrets each command whose text contains `marker` read from the file it sources.
    const secretsOf = (marker: string) =>
      commands
        .filter((command) => command.includes(marker))
        .map((command) => {
          const path = /\. (\/tmp\/\S+)/u.exec(command)?.[1];
          const content = path === undefined ? "" : (files.get(path) ?? "");
          return Object.fromEntries(
            [...content.matchAll(/^export ([A-Z0-9_]+)='((?:[^']|'\\'')*)'$/gmu)].map((match) => [
              match[1]!,
              match[2]!.replaceAll("'\\''", "'"),
            ]),
          );
        });
    return { client, commands, secretsOf };
  };
  const claudeEnvOf = (secretsOf: (marker: string) => ReadonlyArray<Record<string, string>>) => {
    const value = secretsOf("T3_CLAUDE_ENV").find(
      (secrets) => secrets.T3_CLAUDE_ENV,
    )?.T3_CLAUDE_ENV;
    return value === undefined ? undefined : JSON.parse(value);
  };
  const joinKeyOf = (secretsOf: (marker: string) => ReadonlyArray<Record<string, string>>) =>
    secretsOf('--auth-key="file:').map((secrets) => secrets.T3_TAILSCALE_AUTH_KEY);

  it.effect("gives a sandbox its own hub key for Claude and revokes it when deleted", () => {
    const requests: Array<{ method: string; url: string; body: unknown; auth?: string }> = [];
    const { client, commands, secretsOf } = agentClient(requests);
    const repository = memoryRepository();
    const secrets = memorySecrets();
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      // Clients learn only the base URL and where the key comes from, never a key.
      expect((yield* provisioner.providers).host).toEqual({
        claude: { baseUrl: "https://api.example.test", key: "hub", privateNetwork: false },
        github: true,
        tailscale: false,
        ...noTooling,
      });

      const created = yield* provisioner.create({
        provider: "boat",
        apiKey: "boat_test",
        label: "Web Stack!",
        agentAccess: { claude: { baseUrl: "https://claude.example.test" } },
      });
      expect(created.setup).toEqual({
        claude: "ready",
        github: "skipped",
        tailscale: "skipped",
        warnings: [],
      });

      // The key is added before the machine exists, so a refusing hub costs nothing.
      const mint = requests.findIndex((request) => request.method === "PATCH");
      const sandboxCreate = requests.findIndex((request) => request.url.endsWith("/sandboxes"));
      expect(mint).toBeGreaterThanOrEqual(0);
      expect(mint).toBeLessThan(sandboxCreate);
      const key = (requests[mint]!.body as { new: string }).new;
      expect(key).toMatch(HUB_KEY);
      expect(requests[mint]).toMatchObject({
        url: "https://hub.test/v0/management/api-keys",
        body: { old: key, new: key },
        authorization: "Bearer mgmt-secret",
      });

      // Settings are written before T3 starts, and the key never travels in a command.
      expect(claudeEnvOf(secretsOf)).toEqual({
        ANTHROPIC_BASE_URL: "https://claude.example.test",
        ANTHROPIC_AUTH_TOKEN: key,
      });
      expect(revealsSecret(commands, key)).toBe(false);
      const settingsStep = commands.findIndex((command) => command.includes("T3_CLAUDE_ENV"));
      expect(settingsStep).toBeLessThan(commands.findIndex((command) => command.includes("nohup")));

      // The record says where the key lives; the key itself is a server secret.
      const record = repository.byEnvironment(testEnvironmentId)!;
      expect(record.claudeHubKey).toEqual({ sourceId: "hub", secret: expect.any(String) });
      expect(JSON.stringify(record)).not.toContain(key);
      expect(new TextDecoder().decode(secrets.values.get(record.claudeHubKey!.secret))).toBe(key);

      requests.length = 0;
      const deleted = yield* provisioner.delete({
        provider: "boat",
        sandboxId: boatSandboxId,
        instanceId: repository.byEnvironment(testEnvironmentId)?.instanceId,
      });
      expect(deleted).toEqual({ warnings: [] });
      expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        `DELETE https://boat.dev/api/v1/sandboxes/${boatSandboxId}`,
        `DELETE https://hub.test/v0/management/api-keys?value=${key}`,
      ]);
      expect(secrets.values.size).toBe(0);
    }).pipe(
      Effect.provide(
        provisionerLayer(hubSettings, repository.layer, { host, secrets: secrets.layer }),
      ),
      Effect.provideService(HttpClient.HttpClient, client),
    );
  });

  it.effect("sets up Pi with the hub's other models on the sandbox's own hub key", () => {
    const requests: Array<{
      method: string;
      url: string;
      body: unknown;
      authorization?: string | undefined;
    }> = [];
    const options: { hubModels: ReadonlyArray<string> } = {
      hubModels: ["claude-opus-5-5", "wafer/GLM-5.3", "GLM-5.3", "wafer/GLM-5.3-Flash"],
    };
    const { client, commands, secretsOf } = agentClient(requests, options);
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      // The form offers the models this machine's own key lists.
      expect((yield* provisioner.providers).host.piModels).toEqual([
        "wafer/GLM-5.3",
        "wafer/GLM-5.3-Flash",
      ]);

      requests.length = 0;
      const created = yield* provisioner.create({
        provider: "boat",
        apiKey: "boat_test",
        label: "Web Stack!",
        agentAccess: {
          claude: { baseUrl: "https://claude.example.test" },
          pi: { startModel: "wafer/GLM-5.3-Flash" },
        },
      });
      expect(created.setup.warnings).toEqual([]);
      const key = (requests.find((request) => request.method === "PATCH")!.body as { new: string })
        .new;
      // The list is read with the sandbox's key, so Pi gets exactly what that key reaches.
      expect(requests.filter((request) => request.url.endsWith("/v1/models"))).toEqual([
        expect.objectContaining({
          method: "GET",
          url: "https://claude.example.test/v1/models",
          authorization: `Bearer ${key}`,
        }),
      ]);
      const [setup] = secretsOf("T3_PI_PROVIDER");
      expect(JSON.parse(setup!.T3_PI_PROVIDER!)).toMatchObject({
        baseUrl: "https://claude.example.test/v1",
        apiKey: key,
        models: [{ id: "wafer/GLM-5.3" }, { id: "wafer/GLM-5.3-Flash" }],
      });
      expect(JSON.parse(setup!.T3_PI_CHOICE!)).toEqual({
        model: "wafer/GLM-5.3-Flash",
        t3Default: { instanceId: "pi", model: "hub/wafer/GLM-5.3-Flash" },
      });
      expect(revealsSecret(commands, key)).toBe(false);
      // Before T3 starts, so its first provider probe lists Pi.
      expect(commands.findIndex((command) => command.includes("T3_PI_PROVIDER"))).toBeLessThan(
        commands.findIndex((command) => command.includes("nohup")),
      );
      // The host's followed settings go first, without its secrets or its own paths, so Pi's
      // instance and default model are what the sandbox keeps.
      const [seed] = secretsOf("T3_SETTINGS_SEED");
      expect(JSON.parse(seed!.T3_SETTINGS_SEED!)).toEqual({ branchNamePrefix: "ada" });
      expect(revealsSecret(commands, "mgmt-secret")).toBe(false);
      expect(commands.findIndex((command) => command.includes("T3_SETTINGS_SEED"))).toBeLessThan(
        commands.findIndex((command) => command.includes("T3_PI_PROVIDER")),
      );

      // A hub that lists nothing else leaves the sandbox working, with Claude, and says why.
      options.hubModels = ["claude-opus-5-5"];
      commands.length = 0;
      const withoutPi = yield* provisioner.create({
        provider: "boat",
        apiKey: "boat_test",
        agentAccess: { claude: { baseUrl: "https://claude.example.test" }, pi: {} },
      });
      expect(withoutPi.setup.claude).toBe("ready");
      expect(withoutPi.setup.warnings).toEqual([
        "Your hub lists no models besides Claude's, so Pi was not set up on the sandbox.",
      ]);
      expect(commands.some((command) => command.includes("T3_PI_PROVIDER"))).toBe(false);
    }).pipe(
      Effect.provide(
        provisionerLayer(
          { ...hubSettings, branchNamePrefix: "ada", worktreesDirectory: "/Users/ada/trees" },
          undefined,
          { host },
        ),
      ),
      Effect.provideService(HttpClient.HttpClient, client),
    );
  });

  it.effect("refuses Pi before anything bills when there is no hub to give it a key", () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const { client } = agentClient(requests, { hubModels: ["wafer/GLM-5.3"] });
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      // Without a hub, the form has no models to offer.
      expect((yield* provisioner.providers).host).not.toHaveProperty("piModels");
      const error = yield* provisioner
        .create({
          provider: "boat",
          apiKey: "boat_test",
          agentAccess: { claude: { baseUrl: "https://api.example.test" }, pi: {} },
        })
        .pipe(Effect.flip);
      expect(error.stage).toBe("config");
      expect(error.detail).toContain("Pi uses the key each sandbox gets on your CLIProxyAPI hub");
      expect(requests.some((request) => request.url.endsWith("/sandboxes"))).toBe(false);
    }).pipe(
      Effect.provide(provisionerLayer({}, memoryRepository().layer, { host })),
      Effect.provideService(HttpClient.HttpClient, client),
    );
  });

  it.effect(
    "copies this machine's Claude token without a hub and signs GitHub in on request",
    () => {
      const requests: Array<{ method: string; url: string; body: unknown; auth?: string }> = [];
      const options: { failCommand?: string | undefined; missingTools?: string } = {};
      const { client, commands, secretsOf } = agentClient(requests, options);
      return Effect.gen(function* () {
        const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
        expect((yield* provisioner.providers).host).toEqual({
          claude: { baseUrl: "https://api.example.test", key: "copy", privateNetwork: false },
          github: true,
          tailscale: false,
          ...noTooling,
        });
        const created = yield* provisioner.create({
          provider: "boat",
          apiKey: "boat_test",
          agentAccess: { claude: { baseUrl: "https://api.example.test" } },
          passGithubToken: true,
        });
        expect(created.setup).toEqual({
          claude: "ready",
          github: "ready",
          tailscale: "skipped",
          warnings: [],
        });
        expect(requests.some((request) => request.url.startsWith("https://hub.test/"))).toBe(false);
        expect(claudeEnvOf(secretsOf)).toEqual({
          ANTHROPIC_BASE_URL: "https://api.example.test",
          ANTHROPIC_AUTH_TOKEN: "host-claude-token",
        });
        expect(secretsOf("gh auth login")).toEqual([{ T3_GITHUB_TOKEN: "ghp_host_token" }]);
        // Signed in, the agent can also commit: git gets this machine's name and email.
        const identity = commands.find((command) => command.includes("git config --global"));
        expect(identity).toContain("Ada Lovelace");
        expect(identity).toContain("ada@example.test");
        expect(revealsSecret(commands, "host-claude-token")).toBe(false);
        expect(revealsSecret(commands, "ghp_host_token")).toBe(false);

        // A login that fails leaves a working sandbox, and the warning carries none of its output.
        options.failCommand = "gh auth login";
        const failed = yield* provisioner.create({
          provider: "boat",
          apiKey: "boat_test",
          passGithubToken: true,
        });
        expect(failed.setup.github).toBe("failed");
        expect(failed.setup.warnings).toEqual([
          "GitHub could not be signed in on the sandbox. Run gh auth login in its terminal.",
        ]);

        // Tools that would not install are reported, and nothing that needs them is attempted.
        options.failCommand = undefined;
        options.missingTools = "gh claude ";
        commands.length = 0;
        const withoutTools = yield* provisioner.create({
          provider: "boat",
          apiKey: "boat_test",
          agentAccess: { claude: { baseUrl: "https://api.example.test" } },
          passGithubToken: true,
        });
        expect(withoutTools.setup).toEqual({
          claude: "failed",
          github: "failed",
          tailscale: "skipped",
          warnings: [
            "The GitHub CLI could not be installed on the sandbox.",
            "Claude Code could not be installed on the sandbox.",
          ],
        });
        expect(commands.some((command) => command.includes("gh auth login"))).toBe(false);
        const step = (marker: string) => commands.findIndex((command) => command.includes(marker));
        expect(step("T3_TOOLS_MISSING")).toBeLessThan(step("T3_CLAUDE_ENV"));
        expect(step("T3_CLAUDE_ENV")).toBeLessThan(step("nohup"));
      }).pipe(
        Effect.provide(provisionerLayer({}, discardingRepository, { host })),
        Effect.provideService(HttpClient.HttpClient, client),
      );
    },
  );

  it.effect("warns when the sandbox cannot reach Claude's endpoint and keeps its hub key", () => {
    const requests: Array<{ method: string; url: string; body: unknown; auth?: string }> = [];
    const options: { endpointStatus?: string } = { endpointStatus: "000" };
    const { client, commands } = agentClient(requests, options);
    const repository = memoryRepository();
    const tailnetHost = { ...host, claude: { ...host.claude, baseUrl: "https://100.92.23.53" } };
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      // The form warns before anything is created when the endpoint is only on a private network.
      expect((yield* provisioner.providers).host.claude?.privateNetwork).toBe(true);
      // The Tailscale setup prefills its access rule with this address.
      expect((yield* provisioner.providers).host.claude?.tailnetAddress).toBe("100.92.23.53");

      const create = (baseUrl: string) =>
        provisioner.create({
          provider: "boat",
          apiKey: "boat_test",
          label: "Web Stack",
          agentAccess: { claude: { baseUrl } },
        });
      const unreachable = yield* create("https://100.92.23.53");
      expect(unreachable.setup).toEqual({
        claude: "failed",
        github: "skipped",
        tailscale: "skipped",
        warnings: [
          "The sandbox cannot reach 100.92.23.53. It is only reachable from your private network or tailnet; let the sandbox join your tailnet, expose it publicly (for example with Tailscale Funnel or Cloudflare Tunnel), or use another endpoint.",
        ],
      });
      // The check runs after the settings are written and before T3 starts.
      const step = (marker: string) => commands.findIndex((command) => command.includes(marker));
      expect(step("T3_CLAUDE_ENV")).toBeLessThan(step("T3_ENDPOINT_STATUS"));
      expect(step("T3_ENDPOINT_STATUS")).toBeLessThan(step("nohup"));
      // The sandbox works, and fixing the network makes its key work as is.
      expect(requests.some((request) => request.method === "DELETE")).toBe(false);
      expect(repository.byEnvironment(testEnvironmentId)?.claudeHubKey).toBeDefined();

      yield* provisioner.delete({
        provider: "boat",
        sandboxId: boatSandboxId,
        instanceId: repository.byEnvironment(testEnvironmentId)?.instanceId,
      });
      const publicHost = yield* create("https://claude.example.test");
      expect(publicHost.setup.warnings).toEqual([
        "The sandbox cannot reach claude.example.test. Check that it accepts connections from the internet, or use another endpoint.",
      ]);

      // Any HTTP answer, even a refusal, means the endpoint is reachable.
      yield* provisioner.delete({
        provider: "boat",
        sandboxId: boatSandboxId,
        instanceId: repository.byEnvironment(testEnvironmentId)?.instanceId,
      });
      options.endpointStatus = "401";
      expect((yield* create("https://claude.example.test")).setup).toEqual({
        claude: "ready",
        github: "skipped",
        tailscale: "skipped",
        warnings: [],
      });
    }).pipe(
      Effect.provide(provisionerLayer(hubSettings, repository.layer, { host: tailnetHost })),
      Effect.provideService(HttpClient.HttpClient, client),
    );
  });

  it.effect("revokes the hub key and keeps every secret out of what a failure reports", () => {
    const requests: Array<{ method: string; url: string; body: unknown; auth?: string }> = [];
    const options: { failCommand?: string; hubStatus?: number } = {
      failCommand: "T3_CLAUDE_ENV",
    };
    const { client } = agentClient(requests, options);
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      // A Claude settings write that fails leaves a working sandbox and a warning.
      const created = yield* provisioner.create({
        provider: "boat",
        apiKey: "boat_test",
        label: "Web Stack",
        agentAccess: { claude: { baseUrl: "https://claude.example.test" } },
      });
      expect(created.setup.claude).toBe("failed");
      expect(created.setup.warnings).toHaveLength(1);
      const firstKey = (
        requests.find((request) => request.method === "PATCH")!.body as {
          new: string;
        }
      ).new;
      expect(created.setup.warnings.join(" ")).not.toContain(firstKey);

      // T3 failing to start after the key was added deletes the machine and revokes the key.
      requests.length = 0;
      options.failCommand = "nohup";
      const error = yield* Effect.flip(
        provisioner.create({
          provider: "boat",
          apiKey: "boat_test",
          label: "Web Stack",
          agentAccess: { claude: { baseUrl: "https://claude.example.test" } },
        }),
      );
      const key = (
        requests.find((request) => request.method === "PATCH")!.body as {
          new: string;
        }
      ).new;
      expect(key).toMatch(HUB_KEY);
      expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual(
        expect.arrayContaining([
          `DELETE https://boat.dev/api/v1/sandboxes/${boatSandboxId}`,
          `DELETE https://hub.test/v0/management/api-keys?value=${key}`,
        ]),
      );
      expect(error.detail).not.toContain(key);
      expect(error.detail).not.toContain("mgmt-secret");
      expect(error.message).not.toContain(key);

      // A hub that refuses the key fails the create before any machine is billed.
      requests.length = 0;
      options.hubStatus = 403;
      const refused = yield* Effect.flip(
        provisioner.create({
          provider: "boat",
          apiKey: "boat_test",
          agentAccess: { claude: { baseUrl: "https://claude.example.test" } },
        }),
      );
      expect(refused.detail).toBe(
        "Could not add a key for this sandbox on the CLIProxyAPI hub. The hub answered with HTTP 403.",
      );
      expect(requests.some((request) => request.url.endsWith("/sandboxes"))).toBe(false);
    }).pipe(
      Effect.provide(provisionerLayer(hubSettings, discardingRepository, { host })),
      Effect.provideService(HttpClient.HttpClient, client),
    );
  });

  const hubKeyFrom = (reference: string) =>
    ({
      usageLimitSources: {
        hub: {
          ...hubSettings.usageLimitSources.hub,
          managementKey: { provider: SecretProviderId.make("homelab"), reference },
        },
      },
    }) as const;

  it.effect(
    "mints and revokes a sandbox's hub key with a management key read from a secret",
    () => {
      const requests: Array<{
        method: string;
        url: string;
        body: unknown;
        authorization?: string;
      }> = [];
      const { client, secretsOf } = agentClient(requests);
      const repository = memoryRepository();
      const secrets = memorySecrets();
      return Effect.gen(function* () {
        const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
        expect((yield* provisioner.providers).host?.claude?.key).toBe("hub");
        yield* provisioner.create({
          provider: "boat",
          apiKey: "boat_test",
          label: "Web Stack",
          agentAccess: { claude: { baseUrl: "https://claude.example.test" } },
        });
        const mint = requests.find((request) => request.method === "PATCH")!;
        const key = (mint.body as { new: string }).new;
        expect(mint.authorization).toBe("Bearer resolved-mgmt-key");
        expect(claudeEnvOf(secretsOf)?.ANTHROPIC_AUTH_TOKEN).toBe(key);

        requests.length = 0;
        yield* provisioner.delete({
          provider: "boat",
          sandboxId: boatSandboxId,
          instanceId: repository.byEnvironment(testEnvironmentId)?.instanceId,
        });
        expect(
          requests.find((request) => request.url.startsWith("https://hub.test/")),
        ).toMatchObject({
          method: "DELETE",
          url: `https://hub.test/v0/management/api-keys?value=${key}`,
          authorization: "Bearer resolved-mgmt-key",
        });
      }).pipe(
        Effect.provide(
          provisionerLayer(hubKeyFrom("hub#key"), repository.layer, {
            host,
            secrets: secrets.layer,
          }),
        ),
        Effect.provideService(HttpClient.HttpClient, client),
      );
    },
  );

  it.effect(
    "fails a create instead of copying this machine's token when the hub key is unreadable",
    () => {
      const requests: Array<{ method: string; url: string; body: unknown; auth?: string }> = [];
      const { client, commands } = agentClient(requests);
      const secrets = memorySecrets();
      secrets.values.set("sandbox-hub-key-1", new TextEncoder().encode("t3-sandbox-web-stack-0"));
      const repository = memoryRepository([
        {
          instanceId: testEnvironmentId,
          environmentId: testEnvironmentId,
          provider: "boat",
          sandboxId: boatSandboxId,
          label: "Web Stack",
          size: "default",
          state: "deleted",
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
          httpBaseUrl: "https://boat.example/t3",
          runningSince: null,
          maxRunningMinutes: 480,
          claudeHubKey: { sourceId: "hub", secret: "sandbox-hub-key-1" },
        },
      ]);
      return Effect.gen(function* () {
        const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
        const error = yield* Effect.flip(
          provisioner.create({
            provider: "boat",
            apiKey: "boat_test",
            agentAccess: { claude: { baseUrl: "https://claude.example.test" } },
          }),
        );
        expect(error.detail).toBe(
          'Could not add a key for this sandbox on the CLIProxyAPI hub. Could not read the credential from the secret provider "homelab". Unlock or fix it in Settings, then try again.',
        );
        // Nothing is billed, and the host's Claude token goes nowhere.
        expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
          "GET https://boat.dev/api/v1/limits",
        ]);
        expect(commands).toEqual([]);

        requests.length = 0;

        // A delete still goes through and names the key left on the hub.
        const deleted = yield* provisioner.delete({
          provider: "boat",
          sandboxId: boatSandboxId,
          instanceId: repository.byEnvironment(testEnvironmentId)?.instanceId,
        });
        expect(requests).toEqual([]);
        expect(repository.records.size).toBe(0);
        expect(deleted.warnings).toEqual([
          "The key T3 Code added for Web Stack on the CLIProxyAPI hub could not be revoked. Remove the key starting with t3-sandbox-web-stack- from the hub.",
        ]);
      }).pipe(
        Effect.provide(
          provisionerLayer(hubKeyFrom("missing#key"), repository.layer, {
            host,
            secrets: secrets.layer,
          }),
        ),
        Effect.provideService(HttpClient.HttpClient, client),
      );
    },
  );

  it.effect("deletes a sandbox whose hub key cannot be revoked and says so", () => {
    const requests: Array<{ method: string; url: string; body: unknown; auth?: string }> = [];
    const secrets = memorySecrets();
    secrets.values.set("sandbox-hub-key-1", new TextEncoder().encode("t3-sandbox-web-stack-0"));
    const record: SandboxRecord = {
      instanceId: testEnvironmentId,
      environmentId: testEnvironmentId,
      provider: "boat",
      sandboxId: boatSandboxId,
      label: "Web Stack",
      size: "default",
      // Deleted outside T3: the provider is skipped, but its key is still on the hub.
      state: "deleted",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      httpBaseUrl: "https://boat.example/t3",
      runningSince: null,
      maxRunningMinutes: 480,
      claudeHubKey: { sourceId: "hub", secret: "sandbox-hub-key-1" },
    };
    const repository = memoryRepository([record]);
    const { client } = agentClient(requests, { hubStatus: 500 });
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      const deleted = yield* provisioner.delete({
        provider: "boat",
        sandboxId: boatSandboxId,
        instanceId: repository.byEnvironment(testEnvironmentId)?.instanceId,
      });
      expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        "DELETE https://hub.test/v0/management/api-keys?value=t3-sandbox-web-stack-0",
      ]);
      expect(repository.records.size).toBe(0);
      expect(deleted.warnings).toEqual([
        "The key T3 Code added for Web Stack on the CLIProxyAPI hub could not be revoked. Remove the key starting with t3-sandbox-web-stack- from the hub.",
      ]);
    }).pipe(
      Effect.provide(
        provisionerLayer(hubSettings, repository.layer, { host, secrets: secrets.layer }),
      ),
      Effect.provideService(HttpClient.HttpClient, client),
    );
  });
  // The record a launch left behind when its client went away and the user deleted the machine
  // in Boat: the same keys, a hub key and a tailnet device, and no environment yet.
  it.effect("releases the hub key and tailnet device of a stuck launch Boat no longer has", () => {
    const requests: Array<{ method: string; url: string; body: unknown; auth?: string }> = [];
    const secrets = memorySecrets();
    const hubKeySecret = "sandbox-hub-key-stuck";
    secrets.values.set(
      hubKeySecret,
      new TextEncoder().encode("t3-sandbox-horizon-stack-on-boat-sandbox-76f4aaaaaaaaaaaa"),
    );
    const sourceId = "cliproxy-hub.example";
    const stuck: SandboxRecord = {
      instanceId: "32cf0d98-b444-490d-acfd-2371814b0067",
      environmentId: null,
      configId: "config-boat",
      threadId: ThreadId.make("60df7491-7d8d-420a-a222-3df81fa717ba"),
      projectId: ProjectId.make("project-horizon"),
      projectTitle: "horizon-stack",
      provider: "boat",
      sandboxId: "bx_2t2p26af",
      label: "horizon-stack on Boat sandbox",
      size: "small",
      state: "provisioning",
      createdAt: "2026-11-05T18:36:53.520Z",
      updatedAt: "2026-11-05T18:37:16.000Z",
      httpBaseUrl: "",
      access: "public",
      runningSince: "2026-11-05T18:36:53.520Z",
      maxRunningMinutes: 480,
      claudeHubKey: { sourceId, secret: hubKeySecret },
      tailscale: { deviceId: "nWgD5jiZMW11CNTRL" },
    };
    expect(Object.keys(stuck).toSorted()).toEqual(
      [
        "instanceId",
        "environmentId",
        "configId",
        "threadId",
        "projectId",
        "projectTitle",
        "provider",
        "sandboxId",
        "label",
        "size",
        "state",
        "createdAt",
        "updatedAt",
        "httpBaseUrl",
        "access",
        "runningSince",
        "maxRunningMinutes",
        "claudeHubKey",
        "tailscale",
      ].toSorted(),
    );
    const repository = memoryRepository([stuck]);
    const client = recording(requests, (request) => {
      if (request.url.includes("/sandboxes/bx_2t2p26af")) {
        return Response.json({ code: "not_found" }, { status: 404 });
      }
      if (request.url === "https://api.tailscale.com/api/v2/oauth/token") {
        return Response.json({ access_token: TS_ACCESS_TOKEN, token_type: "Bearer" });
      }
      return Response.json({ ok: true });
    });
    const settings = {
      sandboxProviders: { boat: { apiKey: "boat_test" } },
      usageLimitSources: { [sourceId]: hubSettings.usageLimitSources.hub },
      sandboxTailscale: tailnetSettings.sandboxTailscale,
    } as const;
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      // What the server does as it starts, with no launch left to finish this one.
      yield* provisioner.sweep;
      const deletes = requests
        .filter((request) => request.method === "DELETE")
        .map((request) => request.url);
      expect(deletes).toEqual(
        expect.arrayContaining([
          "https://boat.dev/api/v1/sandboxes/bx_2t2p26af",
          "https://hub.test/v0/management/api-keys?value=t3-sandbox-horizon-stack-on-boat-sandbox-76f4aaaaaaaaaaaa",
          "https://api.tailscale.com/api/v2/device/nWgD5jiZMW11CNTRL",
        ]),
      );
      expect(deletes).toHaveLength(3);
      expect(repository.records.size).toBe(0);
      expect(secrets.values.has(hubKeySecret)).toBe(false);
      expect((yield* provisioner.list).sandboxes).toEqual([]);
    }).pipe(
      Effect.provide(provisionerLayer(settings, repository.layer, { secrets: secrets.layer })),
      Effect.provideService(HttpClient.HttpClient, client),
    );
  });

  it.effect(
    "joins the tailnet with a single-use ephemeral key and removes the device when deleted",
    () => {
      const requests: Array<{ method: string; url: string; body: unknown; auth?: string }> = [];
      const { client, commands, secretsOf } = agentClient(requests, { tailnetMode: "userspace" });
      const repository = memoryRepository();
      const tailnetHost = { ...host, claude: { ...host.claude, baseUrl: "https://100.92.23.53" } };
      return Effect.gen(function* () {
        const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
        // Clients learn that a sandbox can join, never the OAuth client's secret.
        const facts = (yield* provisioner.providers).host;
        expect(facts.tailscale).toBe(true);
        expect(JSON.stringify(facts)).not.toContain(TS_CLIENT_SECRET);

        const created = yield* provisioner.create({
          provider: "boat",
          apiKey: "boat_test",
          label: "Web Stack",
          joinTailnet: true,
          agentAccess: { claude: { baseUrl: "https://100.92.23.53" } },
        });
        expect(created.setup).toEqual({
          claude: "ready",
          github: "skipped",
          tailscale: "ready",
          warnings: [],
        });

        // Signing in comes before anything bills; the key is minted only once the machine runs.
        const index = (predicate: (request: (typeof requests)[number]) => boolean) =>
          requests.findIndex(predicate);
        const signIn = index((request) => request.url.endsWith("/oauth/token"));
        const sandboxCreate = index((request) => request.url.endsWith("/sandboxes"));
        const mint = index((request) => request.url.endsWith("/tailnet/-/keys"));
        expect(signIn).toBeGreaterThanOrEqual(0);
        expect(signIn).toBeLessThan(sandboxCreate);
        expect(mint).toBeGreaterThan(sandboxCreate);
        expect(new URLSearchParams(requests[signIn]!.body as string).toString()).toBe(
          new URLSearchParams({
            grant_type: "client_credentials",
            client_id: "kCLIENT",
            client_secret: TS_CLIENT_SECRET,
          }).toString(),
        );
        expect(requests[mint]).toMatchObject({
          method: "POST",
          url: "https://api.tailscale.com/api/v2/tailnet/-/keys",
          authorization: `Bearer ${TS_ACCESS_TOKEN}`,
          body: {
            capabilities: {
              devices: {
                create: {
                  reusable: false,
                  ephemeral: true,
                  preauthorized: true,
                  tags: ["tag:t3-sandbox"],
                },
              },
            },
            expirySeconds: 600,
            description: "T3 Code sandbox web-stack",
          },
        });

        // The key never travels in a command, and the join comes before Claude's settings.
        expect(joinKeyOf(secretsOf)).toEqual([TS_AUTH_KEY]);
        for (const secret of [TS_AUTH_KEY, TS_CLIENT_SECRET, TS_ACCESS_TOKEN]) {
          expect(revealsSecret(commands, secret)).toBe(false);
        }
        expect(commands.find((command) => command.includes('--auth-key="file:'))).toMatch(
          /--hostname=\W*t3-sandbox-web-stack\W/u,
        );
        const step = (marker: string) => commands.findIndex((command) => command.includes(marker));
        expect(step('--auth-key="file:')).toBeLessThan(step("T3_CLAUDE_ENV"));
        // A userspace tailnet is reached through tailscaled's proxy, by Claude and by the check.
        expect(claudeEnvOf(secretsOf)).toMatchObject({
          ANTHROPIC_BASE_URL: "https://100.92.23.53",
          HTTPS_PROXY: "http://localhost:1055",
          HTTP_PROXY: "http://localhost:1055",
          NO_PROXY: "localhost,127.0.0.1,::1",
        });
        expect(commands.find((command) => command.includes("T3_ENDPOINT_STATUS"))).toMatch(
          /--proxy \W*http:\/\/localhost:1055\W/u,
        );
        expect(repository.byEnvironment(testEnvironmentId)?.tailscale).toEqual({
          deviceId: "nNODE1CNTRL",
        });

        requests.length = 0;
        expect(
          yield* provisioner.delete({
            provider: "boat",
            sandboxId: boatSandboxId,
            instanceId: repository.byEnvironment(testEnvironmentId)?.instanceId,
          }),
        ).toEqual({ warnings: [] });
        expect(requests).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              method: "DELETE",
              url: "https://api.tailscale.com/api/v2/device/nNODE1CNTRL",
              authorization: `Bearer ${TS_ACCESS_TOKEN}`,
            }),
          ]),
        );
      }).pipe(
        Effect.provide(provisionerLayer(tailnetSettings, repository.layer, { host: tailnetHost })),
        Effect.provideService(HttpClient.HttpClient, client),
      );
    },
  );

  it.effect(
    "removes a joined device when provisioning fails and keeps secrets out of errors",
    () => {
      const requests: Array<{ method: string; url: string; body: unknown; auth?: string }> = [];
      const options: { failCommand?: string; tokenStatus?: number } = {
        failCommand: "nohup t3 serve",
      };
      const { client } = agentClient(requests, options);
      const secrets = [TS_AUTH_KEY, TS_CLIENT_SECRET, TS_ACCESS_TOKEN];
      return Effect.gen(function* () {
        const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
        const create = provisioner.create({
          provider: "boat",
          apiKey: "boat_test",
          label: "Web Stack",
          joinTailnet: true,
        });
        // T3 failing to start after the join deletes the machine and its tailnet device.
        const failed = yield* Effect.flip(create);
        expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual(
          expect.arrayContaining([
            `DELETE https://boat.dev/api/v1/sandboxes/${boatSandboxId}`,
            "DELETE https://api.tailscale.com/api/v2/device/nNODE1CNTRL",
          ]),
        );
        for (const secret of secrets) expect(failed.message).not.toContain(secret);

        // A join that fails leaves a working sandbox and a warning without the script's output.
        options.failCommand = "T3_TAILSCALE_";
        const joinFailed = yield* create;
        expect(joinFailed.setup.tailscale).toBe("failed");
        expect(joinFailed.setup.warnings).toEqual(["The sandbox could not join your tailnet."]);

        // An OAuth client Tailscale rejects fails the create before any machine is billed.
        requests.length = 0;
        options.tokenStatus = 401;
        const refused = yield* Effect.flip(create);
        expect(refused.detail).toBe(
          "Could not sign in to Tailscale. Tailscale answered with HTTP 401 while signing in with the OAuth client. Check the OAuth client ID and secret.",
        );
        expect(requests.some((request) => request.url.endsWith("/sandboxes"))).toBe(false);
        for (const secret of secrets) expect(refused.message).not.toContain(secret);
      }).pipe(
        Effect.provide(provisionerLayer(tailnetSettings, discardingRepository, { host })),
        Effect.provideService(HttpClient.HttpClient, client),
      );
    },
  );

  it.effect(
    "rejoins a resumed sandbox whose ephemeral node is gone and replaces its device",
    () => {
      const requests: Array<{ method: string; url: string; body: unknown; auth?: string }> = [];
      const options: { tailnetIdleState?: string; tailnetNode?: string } = {
        tailnetNode: "nNEWCNTRL",
      };
      const { client, commands, secretsOf } = agentClient(requests, options);
      const stopped: SandboxRecord = {
        instanceId: testEnvironmentId,
        environmentId: testEnvironmentId,
        provider: "boat",
        sandboxId: boatSandboxId,
        label: "Web Stack",
        size: "default",
        state: "stopped",
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
        httpBaseUrl: "https://boat.example/t3",
        runningSince: null,
        maxRunningMinutes: 480,
        tailscale: { deviceId: "nOLDCNTRL" },
      };
      const repository = memoryRepository([stopped]);
      return Effect.gen(function* () {
        const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
        const resumed = yield* provisioner.resume({ instanceId: testEnvironmentId });
        expect(resumed.warnings).toBeUndefined();
        expect(resumed.sandbox.tailscale).toEqual({ deviceId: "nNEWCNTRL" });
        expect(repository.byEnvironment(testEnvironmentId)?.tailscale).toEqual({
          deviceId: "nNEWCNTRL",
        });
        expect(joinKeyOf(secretsOf)).toEqual([TS_AUTH_KEY]);
        expect(revealsSecret(commands, TS_AUTH_KEY)).toBe(false);
        expect(requests.map((request) => `${request.method} ${request.url}`)).toContain(
          "DELETE https://api.tailscale.com/api/v2/device/nOLDCNTRL",
        );
        // tailscaled is back before T3 starts, so the first Claude check can reach the endpoint.
        const step = (marker: string) => commands.findIndex((command) => command.includes(marker));
        expect(step('--auth-key="file:')).toBeLessThan(step("nohup t3 serve"));

        // A sandbox still connected after a short stop needs no new key.
        yield* provisioner.stop({ instanceId: testEnvironmentId });
        requests.length = 0;
        commands.length = 0;
        options.tailnetIdleState = "Running";
        const again = yield* provisioner.resume({ instanceId: testEnvironmentId });
        expect(again.sandbox.tailscale).toEqual({ deviceId: "nNEWCNTRL" });
        expect(
          requests.some((request) => request.url.startsWith("https://api.tailscale.com/")),
        ).toBe(false);
        expect(joinKeyOf(secretsOf)).toEqual([]);
      }).pipe(
        Effect.provide(
          provisionerLayer(
            {
              ...tailnetSettings,
              sandboxProviders: { boat: { apiKey: "boat_test", settings: {} } },
            },
            repository.layer,
            { host },
          ),
        ),
        Effect.provideService(HttpClient.HttpClient, client),
      );
    },
  );
});

describe("Tailscale OAuth client check", () => {
  // Tailscale answers the token request with the scopes the client was granted.
  const tokenClient = (
    requests: Array<{ method: string; url: string; body: unknown; auth?: string | undefined }>,
    answer: { readonly status?: number; readonly scope?: string },
  ) =>
    recording(requests, (request) =>
      request.url === "https://api.tailscale.com/api/v2/oauth/token"
        ? Response.json(
            { access_token: "tskey-api-ACCESS", token_type: "Bearer", scope: answer.scope },
            { status: answer.status ?? 200 },
          )
        : new Response(null, { status: 404 }),
    );

  it.effect("takes the client ID from the secret and accepts a client with both scopes", () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      const result = yield* provisioner.checkTailscale({
        clientSecret: "tskey-client-kABC123CNTRL-rest-of-secret",
      });
      expect(result).toEqual({
        clientId: "kABC123CNTRL",
        scopes: ["auth_keys", "devices:core"],
        problem: null,
      });
      expect(String(requests[0]?.body)).toContain("client_id=kABC123CNTRL");
      // Asks for the tag too, so a tag the client may not use fails here and not at launch.
      expect(String(requests[0]?.body)).toContain("tags=tag%3At3-sandbox");
    }).pipe(
      Effect.provide(testLayer),
      Effect.provideService(
        HttpClient.HttpClient,
        tokenClient(requests, { scope: "auth_keys devices:core" }),
      ),
    );
  });

  it.effect("names the missing scope, a rejected secret, and a secret of another shape", () =>
    Effect.gen(function* () {
      const check = (
        answer: { readonly status?: number; readonly scope?: string },
        input: { readonly clientSecret: string; readonly clientId?: string; readonly tag?: string },
      ) =>
        Effect.gen(function* () {
          const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
          return yield* provisioner.checkTailscale(input);
        }).pipe(
          Effect.provide(testLayer),
          Effect.provideService(HttpClient.HttpClient, tokenClient([], answer)),
        );
      const secret = "tskey-client-kABC-rest";
      // Named the way Tailscale's Scopes step shows them.
      expect((yield* check({ scope: "auth_keys" }, { clientSecret: secret })).problem).toBe(
        "Missing Devices → Core: Write for tag:t3-sandbox. Make an OAuth client that has it (step 2) and paste its secret.",
      );
      expect(
        (yield* check({ scope: "dns:read" }, { clientSecret: secret, tag: "tag:ci" })).problem,
      ).toBe(
        "Missing Devices → Core: Write and Keys → Auth Keys: Write for tag:ci. Make an OAuth client that has them (step 2) and paste its secret.",
      );
      expect(
        (yield* check({ scope: "devices:core auth_keys:read" }, { clientSecret: secret })).problem,
      ).toBe(
        "Missing Keys → Auth Keys: Write (it has Read) for tag:t3-sandbox. Make an OAuth client that has it (step 2) and paste its secret.",
      );
      // Tailscale answers 400 when the client may not use the requested tag.
      expect((yield* check({ status: 400 }, { clientSecret: secret })).problem).toBe(
        "Tailscale won't give this client tag:t3-sandbox. Add the tag to tagOwners in your policy file (step 1), then make an OAuth client with it selected for both scopes (step 2).",
      );
      expect((yield* check({ status: 401 }, { clientSecret: secret })).problem).toBe(
        "Tailscale did not accept this secret. Copy it again, or make a new OAuth client (step 2).",
      );
      expect((yield* check({ scope: "all" }, { clientSecret: secret })).problem).toBeNull();
      expect((yield* check({}, { clientSecret: "not-a-client-secret" })).problem).toBe(
        "This does not look like a Tailscale OAuth client secret (tskey-client-…). If yours has another form, enter its client ID under Advanced.",
      );
      // A separate client ID still works for a secret of another shape.
      expect(
        yield* check(
          { scope: "auth_keys devices:core" },
          { clientSecret: "other-secret", clientId: "kOTHER" },
        ),
      ).toMatchObject({ clientId: "kOTHER", problem: null });
    }),
  );
});

describe("SandboxProvisioner per-thread launches", () => {
  const threadId = ThreadId.make("thread-launch");
  const projectId = ProjectId.make("project-host");
  const project = {
    id: projectId,
    title: "hello",
    remoteUrl: "git@github.com:octo/hello.git",
    hostCopy: { projectId, workspaceRoot: "/host/hello" },
  };
  // The same repository opened only on a paired machine: this host has no copy of it.
  const remoteProject = {
    id: ProjectId.make("project-on-t3-machine"),
    title: "hello",
    remoteUrl: "https://github.com/Octo/Hello.git",
  };
  const pairToken = "PAIRLAUNCH42";
  // Longer than one sealed block, like a real bearer token.
  const bridgeToken = `t3b_${"BRIDGE7Q2".repeat(40)}`;
  const configInput = {
    label: "Boat small",
    provider: "boat",
    size: "small",
    passGithubToken: false,
    joinTailnet: false,
    access: "public",
    envFiles: {},
    idleMinutes: 30,
    maxRunningMinutes: 480,
  } as const;

  interface BoatFake {
    readonly requests: Array<string>;
    readonly commands: Array<string>;
    readonly bodies: Array<{ readonly url: string; readonly body: unknown }>;
    /** Sandboxes Boat lists under this host's label; deletes take theirs out. */
    readonly listed: Array<{ id: string; name: string; labels?: Record<string, string> }>;
    /** Boat's environments, starting with the account's default. */
    readonly environments: Array<BoatFakeEnvironment>;
    /** Scoped keys Boat holds, by id. */
    readonly keys: Set<string>;
    /** Every sandbox with its environment, as Boat lists them by environment. */
    readonly inEnvironments: Array<{ id: string; name: string; environment: string }>;
    /** Boat's state per sandbox id, which a test can change mid-launch. */
    readonly states: Record<string, string>;
    readonly client: HttpClient.HttpClient;
  }

  interface BoatFakeEnvironment {
    id: string;
    name: string;
    isDefault: boolean;
    safeForThirdParties: boolean;
    passGithub: boolean;
    passSecrets: boolean;
    passSandboxCredentials: boolean;
    passAgentsCredentials: boolean;
    proxyAiCredentials: boolean;
  }

  const boatEnvironment = (id: string, name: string): BoatFakeEnvironment => ({
    id,
    name,
    isDefault: name === "base",
    // What Boat gives a new environment: everything passed.
    safeForThirdParties: false,
    passGithub: true,
    passSecrets: true,
    passSandboxCredentials: true,
    passAgentsCredentials: true,
    proxyAiCredentials: false,
  });

  const agentKeySecret = "boat_scoped_SECRET";
  const keepAliveKeySecret = "boat_keepalive_SECRET";

  const boatFake = (
    options: {
      /** Commands containing this text fail with exit code 1, the given number of times. */
      readonly failing?: { readonly text: string; times: number };
      /** Commands containing this text wait on `until` before answering, after `reached`. */
      readonly holding?: {
        readonly text: string;
        readonly until: Deferred.Deferred<void>;
        readonly reached?: Deferred.Deferred<void>;
      };
      readonly listed?: BoatFake["listed"];
      /** What the sandbox gets back from Claude's endpoint; `000` means it never connected. */
      readonly endpointStatus?: string;
      /** How Boat answers the scoped-key check: a key without account admin rights is refused. */
      readonly scopedKeys?: "admin" | "limited" | "wide";
      /** How Boat scopes a keep-alive key: `wide` reaches every sandbox; `refused` fails the mint. */
      readonly keepAliveKeys?: "exact" | "wide" | "refused";
      readonly inEnvironments?: BoatFake["inEnvironments"];
      /** What the work check prints; a clean clone by default. */
      readonly work?: string;
      /** When the bridge credentials the sandbox mints expire. */
      readonly bridgeExpiresAt?: string;
      /** Boat's state per sandbox id; `gone` answers 404, as Boat does once it is deleted. */
      readonly states?: Record<string, string>;
      /** Sandbox ids Boat refuses to delete. */
      readonly undeletable?: ReadonlyArray<string>;
    } = {},
  ): BoatFake => {
    const states = options.states ?? {};
    let minted = 0;
    let keepAliveMinted = 0;
    const requests: Array<string> = [];
    const commands: Array<string> = [];
    const bodies: Array<{ readonly url: string; readonly body: unknown }> = [];
    const listed = options.listed ?? [];
    const environments = [boatEnvironment("env-base", "base")];
    const keys = new Set<string>();
    const inEnvironments = options.inEnvironments ?? [];
    const respond = (request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status })));
    const client = HttpClient.make((request) => {
      const query = UrlParams.toString(request.urlParams);
      requests.push(`${request.method} ${request.url}${query === "" ? "" : `?${query}`}`);
      // Tailscale's token request is form-encoded; every other body is JSON.
      const body =
        request.body._tag === "Uint8Array" && !request.url.endsWith("/oauth/token")
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : undefined;
      if (body !== undefined) bodies.push({ url: request.url, body });
      if (request.url.endsWith("/limits")) return respond(request, { ok: false }, 401);
      if (request.url === "https://api.tailscale.com/api/v2/oauth/token") {
        return respond(request, { access_token: "tskey-api-A", token_type: "Bearer" });
      }
      if (request.url === "https://api.tailscale.com/api/v2/tailnet/-/keys") {
        return respond(request, { id: "k1", key: "tskey-auth-kONCE-key" });
      }
      if (request.url.startsWith("https://api.tailscale.com/api/v2/device/")) {
        return respond(request, {});
      }
      if (request.url.endsWith("/.well-known/t3/environment")) return respond(request, descriptor);
      if (request.url === "https://boat.dev/api/v1/api-keys/scoped") {
        if (body.sandboxIds?.[0] === "bx_t3probe0") {
          return options.scopedKeys === "limited"
            ? respond(request, { code: "api_key_action_forbidden" }, 403)
            : respond(request, { code: "api_key_sandbox_forbidden" }, 403);
        }
        // A keep-alive key may move the sandbox's auto-stop; the agent's may not.
        if (body.actions?.includes("sandbox.update") === true) {
          if (options.keepAliveKeys === "refused") {
            return respond(request, { code: "api_key_action_forbidden" }, 403);
          }
          const id = `apk_keepalive${++keepAliveMinted}`;
          keys.add(id);
          return respond(
            request,
            {
              ok: true,
              secret: `${keepAliveKeySecret}${keepAliveMinted}`,
              apiKey: {
                id,
                scope: {
                  sandboxes: options.keepAliveKeys === "wide" ? "*" : body.sandboxIds,
                  environments: [],
                },
              },
            },
            201,
          );
        }
        keys.add("apk_agent1");
        return respond(
          request,
          {
            ok: true,
            secret: agentKeySecret,
            apiKey: {
              id: "apk_agent1",
              scope: {
                sandboxes: options.scopedKeys === "wide" ? "*" : body.sandboxIds,
                environments: body.environmentIds,
              },
            },
          },
          201,
        );
      }
      if (request.url.startsWith("https://boat.dev/api/v1/api-keys/")) {
        const id = request.url.split("/").at(-1) ?? "";
        return keys.delete(id)
          ? respond(request, { ok: true })
          : respond(request, { code: "not_found" }, 404);
      }
      if (request.url === "https://boat.dev/api/v1/environments") {
        if (request.method === "POST") {
          environments.push(boatEnvironment(`env-${environments.length}`, body.name));
        }
        // Creating one answers with all of them, as Boat does.
        return respond(request, { environments });
      }
      if (request.url.startsWith("https://boat.dev/api/v1/environments/")) {
        const id = request.url.split("/").at(-1) ?? "";
        const index = environments.findIndex((environment) => environment.id === id);
        if (index < 0) return respond(request, { code: "not_found" }, 404);
        if (request.method === "DELETE") environments.splice(index, 1);
        else Object.assign(environments[index]!, body);
        return respond(request, { ok: true });
      }
      if (request.method === "POST" && request.url === "https://boat.dev/api/v1/sandboxes") {
        if (typeof body?.environment === "string") {
          inEnvironments.push({
            id: boatSandboxId,
            name: body.name,
            environment: body.environment,
          });
        }
        return Effect.succeed(boatResponse(request));
      }
      if (request.url.endsWith("/files")) return respond(request, { ok: true });
      if (request.url.endsWith("/commands")) {
        const command: string = body?.command ?? "";
        commands.push(command);
        const answer = Effect.suspend(() => {
          if (options.failing !== undefined && command.includes(options.failing.text)) {
            if (options.failing.times > 0) {
              options.failing.times -= 1;
              return respond(request, { exitCode: 1, stdout: "", stderr: "boom" });
            }
          }
          const stdout = command.includes("git clone")
            ? "T3_REPO_DIR: /home/boat/work/hello\nT3_REPO_PROJECT: project-remote\n"
            : options.endpointStatus !== undefined && command.includes("T3_ENDPOINT_STATUS")
              ? `T3_ENDPOINT_STATUS:${options.endpointStatus}\n`
              : command.includes("--label t3-sandbox-bridge")
                ? bridgeOutput(command, {
                    sessionId: `bridge-session-${++minted}`,
                    token: bridgeToken,
                    expiresAt: options.bridgeExpiresAt ?? "2027-11-05T00:00:00.000Z",
                  })
                : command.includes("T3_WORK:")
                  ? `${options.work ?? "T3_WORK:0:0"}\n`
                  : command.includes("T3_TAILSCALE_")
                    ? "T3_TAILSCALE_DAEMON: nohup\nT3_TAILSCALE_MODE: kernel\nT3_TAILSCALE_STATE: Running\nT3_TAILSCALE_NODE: nNODE1CNTRL\n"
                    : pairOr(bodyTextOf(request), pairToken, "");
          return respond(request, { exitCode: 0, stdout, stderr: "" });
        });
        return options.holding !== undefined && command.includes(options.holding.text)
          ? (options.holding.reached === undefined
              ? Effect.void
              : Deferred.succeed(options.holding.reached, undefined)
            ).pipe(Effect.andThen(Deferred.await(options.holding.until)), Effect.andThen(answer))
          : answer;
      }
      if (
        request.url.includes("/sandboxes/") &&
        states[request.url.split("/").at(-1)!] === "gone"
      ) {
        return respond(request, { code: "not_found" }, 404);
      }
      if (request.method === "DELETE" && request.url.includes("/sandboxes/")) {
        const id = request.url.split("/").at(-1);
        if (options.undeletable?.includes(id ?? "") === true) {
          return respond(request, { code: "forbidden" }, 403);
        }
        const index = listed.findIndex((sandbox) => sandbox.id === id);
        if (index >= 0) listed.splice(index, 1);
        const placed = inEnvironments.findIndex((sandbox) => sandbox.id === id);
        if (placed >= 0) inEnvironments.splice(placed, 1);
        return respond(request, { ok: true });
      }
      if (request.method === "GET" && request.url.endsWith("/sandboxes")) {
        // Every sandbox, whatever the filter: the driver keeps only the environment's own.
        if (new URLSearchParams(query).has("environment")) {
          return respond(request, { sandboxes: inEnvironments });
        }
        const label = new URLSearchParams(query).get("label") ?? "";
        return respond(
          request,
          label.startsWith("t3.code/host=") ? { sandboxes: listed } : { sandboxes: [] },
        );
      }
      if (request.method === "GET" && /\/sandboxes\/[^/]+$/u.test(request.url)) {
        const id = request.url.split("/").at(-1)!;
        const state = states[id] ?? (id === boatSandboxId ? "ready" : undefined);
        if (state !== undefined) return respond(request, { sandbox: { id, state, error: null } });
      }
      return Effect.succeed(boatResponse(request));
    });
    return {
      requests,
      commands,
      bodies,
      listed,
      environments,
      keys,
      inEnvironments,
      states,
      client,
    };
  };

  const snapshotWhere = (
    provisioner: SandboxProvisioner.SandboxProvisioner["Service"],
    predicate: (snapshot: SandboxSetupSnapshot) => boolean,
  ) =>
    provisioner.subscribeLaunch({ threadId }).pipe(
      Stream.filter(
        (snapshot): snapshot is SandboxSetupSnapshot => snapshot !== null && predicate(snapshot),
      ),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );

  const stageOf = (snapshot: SandboxSetupSnapshot, id: string) =>
    snapshot.stages.find((stage) => stage.id === id);

  const deletes = (fake: BoatFake) =>
    fake.requests.filter((request) => request.startsWith("DELETE") && !request.includes("/files"));

  it.effect("saves a config without creating a machine and validates it", () => {
    const fake = boatFake();
    const configs = memoryConfigs();
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      const saved = yield* provisioner.saveConfig({ config: configInput, apiKey: "boat_test" });
      expect(saved.config).toMatchObject({ label: "Boat small", size: "small" });
      const renamed = yield* provisioner.saveConfig({
        config: { ...saved.config, label: "Boat tiny" },
      });
      expect(renamed.config.id).toBe(saved.config.id);
      expect(renamed.config.createdAt).toBe(saved.config.createdAt);
      expect((yield* provisioner.configs).configs.map((config) => config.label)).toEqual([
        "Boat tiny",
      ]);

      const refusals = yield* Effect.forEach(
        [
          { ...configInput, label: "  " },
          { ...configInput, size: "huge" },
          { ...configInput, access: "tailnet" as const },
          { ...configInput, pi: {} },
        ],
        (config) => provisioner.saveConfig({ config }).pipe(Effect.flip),
      );
      expect(refusals.map((error) => error.detail)).toEqual([
        "Enter a name for this sandbox config.",
        "Boat has no machine size huge.",
        "A tailnet-only sandbox has to join your tailnet.",
        "Pi uses the sandbox's hub key for Claude, so turn on this machine's Claude setup too.",
      ]);

      yield* provisioner.deleteConfig({ configId: saved.config.id });
      expect(configs.configs.size).toBe(0);
      // Registering a config never makes a machine.
      expect(fake.requests.filter((request) => request.startsWith("POST"))).toEqual([]);
    }).pipe(
      Effect.provide(provisionerLayer({}, discardingRepository, { configs: configs.layer })),
      Effect.provideService(HttpClient.HttpClient, fake.client),
    );
  });

  it.effect("launches a thread's sandbox through every stage and hands it to the client", () => {
    const fake = boatFake();
    const repository = memoryRepository();
    const configs = memoryConfigs();
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      const { config } = yield* provisioner.saveConfig({
        config: configInput,
        apiKey: "boat_test",
      });
      const { instanceId } = yield* provisioner.launch({ configId: config.id, threadId, project });

      const waiting = yield* snapshotWhere(provisioner, (snapshot) => snapshot.awaitingHandoff);
      expect(waiting).toMatchObject({ instanceId, configId: config.id, phase: "running" });
      expect(stageOf(waiting, "repo")).toMatchObject({ status: "done", detail: "~/work/hello" });
      expect(stageOf(waiting, "env-files")).toMatchObject({ status: "done", detail: "1 file" });
      expect(stageOf(waiting, "pair")?.status).toBe("running");
      // The record exists from the moment the machine does, and names its thread.
      expect(repository.records.get(instanceId)).toMatchObject({
        state: "provisioning",
        threadId,
        projectId,
        projectTitle: "hello",
        configId: config.id,
        label: "hello on Boat small",
        environmentId: testEnvironmentId,
        // Where a delete checks for unpushed work.
        repoDir: "/home/boat/work/hello",
      });

      const paired = yield* provisioner.pairLaunch({ threadId });
      expect(paired).toEqual({
        environmentId: testEnvironmentId,
        httpBaseUrl: "https://boat.example/t3",
        pairingCode: pairToken,
        projectId: "project-remote",
      });
      yield* provisioner.completeLaunch({ threadId });
      const done = yield* snapshotWhere(provisioner, (snapshot) => snapshot.phase === "done");
      expect(done.stages.map((stage) => stage.status)).toEqual([
        "done",
        "done",
        "done",
        "done",
        "done",
        "done",
        "done",
        // Nothing to set up: the config asks for no tools, MCP servers, or skills.
        "skipped",
        "done",
      ]);
      expect(repository.records.get(instanceId)?.state).toBe("running");

      // Boat tags the machine with this host and instance, so a sweep can find it again.
      const created = fake.bodies.find((entry) => entry.url.endsWith("/sandboxes"))?.body;
      expect(created).toMatchObject({
        labels: {
          "t3.code/role": "environment",
          "t3.code/host": hostEnvironmentId,
          "t3.code/instance": instanceId,
        },
      });
      expect(
        fake.commands.some((command) => command.includes("https://github.com/octo/hello.git")),
      ).toBe(true);
      // The env file travels in a files request body, never in a command's text.
      expect(fake.bodies).toContainEqual({
        url: `https://boat.dev/api/v1/sandboxes/${boatSandboxId}/files`,
        body: { path: "/home/boat/work/hello/.env", content: "API_TOKEN=shh" },
      });
      expect(fake.commands.some((command) => command.includes("API_TOKEN"))).toBe(false);
      expect(deletes(fake)).toEqual([]);

      // The sandbox keeps itself up with a key scoped to it, which reaches it only in a files
      // body; T3 keeps its id to revoke it, never the key.
      expect(repository.records.get(instanceId)).toMatchObject({
        idleMinutes: 30,
        keepAliveKey: {
          name: expect.stringMatching(/^t3-keepalive-hello-on-boat-small-[0-9a-f]{8}$/u),
          id: "apk_keepalive1",
          expiresAt: "1970-01-31T00:00:00.000Z",
        },
      });
      expect(JSON.stringify(repository.records.get(instanceId))).not.toContain(keepAliveKeySecret);
      expect(fake.commands.some((command) => command.includes(keepAliveKeySecret))).toBe(false);
      expect(
        fake.bodies.some(
          (entry) =>
            entry.url.endsWith("/files") &&
            JSON.stringify(entry.body).includes(`T3_KEEPALIVE_KEY='${keepAliveKeySecret}1'`),
        ),
      ).toBe(true);
      // Setup runs under the running limit; once handed off, the sandbox stops 30 minutes (plus
      // one check) after its threads go idle, and its own checks move that while they work.
      expect(created).toMatchObject({ ttlSeconds: 480 * 60 });
      const autoStops = fake.requests.filter(
        (request) => request === `PATCH https://boat.dev/api/v1/sandboxes/${boatSandboxId}`,
      );
      expect(autoStops).toHaveLength(1);
      expect(
        fake.bodies.findLast(
          (entry) => entry.url === `https://boat.dev/api/v1/sandboxes/${boatSandboxId}`,
        )?.body,
      ).toEqual({ ttlSeconds: 35 * 60 });
      expect(fake.commands.find((command) => command.includes("T3_KEEPALIVE_LOOP"))).toContain(
        `EXTEND_URL='\\''https://boat.dev/api/v1/sandboxes/${boatSandboxId}'\\''`,
      );
    }).pipe(
      Effect.provide(
        provisionerLayer({}, repository.layer, {
          configs: configs.layer,
          workspace: { ".env": "API_TOKEN=shh", "build/output.log": "ignored" },
        }),
      ),
      Effect.provideService(HttpClient.HttpClient, fake.client),
    );
  });

  it.effect(
    "leaves a sandbox on its running limit when Boat scopes its keep-alive key wider",
    () => {
      const fake = boatFake({ keepAliveKeys: "wide" });
      const repository = memoryRepository();
      return Effect.gen(function* () {
        const { provisioner, instanceId } = yield* launchedThread;
        const snapshot = yield* provisioner.subscribeLaunch({ threadId }).pipe(Stream.runHead);
        expect(Option.getOrThrow(snapshot)?.warnings).toContain(
          "This sandbox could not be set up to stay on while its agents work, so it stops 8 h after it starts.",
        );
        expect(fake.requests).toContain("DELETE https://boat.dev/api/v1/api-keys/apk_keepalive1");
        expect(fake.keys.size).toBe(0);
        expect(repository.records.get(instanceId)?.keepAliveKey).toBeUndefined();
        expect(fake.commands.some((command) => command.includes("T3_KEEPALIVE_LOOP"))).toBe(false);
        // Boat's auto-stop stays at the running limit, which the sweep enforces as before.
        expect(fake.requests.some((request) => request.startsWith("PATCH"))).toBe(false);
      }).pipe(
        Effect.provide(provisionerLayer({}, repository.layer, { configs: memoryConfigs().layer })),
        Effect.provideService(HttpClient.HttpClient, fake.client),
      );
    },
  );

  it.effect(
    "gives a sandbox made before keep-alive a key on resume and renews it near expiry",
    () => {
      const fake = boatFake();
      const config: SandboxEnvironmentConfig = {
        ...configInput,
        id: "config-older",
        idleMinutes: 45,
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
      };
      // What a thread's sandbox looked like before keep-alive: no idle window, no key.
      const older: SandboxRecord = {
        instanceId: "older",
        environmentId: testEnvironmentId,
        configId: config.id,
        threadId,
        provider: "boat",
        sandboxId: boatSandboxId,
        label: "hello on Boat small",
        size: "small",
        state: "stopped",
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
        httpBaseUrl: "https://boat.example/t3",
        runningSince: null,
        maxRunningMinutes: 480,
        repoDir: "/home/boat/work/hello",
      };
      const repository = memoryRepository([older]);
      const resumeBodies = () =>
        fake.bodies.filter((entry) => entry.url.endsWith("/resume")).map((entry) => entry.body);
      return Effect.gen(function* () {
        const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
        yield* provisioner.resume({ instanceId: "older" });
        // It resumes under its running limit, gets its key and loop before T3 (and so the loop)
        // starts, and only then moves to its config's idle window.
        expect(resumeBodies()).toEqual([{ ttlSeconds: 480 * 60 }]);
        const installed = fake.commands.findIndex((command) =>
          command.includes("T3_KEEPALIVE_LOOP"),
        );
        const started = fake.commands.findIndex((command) => command.includes("t3 serve"));
        expect(installed).toBeGreaterThanOrEqual(0);
        expect(installed).toBeLessThan(started);
        expect(fake.commands[installed]).toContain("PROJECT_ROOT='\\''/home/boat/work/hello'\\''");
        expect(fake.commands[started]).toContain("sandbox-keepalive/loop.sh");
        expect(fake.bodies.at(-1)).toEqual({
          url: `https://boat.dev/api/v1/sandboxes/${boatSandboxId}`,
          body: { ttlSeconds: 50 * 60 },
        });
        expect(repository.records.get("older")).toMatchObject({
          state: "running",
          idleMinutes: 45,
          keepAliveKey: { id: "apk_keepalive1", expiresAt: "1970-01-31T00:00:00.000Z" },
        });

        // Next time it already keeps itself up: the idle window from the start, no new key.
        yield* provisioner.stop({ instanceId: "older" });
        yield* provisioner.resume({ instanceId: "older" });
        expect(resumeBodies().at(-1)).toEqual({ ttlSeconds: 50 * 60 });
        expect([...fake.keys]).toEqual(["apk_keepalive1"]);

        // With under a week left, a resume swaps in a fresh key and revokes the old one.
        yield* provisioner.stop({ instanceId: "older" });
        yield* TestClock.adjust("24 days");
        yield* provisioner.resume({ instanceId: "older" });
        expect([...fake.keys]).toEqual(["apk_keepalive2"]);
        expect(fake.requests).toContain("DELETE https://boat.dev/api/v1/api-keys/apk_keepalive1");
        expect(repository.records.get("older")?.keepAliveKey).toMatchObject({
          id: "apk_keepalive2",
          expiresAt: "1970-02-24T00:00:00.000Z",
        });

        yield* provisioner.delete({
          provider: "boat",
          instanceId: "older",
          sandboxId: boatSandboxId,
        });
        expect(fake.keys.size).toBe(0);
      }).pipe(
        Effect.provide(
          provisionerLayer(
            { sandboxProviders: { boat: { apiKey: "boat_test" } } },
            repository.layer,
            { configs: memoryConfigs([config]).layer },
          ),
        ),
        Effect.provideService(HttpClient.HttpClient, fake.client),
      );
    },
  );

  it.effect("names a resumed sandbox's first key before it mints it, as a launch does", () =>
    Effect.gen(function* () {
      const until = yield* Deferred.make<void>();
      const reached = yield* Deferred.make<void>();
      const fake = boatFake({ holding: { text: "T3_KEEPALIVE_LOOP", until, reached } });
      const older: SandboxRecord = {
        instanceId: "older",
        environmentId: testEnvironmentId,
        threadId,
        provider: "boat",
        sandboxId: boatSandboxId,
        label: "hello on Boat small",
        size: "small",
        state: "stopped",
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
        httpBaseUrl: "https://boat.example/t3",
        runningSince: null,
        maxRunningMinutes: 480,
      };
      const repository = memoryRepository([older]);
      yield* Effect.gen(function* () {
        const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
        const resuming = yield* provisioner.resume({ instanceId: "older" }).pipe(Effect.forkChild);
        yield* Deferred.await(reached);
        // Minted, not yet on the sandbox: the record already names it.
        expect([...fake.keys]).toEqual(["apk_keepalive1"]);
        const named = repository.records.get("older")?.keepAliveKey;
        expect(named?.name).toMatch(/^t3-keepalive-hello-on-boat-small-[0-9a-f]{8}$/u);
        expect(named?.id).toBeUndefined();

        // The server dies here; the delete that follows says which key to revoke by hand.
        yield* Fiber.interrupt(resuming);
        expect(repository.records.get("older")?.keepAliveKey).toEqual(named);
        const deleted = yield* provisioner.delete({
          provider: "boat",
          instanceId: "older",
          sandboxId: boatSandboxId,
        });
        expect(deleted.warnings).toEqual([
          expect.stringContaining(`Revoke the key named ${named?.name} in Boat.`),
        ]);
      }).pipe(
        Effect.provide(
          provisionerLayer(
            { sandboxProviders: { boat: { apiKey: "boat_test" } } },
            repository.layer,
          ),
        ),
        Effect.provideService(HttpClient.HttpClient, fake.client),
      );
    }),
  );

  const bridgeIssues = (fake: BoatFake) =>
    fake.commands.filter((command) => command.includes("--label t3-sandbox-bridge"));

  const bridgeLinkOf = (secrets: ReturnType<typeof memorySecrets>) => {
    const stored = secrets.values.get(bridgeLinkSecretName(threadId));
    return stored === undefined ? undefined : JSON.parse(new TextDecoder().decode(stored));
  };

  const launchedThread = Effect.gen(function* () {
    const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
    const { config } = yield* provisioner.saveConfig({ config: configInput, apiKey: "boat_test" });
    const { instanceId } = yield* provisioner.launch({ configId: config.id, threadId, project });
    yield* snapshotWhere(provisioner, (snapshot) => snapshot.awaitingHandoff);
    yield* provisioner.pairLaunch({ threadId });
    yield* provisioner.completeLaunch({ threadId });
    return { provisioner, instanceId };
  });

  it.effect(
    "mints the sandbox bridge's credential at launch and keeps its token in the secret store",
    () => {
      const fake = boatFake();
      const repository = memoryRepository();
      const secrets = memorySecrets();
      return Effect.gen(function* () {
        const { instanceId } = yield* launchedThread;
        const record = repository.records.get(instanceId)!;
        expect(record).toMatchObject({
          sandboxProjectId: "project-remote",
          repository: "octo/hello",
          hostProjectId: projectId,
          bridge: {
            sessionId: "bridge-session-1",
            secret: bridgeLinkSecretName(threadId),
            expiresAt: "2027-11-05T00:00:00.000Z",
          },
        });
        expect(JSON.stringify(record)).not.toContain(bridgeToken);
        expect(bridgeLinkOf(secrets)).toEqual({
          threadId,
          instanceId,
          sandboxId: boatSandboxId,
          label: "hello on Boat small",
          httpBaseUrl: "https://boat.example/t3",
          sandboxProjectId: "project-remote",
          token: bridgeToken,
        });
        // Scoped to what the bridge drives, and never in a command's text.
        expect(bridgeIssues(fake)).toHaveLength(1);
        expect(bridgeIssues(fake)[0]).toContain(
          "--scope orchestration:read --scope orchestration:operate --ttl 365d --label t3-sandbox-bridge",
        );
        expect(fake.commands.some((command) => command.includes(bridgeToken))).toBe(false);
      }).pipe(
        Effect.provide(
          provisionerLayer({}, repository.layer, {
            configs: memoryConfigs().layer,
            secrets: secrets.layer,
          }),
        ),
        Effect.provideService(HttpClient.HttpClient, fake.client),
      );
    },
  );

  it.effect("links a host project to the sandbox, reusing a credential that is still fresh", () => {
    const fake = boatFake();
    const repository = memoryRepository();
    const secrets = memorySecrets();
    return Effect.gen(function* () {
      const { provisioner, instanceId } = yield* launchedThread;
      const hostProjectId = ProjectId.make("project-lightweight");
      const linked = yield* provisioner.linkBridge({ threadId, hostProjectId });
      expect(linked).toMatchObject({ instanceId, hostProjectId });
      expect(repository.records.get(instanceId)?.hostProjectId).toBe(hostProjectId);
      expect(bridgeIssues(fake)).toHaveLength(1);
      expect(bridgeLinkOf(secrets)?.token).toBe(bridgeToken);

      const unknown = yield* provisioner
        .linkBridge({ threadId: ThreadId.make("thread-elsewhere"), hostProjectId })
        .pipe(Effect.flip);
      expect(unknown.detail).toBe("No sandbox belongs to this thread.");
    }).pipe(
      Effect.provide(
        provisionerLayer({}, repository.layer, {
          configs: memoryConfigs().layer,
          secrets: secrets.layer,
        }),
      ),
      Effect.provideService(HttpClient.HttpClient, fake.client),
    );
  });

  it.effect("re-mints a bridge credential near its expiry, revoking the old one", () => {
    // The test clock starts at the epoch, so this one has days left.
    const fake = boatFake({ bridgeExpiresAt: "1970-01-10T00:00:00.000Z" });
    const repository = memoryRepository();
    const secrets = memorySecrets();
    return Effect.gen(function* () {
      const { provisioner, instanceId } = yield* launchedThread;
      yield* provisioner.linkBridge({ threadId, hostProjectId: projectId });
      expect(bridgeIssues(fake)).toHaveLength(2);
      expect(bridgeIssues(fake)[1]).toContain("t3 auth session revoke bridge-session-1");
      expect(repository.records.get(instanceId)?.bridge?.sessionId).toBe("bridge-session-2");
    }).pipe(
      Effect.provide(
        provisionerLayer({}, repository.layer, {
          configs: memoryConfigs().layer,
          secrets: secrets.layer,
        }),
      ),
      Effect.provideService(HttpClient.HttpClient, fake.client),
    );
  });

  it.effect("refreshes the bridge's link on resume and renews a credential near expiry", () => {
    const fake = boatFake({ bridgeExpiresAt: "1970-01-10T00:00:00.000Z" });
    const repository = memoryRepository();
    const secrets = memorySecrets();
    return Effect.gen(function* () {
      const { provisioner, instanceId } = yield* launchedThread;
      yield* provisioner.stop({ instanceId });
      const resumed = yield* provisioner.resume({ instanceId });
      expect(resumed.sandbox.bridge?.sessionId).toBe("bridge-session-2");
      expect(repository.records.get(instanceId)?.bridge?.sessionId).toBe("bridge-session-2");
      expect(bridgeLinkOf(secrets)?.httpBaseUrl).toBe(resumed.httpBaseUrl);
    }).pipe(
      Effect.provide(
        provisionerLayer({}, repository.layer, {
          configs: memoryConfigs().layer,
          secrets: secrets.layer,
        }),
      ),
      Effect.provideService(HttpClient.HttpClient, fake.client),
    );
  });

  it.effect("removes the bridge's credential with its sandbox", () => {
    const fake = boatFake();
    const repository = memoryRepository();
    const secrets = memorySecrets();
    return Effect.gen(function* () {
      const { provisioner, instanceId } = yield* launchedThread;
      expect(bridgeLinkOf(secrets)).toBeDefined();
      yield* provisioner.delete({ provider: "boat", instanceId, sandboxId: boatSandboxId });
      expect(bridgeLinkOf(secrets)).toBeUndefined();
    }).pipe(
      Effect.provide(
        provisionerLayer({}, repository.layer, {
          configs: memoryConfigs().layer,
          secrets: secrets.layer,
        }),
      ),
      Effect.provideService(HttpClient.HttpClient, fake.client),
    );
  });

  // This server's Claude talks to an endpoint only its tailnet reaches.
  const privateClaude = {
    claude: { baseUrl: "https://100.92.23.53", authToken: Redacted.make("host-claude-token") },
  };
  const tailscaleSettings = {
    sandboxTailscale: { clientId: "kCLIENT", clientSecret: "tskey-client-kCLIENT-x", tag: "" },
  } as const;

  it.effect("joins the tailnet on its own when Claude's endpoint is private", () => {
    const fake = boatFake();
    const configs = memoryConfigs();
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      // Saved before Tailscale was set up, so it does not ask to join.
      const { config } = yield* provisioner.saveConfig({
        config: { ...configInput, joinTailnet: false, claude: { baseUrl: "https://100.92.23.53" } },
        apiKey: "boat_test",
      });
      yield* provisioner.launch({ configId: config.id, threadId, project });
      yield* snapshotWhere(provisioner, (snapshot) => snapshot.awaitingHandoff);
      expect(fake.requests).toContain("POST https://api.tailscale.com/api/v2/tailnet/-/keys");
      expect(fake.commands.some((command) => command.includes("--auth-key="))).toBe(true);
    }).pipe(
      Effect.provide(
        provisionerLayer(tailscaleSettings, discardingRepository, {
          configs: configs.layer,
          host: privateClaude,
        }),
      ),
      Effect.provideService(HttpClient.HttpClient, fake.client),
    );
  });

  it.effect("stays off the tailnet when Claude's endpoint is public", () => {
    const fake = boatFake();
    const configs = memoryConfigs();
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      const { config } = yield* provisioner.saveConfig({
        config: { ...configInput, claude: { baseUrl: "https://api.example.test" } },
        apiKey: "boat_test",
      });
      yield* provisioner.launch({ configId: config.id, threadId, project });
      yield* snapshotWhere(provisioner, (snapshot) => snapshot.awaitingHandoff);
      expect(fake.requests.some((request) => request.includes("api.tailscale.com"))).toBe(false);
    }).pipe(
      Effect.provide(
        provisionerLayer(tailscaleSettings, discardingRepository, {
          configs: configs.layer,
          host: {
            claude: { baseUrl: "https://api.example.test", authToken: Redacted.make("t") },
          },
        }),
      ),
      Effect.provideService(HttpClient.HttpClient, fake.client),
    );
  });

  it.effect(
    "refuses before anything bills when the endpoint is private and Tailscale is not set up",
    () => {
      const fake = boatFake();
      const configs = memoryConfigs();
      return Effect.gen(function* () {
        const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
        const { config } = yield* provisioner.saveConfig({
          config: { ...configInput, claude: { baseUrl: "https://100.92.23.53" } },
          apiKey: "boat_test",
        });
        yield* provisioner.launch({ configId: config.id, threadId, project });
        const failed = yield* snapshotWhere(provisioner, (snapshot) => snapshot.phase === "failed");
        expect(failed.error).toBe(
          "The sandbox can't reach 100.92.23.53, which only your private network or tailnet reaches. Set up Tailscale under Sandboxes in Settings → Connections so sandboxes can join your tailnet.",
        );
        // The card points at the Tailscale setup rather than starting the same sandbox again.
        expect(failed.recovery).toBe("set-up-tailscale");
        expect(stageOf(failed, "preflight")?.status).toBe("failed");
        expect(stageOf(failed, "create")?.status).toBe("pending");
        expect(fake.requests.filter((request) => request.startsWith("POST"))).toEqual([]);

        // Starting again reads the config as it is now.
        yield* provisioner.saveConfig({
          config: { ...config, claude: { baseUrl: "https://api.example.test" } },
        });
        yield* provisioner.retryLaunch({ threadId });
        yield* snapshotWhere(provisioner, (snapshot) => snapshot.awaitingHandoff);
      }).pipe(
        Effect.provide(
          provisionerLayer({}, discardingRepository, {
            configs: configs.layer,
            host: privateClaude,
          }),
        ),
        Effect.provideService(HttpClient.HttpClient, fake.client),
      );
    },
  );

  it.effect("fails setup instead of handing off when the sandbox cannot reach Claude", () => {
    const fake = boatFake({ endpointStatus: "000" });
    const repository = memoryRepository();
    const configs = memoryConfigs();
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      const { config } = yield* provisioner.saveConfig({
        config: { ...configInput, claude: { baseUrl: "https://api.example.test" } },
        apiKey: "boat_test",
      });
      yield* provisioner.launch({ configId: config.id, threadId, project });
      // A thread on this sandbox would sit on Thinking while Claude retries forever.
      const failed = yield* snapshotWhere(provisioner, (snapshot) => snapshot.phase === "failed");
      expect(failed.awaitingHandoff).toBe(false);
      expect(stageOf(failed, "credentials")?.status).toBe("failed");
      expect(stageOf(failed, "pair")?.status).toBe("pending");
      expect(failed.error).toBe(
        "The sandbox cannot reach api.example.test. Check that it accepts connections from the internet, or use another endpoint.",
      );
      expect(failed.recovery).toBe("relaunch");
      expect(deletes(fake)).toHaveLength(1);
      expect(repository.records.size).toBe(0);
    }).pipe(
      Effect.provide(
        provisionerLayer({}, repository.layer, {
          configs: configs.layer,
          host: { claude: { baseUrl: "https://api.example.test", authToken: Redacted.make("t") } },
        }),
      ),
      Effect.provideService(HttpClient.HttpClient, fake.client),
    );
  });

  const agentConfig = { ...configInput, agentProviderAccess: true } as const;
  const agentEnvironmentName = /^t3-sandbox-hello-on-boat-small-[0-9a-f]{8}$/u;
  const boatSettings = { sandboxProviders: { boat: { apiKey: "boat_test" } } } as const;

  it.effect("lets the agent use Boat with a key scoped to its own sandbox and forks", () => {
    const fake = boatFake();
    const repository = memoryRepository();
    const configs = memoryConfigs();
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      const { config } = yield* provisioner.saveConfig({
        config: agentConfig,
        apiKey: "boat_test",
      });
      const { instanceId } = yield* provisioner.launch({ configId: config.id, threadId, project });
      yield* snapshotWhere(provisioner, (snapshot) => snapshot.awaitingHandoff);

      // The check, the environment and its lockdown all come before the machine that bills.
      const posts = fake.requests.filter((request) => !request.startsWith("GET"));
      const createAt = posts.indexOf("POST https://boat.dev/api/v1/sandboxes");
      expect(posts.slice(0, 3)).toEqual([
        "POST https://boat.dev/api/v1/api-keys/scoped",
        "POST https://boat.dev/api/v1/environments",
        "PUT https://boat.dev/api/v1/environments/env-1",
      ]);
      expect(createAt).toBe(3);
      const environment = fake.environments.find((candidate) => candidate.id === "env-1");
      expect(environment).toMatchObject({
        safeForThirdParties: true,
        passGithub: false,
        passSecrets: false,
        passSandboxCredentials: false,
        passAgentsCredentials: false,
      });
      expect(environment?.name).toMatch(agentEnvironmentName);
      const created = fake.bodies.find(
        (entry) => entry.url === "https://boat.dev/api/v1/sandboxes",
      )?.body;
      expect(created).toMatchObject({ environment: environment?.name });
      expect(created).not.toHaveProperty("noEnv");

      // Scoped to this sandbox and its environment, and no longer than the running limit.
      const minted = fake.bodies.filter(
        (entry) => entry.url === "https://boat.dev/api/v1/api-keys/scoped",
      )[1]?.body;
      expect(minted).toEqual({
        name: environment?.name,
        ttl: "480m",
        actions: [
          "sandbox.create",
          "sandbox.read",
          "sandbox.stop",
          "sandbox.fork",
          "sandbox.delete-own",
          "exec",
          "file.read",
          "file.write",
          "host",
        ],
        sandboxIds: [boatSandboxId],
        environmentIds: ["env-1"],
      });
      // The key reaches the sandbox in a private file, never in a command's text.
      expect(fake.commands.some((command) => command.includes("boat login --key-stdin"))).toBe(
        true,
      );
      expect(fake.commands.some((command) => command.includes(agentKeySecret))).toBe(false);
      expect(
        fake.bodies.some(
          (entry) =>
            entry.url.endsWith("/files") && JSON.stringify(entry.body).includes(agentKeySecret),
        ),
      ).toBe(true);
      expect(repository.records.get(instanceId)?.agentProviderAccess).toEqual({
        environmentId: "env-1",
        environmentName: environment?.name,
        keyId: "apk_agent1",
      });
      // The sandbox's own environment is not a credential environment to pick.
      const picker = yield* provisioner.environments({ provider: "boat" });
      expect(picker.environments.map((candidate) => candidate.name)).toEqual(["base"]);

      yield* provisioner.pairLaunch({ threadId });
      yield* provisioner.completeLaunch({ threadId });
      // The agent forked its sandbox; the fork carries no tag, only the environment.
      fake.inEnvironments.push(
        { id: "bx_fork1", name: "hello on Boat small fork", environment: environment!.name },
        { id: "bx_elsewhere", name: "someone else's", environment: "base" },
      );
      yield* provisioner.sweep;
      expect((yield* provisioner.list).orphans).toEqual([
        {
          provider: "boat",
          sandboxId: "bx_fork1",
          name: "hello on Boat small fork",
          forkOf: instanceId,
        },
      ]);
      // The sweep lists forks and never deletes them.
      expect(deletes(fake)).toEqual([]);

      const removed = yield* provisioner.delete({
        provider: "boat",
        sandboxId: boatSandboxId,
        instanceId,
      });
      expect(removed.warnings).toEqual([]);
      expect(deletes(fake)).toEqual([
        "DELETE https://boat.dev/api/v1/api-keys/apk_agent1",
        "DELETE https://boat.dev/api/v1/sandboxes/bx_fork1",
        `DELETE https://boat.dev/api/v1/sandboxes/${boatSandboxId}`,
        "DELETE https://boat.dev/api/v1/environments/env-1",
        "DELETE https://boat.dev/api/v1/api-keys/apk_keepalive1",
      ]);
      expect(fake.keys.size).toBe(0);
      expect(fake.environments.map((candidate) => candidate.name)).toEqual(["base"]);
      expect(fake.inEnvironments.map((sandbox) => sandbox.id)).toEqual(["bx_elsewhere"]);
      expect((yield* provisioner.list).orphans).toEqual([]);
    }).pipe(
      Effect.provide(provisionerLayer({}, repository.layer, { configs: configs.layer })),
      Effect.provideService(HttpClient.HttpClient, fake.client),
    );
  });

  it.effect("refuses before anything bills when the Boat key cannot make scoped keys", () => {
    const fake = boatFake({ scopedKeys: "limited" });
    const configs = memoryConfigs();
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      const { config } = yield* provisioner.saveConfig({
        config: agentConfig,
        apiKey: "boat_test",
      });
      yield* provisioner.launch({ configId: config.id, threadId, project });
      const failed = yield* snapshotWhere(provisioner, (snapshot) => snapshot.phase === "failed");
      expect(failed.error).toBe(
        "Your Boat key can't create scoped keys; use an admin key or turn off Let the agent use Boat.",
      );
      expect(stageOf(failed, "preflight")?.status).toBe("failed");
      expect(fake.requests.filter((request) => request.startsWith("POST"))).toEqual([
        "POST https://boat.dev/api/v1/api-keys/scoped",
      ]);

      // A credential environment would pass its secrets into the forks too.
      const refused = yield* provisioner
        .saveConfig({ config: { ...agentConfig, credentialEnvironment: "base" } })
        .pipe(Effect.flip);
      expect(refused.detail).toBe(
        "Letting the agent use Boat needs a sandbox without a Boat environment. Pick No credentials, or turn it off.",
      );
    }).pipe(
      Effect.provide(provisionerLayer({}, discardingRepository, { configs: configs.layer })),
      Effect.provideService(HttpClient.HttpClient, fake.client),
    );
  });

  it.effect(
    "revokes the agent's key and deletes its environment when a launch is cancelled",
    () => {
      const fake = boatFake();
      const repository = memoryRepository();
      const configs = memoryConfigs();
      return Effect.gen(function* () {
        const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
        const { config } = yield* provisioner.saveConfig({
          config: agentConfig,
          apiKey: "boat_test",
        });
        yield* provisioner.launch({ configId: config.id, threadId, project });
        yield* snapshotWhere(provisioner, (snapshot) => snapshot.awaitingHandoff);
        expect(yield* provisioner.cancelLaunch({ threadId })).toEqual({ cancelled: true });
        yield* Effect.yieldNow;
        const released = deletes(fake);
        expect(released).toContain("DELETE https://boat.dev/api/v1/api-keys/apk_agent1");
        // The environment goes only after the sandbox in it.
        expect(
          released.indexOf(`DELETE https://boat.dev/api/v1/sandboxes/${boatSandboxId}`),
        ).toBeLessThan(released.indexOf("DELETE https://boat.dev/api/v1/environments/env-1"));
        expect(fake.keys.size).toBe(0);
        expect(fake.environments.map((candidate) => candidate.name)).toEqual(["base"]);
        expect(repository.records.size).toBe(0);
      }).pipe(
        Effect.provide(provisionerLayer({}, repository.layer, { configs: configs.layer })),
        Effect.provideService(HttpClient.HttpClient, fake.client),
      );
    },
  );

  it.effect("keeps the sandbox and revokes the key when the boat CLI cannot sign in", () => {
    const fake = boatFake({ failing: { text: "boat login", times: 1 } });
    const repository = memoryRepository();
    const configs = memoryConfigs();
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      const { config } = yield* provisioner.saveConfig({
        config: agentConfig,
        apiKey: "boat_test",
      });
      const { instanceId } = yield* provisioner.launch({ configId: config.id, threadId, project });
      const waiting = yield* snapshotWhere(provisioner, (snapshot) => snapshot.awaitingHandoff);
      expect(waiting.warnings).toContain(
        "The Boat CLI could not be signed in on the sandbox, so the agent cannot use Boat. T3 Code revoked its key.",
      );
      // Only the key the running sandbox keeps itself up with is left.
      expect([...fake.keys]).toEqual(["apk_keepalive1"]);
      // The sandbox still runs in its environment, so the record keeps it without a key.
      expect(repository.records.get(instanceId)?.agentProviderAccess).toEqual({
        environmentId: "env-1",
        environmentName: expect.stringMatching(agentEnvironmentName),
      });
    }).pipe(
      Effect.provide(provisionerLayer({}, repository.layer, { configs: configs.layer })),
      Effect.provideService(HttpClient.HttpClient, fake.client),
    );
  });

  it.effect("revokes a key Boat scoped wider than the sandbox and says so", () => {
    const fake = boatFake({ scopedKeys: "wide" });
    const repository = memoryRepository();
    const configs = memoryConfigs();
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      const { config } = yield* provisioner.saveConfig({
        config: agentConfig,
        apiKey: "boat_test",
      });
      const { instanceId } = yield* provisioner.launch({ configId: config.id, threadId, project });
      const waiting = yield* snapshotWhere(provisioner, (snapshot) => snapshot.awaitingHandoff);
      expect(waiting.warnings).toContain(
        "T3 Code could not make a Boat key for the agent, so it cannot use Boat on this sandbox.",
      );
      expect([...fake.keys]).toEqual(["apk_keepalive1"]);
      expect(fake.commands.some((command) => command.includes("boat login"))).toBe(false);
      expect(repository.records.get(instanceId)?.agentProviderAccess?.keyId).toBeUndefined();
    }).pipe(
      Effect.provide(provisionerLayer({}, repository.layer, { configs: configs.layer })),
      Effect.provideService(HttpClient.HttpClient, fake.client),
    );
  });

  const runningRecord: SandboxRecord = {
    instanceId: "checked",
    environmentId: testEnvironmentId,
    provider: "boat",
    sandboxId: boatSandboxId,
    label: "hello on Boat small",
    size: "small",
    state: "running",
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
    httpBaseUrl: "https://boat.example/t3",
    runningSince: "1970-01-01T00:00:00.000Z",
    maxRunningMinutes: 480,
    threadId,
    repoDir: "/home/boat/work/hello",
  };

  it.effect("checks a running sandbox's clone for work a delete would lose", () =>
    Effect.gen(function* () {
      const check = (record: SandboxRecord, work?: string) =>
        Effect.gen(function* () {
          const fake = boatFake(work === undefined ? {} : { work });
          const result = yield* SandboxProvisioner.SandboxProvisioner.pipe(
            Effect.flatMap((provisioner) =>
              provisioner.checkWork({ instanceId: record.instanceId }),
            ),
            Effect.provide(provisionerLayer(boatSettings, memoryRepository([record]).layer)),
            Effect.provideService(HttpClient.HttpClient, fake.client),
          );
          return { result, commands: fake.commands };
        });

      const clean = yield* check(runningRecord);
      expect(clean.result).toEqual({ status: "clean", uncommittedFiles: 0, unpushedCommits: 0 });
      expect(clean.commands[0]).toContain("/home/boat/work/hello");
      expect(clean.commands[0]).toContain("--not --remotes");

      const dirty = yield* check(runningRecord, "T3_WORK:3:2");
      expect(dirty.result).toEqual({ status: "dirty", uncommittedFiles: 3, unpushedCommits: 2 });

      // A stopped sandbox is not started just to look.
      const stopped = yield* check({ ...runningRecord, state: "stopped", runningSince: null });
      expect(stopped.result).toMatchObject({ status: "unknown" });
      expect(stopped.commands).toEqual([]);

      const garbled = yield* check(runningRecord, "something else");
      expect(garbled.result).toMatchObject({
        status: "unknown",
        detail: "The sandbox did not answer in time.",
      });

      const { repoDir: _repoDir, ...older } = runningRecord;
      const unknownDir = yield* check(older);
      expect(unknownDir.result).toMatchObject({ status: "unknown" });
      expect(unknownDir.commands).toEqual([]);
    }),
  );

  it.effect("releases an abandoned launch Boat no longer has but leaves its forks", () => {
    const abandoned: SandboxRecord = {
      instanceId: "abandoned",
      environmentId: null,
      provider: "boat",
      sandboxId: "bx_abandon",
      label: "hello on Boat small",
      size: "small",
      state: "provisioning",
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
      httpBaseUrl: "",
      runningSince: "1970-01-01T00:00:00.000Z",
      maxRunningMinutes: 480,
      agentProviderAccess: {
        environmentId: "env-1",
        environmentName: "t3-sandbox-hello-on-boat-small-0badc0de",
        keyId: "apk_agent1",
      },
    };
    const repository = memoryRepository([abandoned]);
    const fake = boatFake({
      states: { bx_abandon: "gone" },
      inEnvironments: [
        { id: "bx_abandon", name: "hello", environment: "t3-sandbox-hello-on-boat-small-0badc0de" },
        {
          id: "bx_fork1",
          name: "hello fork",
          environment: "t3-sandbox-hello-on-boat-small-0badc0de",
        },
      ],
    });
    fake.keys.add("apk_agent1");
    fake.environments.push({
      ...boatEnvironment("env-1", "t3-sandbox-hello-on-boat-small-0badc0de"),
      safeForThirdParties: true,
    });
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      // The bridge hears of every removed record, the sweep's too.
      const removed = yield* provisioner.removed.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* provisioner.sweep;
      expect(deletes(fake)).toEqual([
        "DELETE https://boat.dev/api/v1/api-keys/apk_agent1",
        "DELETE https://boat.dev/api/v1/sandboxes/bx_abandon",
      ]);
      expect([...(yield* Fiber.join(removed))].map((record) => record.instanceId)).toEqual([
        "abandoned",
      ]);
      expect(fake.environments.map((candidate) => candidate.id)).toEqual(["env-base", "env-1"]);
      expect(repository.records.size).toBe(0);
    }).pipe(
      Effect.provide(provisionerLayer(boatSettings, repository.layer)),
      Effect.provideService(HttpClient.HttpClient, fake.client),
    );
  });

  it.effect("deletes the machine when install fails and offers a relaunch", () => {
    const fake = boatFake({ failing: { text: "t3.codes/install.sh", times: 1 } });
    const repository = memoryRepository();
    const configs = memoryConfigs();
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      const { config } = yield* provisioner.saveConfig({
        config: configInput,
        apiKey: "boat_test",
      });
      yield* provisioner.launch({ configId: config.id, threadId, project });
      const failed = yield* snapshotWhere(provisioner, (snapshot) => snapshot.phase === "failed");
      expect(failed.recovery).toBe("relaunch");
      expect(stageOf(failed, "create")?.status).toBe("done");
      expect(stageOf(failed, "install")?.status).toBe("failed");
      expect(failed.error).not.toContain("boom");
      expect(deletes(fake)).toEqual([`DELETE https://boat.dev/api/v1/sandboxes/${boatSandboxId}`]);
      expect(repository.records.size).toBe(0);

      // A relaunch is a new machine; this time install works.
      yield* provisioner.retryLaunch({ threadId });
      const waiting = yield* snapshotWhere(provisioner, (snapshot) => snapshot.awaitingHandoff);
      expect(waiting.instanceId).not.toBe(failed.instanceId);
      expect(repository.records.size).toBe(1);
    }).pipe(
      Effect.provide(provisionerLayer({}, repository.layer, { configs: configs.layer })),
      Effect.provideService(HttpClient.HttpClient, fake.client),
    );
  });

  it.effect("keeps the machine when the clone fails, retries it, and cleans up on cancel", () => {
    const fake = boatFake({ failing: { text: "git clone", times: 1 } });
    const repository = memoryRepository();
    const configs = memoryConfigs();
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      const { config } = yield* provisioner.saveConfig({
        config: configInput,
        apiKey: "boat_test",
      });
      yield* provisioner.launch({ configId: config.id, threadId, project });
      const failed = yield* snapshotWhere(provisioner, (snapshot) => snapshot.phase === "failed");
      expect(failed.recovery).toBe("retry");
      expect(stageOf(failed, "repo")?.status).toBe("failed");
      expect(failed.error).toContain("Could not clone octo/hello");
      expect(deletes(fake)).toEqual([]);

      yield* provisioner.retryLaunch({ threadId });
      const waiting = yield* snapshotWhere(provisioner, (snapshot) => snapshot.awaitingHandoff);
      expect(waiting.instanceId).toBe(failed.instanceId);
      expect(stageOf(waiting, "repo")?.status).toBe("done");

      // Cancelling at the handoff deletes the machine and its record.
      expect(yield* provisioner.cancelLaunch({ threadId })).toEqual({ cancelled: true });
      const cancelled = yield* snapshotWhere(
        provisioner,
        (snapshot) => snapshot.phase === "cancelled",
      );
      expect(stageOf(cancelled, "pair")?.status).toBe("skipped");
      expect(deletes(fake)).toEqual([
        `DELETE https://boat.dev/api/v1/sandboxes/${boatSandboxId}`,
        "DELETE https://boat.dev/api/v1/api-keys/apk_keepalive1",
      ]);
      expect(repository.records.size).toBe(0);
    }).pipe(
      Effect.provide(provisionerLayer({}, repository.layer, { configs: configs.layer })),
      Effect.provideService(HttpClient.HttpClient, fake.client),
    );
  });

  it.effect("cancels a launch mid-install and deletes what it made", () =>
    Effect.gen(function* () {
      const until = yield* Deferred.make<void>();
      const fake = boatFake({ holding: { text: "t3.codes/install.sh", until } });
      const repository = memoryRepository();
      const configs = memoryConfigs();
      yield* Effect.gen(function* () {
        const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
        const { config } = yield* provisioner.saveConfig({
          config: configInput,
          apiKey: "boat_test",
        });
        yield* provisioner.launch({ configId: config.id, threadId, project });
        yield* snapshotWhere(
          provisioner,
          (snapshot) => stageOf(snapshot, "install")?.status === "running",
        );
        expect(repository.records.size).toBe(1);

        expect(yield* provisioner.cancelLaunch({ threadId })).toEqual({ cancelled: true });
        const cancelled = yield* snapshotWhere(
          provisioner,
          (snapshot) => snapshot.phase === "cancelled",
        );
        expect(stageOf(cancelled, "install")?.status).toBe("skipped");
        expect(deletes(fake)).toEqual([
          `DELETE https://boat.dev/api/v1/sandboxes/${boatSandboxId}`,
        ]);
        expect(repository.records.size).toBe(0);
      }).pipe(
        Effect.provide(provisionerLayer({}, repository.layer, { configs: configs.layer })),
        Effect.provideService(HttpClient.HttpClient, fake.client),
      );
    }),
  );

  // A launch held at install, so a test can act on it while it is still starting.
  const heldLaunch = (fake: BoatFake) =>
    Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      const { config } = yield* provisioner.saveConfig({
        config: configInput,
        apiKey: "boat_test",
      });
      const { instanceId } = yield* provisioner.launch({ configId: config.id, threadId, project });
      yield* snapshotWhere(
        provisioner,
        (snapshot) => stageOf(snapshot, "install")?.status === "running",
      );
      return { provisioner, config, instanceId, fake };
    });

  const sandboxCreates = (fake: BoatFake) =>
    fake.requests.filter((request) => request === "POST https://boat.dev/api/v1/sandboxes");

  it.effect("follows a launch already starting instead of refusing a second send", () =>
    Effect.gen(function* () {
      const until = yield* Deferred.make<void>();
      const fake = boatFake({ holding: { text: "t3.codes/install.sh", until } });
      const repository = memoryRepository();
      yield* Effect.gen(function* () {
        const { provisioner, config, instanceId } = yield* heldLaunch(fake);
        // The user left the thread mid-launch and sent again on it.
        const again = yield* provisioner.launch({ configId: config.id, threadId, project });
        expect(again.instanceId).toBe(instanceId);
        expect(sandboxCreates(fake)).toHaveLength(1);

        yield* Deferred.succeed(until, undefined);
        const waiting = yield* snapshotWhere(provisioner, (snapshot) => snapshot.awaitingHandoff);
        expect(waiting.instanceId).toBe(instanceId);
        yield* provisioner.pairLaunch({ threadId });
        yield* provisioner.completeLaunch({ threadId });
        expect(repository.records.get(instanceId)?.state).toBe("running");
        expect(deletes(fake)).toEqual([]);
      }).pipe(
        Effect.provide(provisionerLayer({}, repository.layer)),
        Effect.provideService(HttpClient.HttpClient, fake.client),
      );
    }),
  );

  it.effect("keeps a thread on its one sandbox when a client launches it again", () => {
    const fake = boatFake();
    const repository = memoryRepository();
    return Effect.gen(function* () {
      const { provisioner, instanceId } = yield* launchedThread;
      const configId = repository.records.get(instanceId)!.configId!;
      // A client that lost the handoff sends again once the launch has ended.
      const again = yield* provisioner.launch({ configId, threadId, project });
      expect(again.instanceId).toBe(instanceId);
      repository.records.set(instanceId, {
        ...repository.records.get(instanceId)!,
        state: "stopped",
      });
      const stopped = yield* provisioner.launch({ configId, threadId, project });
      expect(stopped.instanceId).toBe(instanceId);
      // Its disk gone, it is still the thread's until the user deletes it.
      repository.records.set(instanceId, {
        ...repository.records.get(instanceId)!,
        state: "expired",
      });
      const expired = yield* provisioner.launch({ configId, threadId, project });
      expect(expired.instanceId).toBe(instanceId);

      expect(sandboxCreates(fake)).toHaveLength(1);
      expect(deletes(fake)).toEqual([]);
      expect([...repository.records.keys()]).toEqual([instanceId]);
      // No new launch began, so no card offers to set one up.
      expect((yield* snapshotWhere(provisioner, () => true)).phase).toBe("done");
    }).pipe(
      Effect.provide(provisionerLayer({}, repository.layer)),
      Effect.provideService(HttpClient.HttpClient, fake.client),
    );
  });

  it.effect("replaces a starting launch whose sandbox was deleted outside T3 Code", () =>
    Effect.gen(function* () {
      const until = yield* Deferred.make<void>();
      const fake = boatFake({ holding: { text: "t3.codes/install.sh", until } });
      const repository = memoryRepository();
      yield* Effect.gen(function* () {
        const { provisioner, config, instanceId } = yield* heldLaunch(fake);
        fake.states[boatSandboxId] = "gone";
        const fresh = yield* provisioner.launch({ configId: config.id, threadId, project });
        expect(fresh.instanceId).not.toBe(instanceId);
        // The stale launch released what it made before the new one began.
        expect(repository.records.has(instanceId)).toBe(false);
        expect(deletes(fake)).toEqual([
          `DELETE https://boat.dev/api/v1/sandboxes/${boatSandboxId}`,
        ]);
        delete fake.states[boatSandboxId];
        yield* Deferred.succeed(until, undefined);
        const waiting = yield* snapshotWhere(provisioner, (snapshot) => snapshot.awaitingHandoff);
        expect(waiting.instanceId).toBe(fresh.instanceId);
      }).pipe(
        Effect.provide(provisionerLayer({}, repository.layer)),
        Effect.provideService(HttpClient.HttpClient, fake.client),
      );
    }),
  );

  it.effect("stops a launch when the sweep finds its sandbox deleted outside T3 Code", () =>
    Effect.gen(function* () {
      const until = yield* Deferred.make<void>();
      const fake = boatFake({ holding: { text: "t3.codes/install.sh", until } });
      const repository = memoryRepository();
      yield* Effect.gen(function* () {
        const { provisioner, config, instanceId } = yield* heldLaunch(fake);
        // A sweep while it starts leaves a machine Boat still has alone.
        yield* provisioner.sweep;
        expect(repository.records.get(instanceId)?.state).toBe("provisioning");

        fake.states[boatSandboxId] = "gone";
        yield* provisioner.sweep;
        const failed = yield* snapshotWhere(provisioner, (snapshot) => snapshot.phase === "failed");
        expect(failed).toMatchObject({ instanceId, recovery: "relaunch" });
        expect(failed.error).toContain("deleted outside T3 Code");
        expect(repository.records.size).toBe(0);

        // The thread is free to start again.
        delete fake.states[boatSandboxId];
        const fresh = yield* provisioner.launch({ configId: config.id, threadId, project });
        expect(fresh.instanceId).not.toBe(instanceId);
      }).pipe(
        Effect.provide(provisionerLayer({}, repository.layer)),
        Effect.provideService(HttpClient.HttpClient, fake.client),
      );
    }),
  );

  it.effect("deleting a starting sandbox stops its launch and frees the thread", () =>
    Effect.gen(function* () {
      const until = yield* Deferred.make<void>();
      const fake = boatFake({ holding: { text: "t3.codes/install.sh", until } });
      const repository = memoryRepository();
      yield* Effect.gen(function* () {
        const { provisioner, config, instanceId } = yield* heldLaunch(fake);
        yield* provisioner.delete({ provider: "boat", sandboxId: boatSandboxId, instanceId });
        yield* snapshotWhere(provisioner, (snapshot) => snapshot.phase === "cancelled");
        expect(repository.records.size).toBe(0);
        expect(deletes(fake)).toEqual([
          `DELETE https://boat.dev/api/v1/sandboxes/${boatSandboxId}`,
        ]);
        const fresh = yield* provisioner.launch({ configId: config.id, threadId, project });
        expect(fresh.instanceId).not.toBe(instanceId);
      }).pipe(
        Effect.provide(provisionerLayer({}, repository.layer)),
        Effect.provideService(HttpClient.HttpClient, fake.client),
      );
    }),
  );

  it.effect("gives up on a client that never connects and deletes the sandbox", () => {
    const fake = boatFake();
    const repository = memoryRepository();
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      const { config } = yield* provisioner.saveConfig({
        config: configInput,
        apiKey: "boat_test",
      });
      const { instanceId } = yield* provisioner.launch({ configId: config.id, threadId, project });
      yield* snapshotWhere(provisioner, (snapshot) => snapshot.awaitingHandoff);
      yield* TestClock.adjust("9 minutes");
      // Pairing is the client at work, so the wait starts over.
      yield* provisioner.pairLaunch({ threadId });
      yield* TestClock.adjust("9 minutes");
      expect((yield* snapshotWhere(provisioner, () => true)).phase).toBe("running");
      expect(deletes(fake)).toEqual([]);

      yield* TestClock.adjust("2 minutes");
      const failed = yield* snapshotWhere(provisioner, (snapshot) => snapshot.phase === "failed");
      expect(failed).toMatchObject({ instanceId, recovery: "relaunch" });
      expect(failed.error).toContain("Nothing connected to this sandbox for 10 minutes");
      expect(stageOf(failed, "pair")?.status).toBe("failed");
      expect(deletes(fake)).toEqual([
        `DELETE https://boat.dev/api/v1/sandboxes/${boatSandboxId}`,
        "DELETE https://boat.dev/api/v1/api-keys/apk_keepalive1",
      ]);
      expect(repository.records.size).toBe(0);
      // A late completion finds nothing to finish.
      expect((yield* provisioner.completeLaunch({ threadId }).pipe(Effect.flip)).detail).toContain(
        "not ready",
      );
    }).pipe(
      Effect.provide(provisionerLayer({}, repository.layer)),
      Effect.provideService(HttpClient.HttpClient, fake.client),
    );
  });

  it.effect("gives up on a failed stage nobody retries and deletes the sandbox", () => {
    const fake = boatFake({ failing: { text: "git clone", times: 1 } });
    const repository = memoryRepository();
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      const { config } = yield* provisioner.saveConfig({
        config: configInput,
        apiKey: "boat_test",
      });
      yield* provisioner.launch({ configId: config.id, threadId, project });
      yield* snapshotWhere(provisioner, (snapshot) => snapshot.recovery === "retry");
      yield* TestClock.adjust("11 minutes");
      const failed = yield* snapshotWhere(
        provisioner,
        (snapshot) => snapshot.phase === "failed" && snapshot.recovery === "relaunch",
      );
      expect(failed.error).toContain("Nothing connected to this sandbox");
      expect(deletes(fake)).toEqual([`DELETE https://boat.dev/api/v1/sandboxes/${boatSandboxId}`]);
      expect(repository.records.size).toBe(0);
    }).pipe(
      Effect.provide(provisionerLayer({}, repository.layer)),
      Effect.provideService(HttpClient.HttpClient, fake.client),
    );
  });

  it.effect(
    "keeps an abandoned launch's live sandbox as failed and replaces it on relaunch",
    () => {
      const abandoned: SandboxRecord = {
        instanceId: "abandoned",
        environmentId: null,
        configId: "config-gone",
        threadId,
        projectId,
        projectTitle: "hello",
        provider: "boat",
        sandboxId: "bx_alive",
        label: "hello on Boat small",
        size: "small",
        state: "provisioning",
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
        httpBaseUrl: "",
        runningSince: "1970-01-01T00:00:00.000Z",
        maxRunningMinutes: 480,
      };
      const repository = memoryRepository([abandoned]);
      const fake = boatFake({ states: { bx_alive: "idle" } });
      return Effect.gen(function* () {
        const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
        yield* TestClock.adjust("1 minute");
        yield* provisioner.sweep;
        // Boat still runs it: the user decides, so it shows as failed with Delete in the list.
        expect(deletes(fake)).toEqual([]);
        expect(repository.records.get("abandoned")).toMatchObject({
          state: "error",
          abandonedAt: "1970-01-01T00:01:00.000Z",
        });
        const card = yield* snapshotWhere(provisioner, (snapshot) => snapshot.phase === "failed");
        expect(card).toMatchObject({ instanceId: "abandoned", recovery: "relaunch" });
        expect(card.error).toContain("T3 Code stopped before this sandbox finished starting");
        // A later sweep leaves it as it is.
        yield* provisioner.sweep;
        expect(deletes(fake)).toEqual([]);
        expect(repository.records.get("abandoned")?.state).toBe("error");

        // Starting the thread again replaces it.
        const { config } = yield* provisioner.saveConfig({
          config: configInput,
          apiKey: "boat_test",
        });
        const fresh = yield* provisioner.launch({ configId: config.id, threadId, project });
        expect(deletes(fake)).toEqual(["DELETE https://boat.dev/api/v1/sandboxes/bx_alive"]);
        expect(repository.records.has("abandoned")).toBe(false);
        yield* snapshotWhere(provisioner, (snapshot) => snapshot.awaitingHandoff);
        expect([...repository.records.keys()]).toEqual([fresh.instanceId]);
      }).pipe(
        Effect.provide(provisionerLayer(boatSettings, repository.layer)),
        Effect.provideService(HttpClient.HttpClient, fake.client),
      );
    },
  );

  it.effect(
    "starts no sandbox in place of a lost launch whose machine Boat will not delete",
    () => {
      const abandoned: SandboxRecord = {
        instanceId: "abandoned",
        environmentId: null,
        threadId,
        provider: "boat",
        sandboxId: "bx_stuck",
        label: "hello on Boat small",
        size: "small",
        state: "error",
        abandonedAt: "1970-01-01T00:00:00.000Z",
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
        httpBaseUrl: "",
        runningSince: "1970-01-01T00:00:00.000Z",
        maxRunningMinutes: 480,
      };
      const repository = memoryRepository([abandoned]);
      const fake = boatFake({ states: { bx_stuck: "idle" }, undeletable: ["bx_stuck"] });
      return Effect.gen(function* () {
        const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
        const { config } = yield* provisioner.saveConfig({
          config: configInput,
          apiKey: "boat_test",
        });
        const refused = yield* provisioner
          .launch({ configId: config.id, threadId, project })
          .pipe(Effect.flip);
        expect(refused.detail).toContain("bx_stuck");
        // The old machine would keep billing beside a new one, so nothing new starts.
        expect(sandboxCreates(fake)).toEqual([]);
        expect(repository.records.get("abandoned")?.state).toBe("error");
      }).pipe(
        Effect.provide(provisionerLayer(boatSettings, repository.layer)),
        Effect.provideService(HttpClient.HttpClient, fake.client),
      );
    },
  );

  it.effect("releases an abandoned launch once Boat no longer has its sandbox", () => {
    const abandoned: SandboxRecord = {
      instanceId: "abandoned",
      environmentId: null,
      threadId,
      provider: "boat",
      sandboxId: "bx_later",
      label: "hello on Boat small",
      size: "small",
      state: "error",
      abandonedAt: "1970-01-01T00:00:00.000Z",
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
      httpBaseUrl: "",
      runningSince: "1970-01-01T00:00:00.000Z",
      maxRunningMinutes: 480,
    };
    const repository = memoryRepository([abandoned]);
    const fake = boatFake({ states: { bx_later: "gone" } });
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      yield* provisioner.sweep;
      expect(repository.records.size).toBe(0);
    }).pipe(
      Effect.provide(provisionerLayer(boatSettings, repository.layer)),
      Effect.provideService(HttpClient.HttpClient, fake.client),
    );
  });

  it.effect("launches a project that lives only on another machine", () => {
    const fake = boatFake();
    const repository = memoryRepository();
    const configs = memoryConfigs();
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      const { config } = yield* provisioner.saveConfig({
        config: configInput,
        apiKey: "boat_test",
      });
      const { instanceId } = yield* provisioner.launch({
        configId: config.id,
        threadId,
        project: remoteProject,
      });
      const waiting = yield* snapshotWhere(provisioner, (snapshot) => snapshot.awaitingHandoff);
      expect(stageOf(waiting, "repo")?.status).toBe("done");
      // Nothing on this machine to copy from, and nothing read from anywhere else.
      expect(stageOf(waiting, "env-files")?.status).toBe("skipped");
      expect(
        fake.commands.some((command) => command.includes("https://github.com/Octo/Hello.git")),
      ).toBe(true);
      expect(repository.records.get(instanceId)).toMatchObject({
        projectId: remoteProject.id,
        threadId,
      });
    }).pipe(
      Effect.provide(
        provisionerLayer({}, repository.layer, {
          configs: configs.layer,
          workspace: { ".env": "API_TOKEN=shh" },
        }),
      ),
      Effect.provideService(HttpClient.HttpClient, fake.client),
    );
  });

  it.effect("reads env files only from a project this host really has", () => {
    const fake = boatFake();
    const configs = memoryConfigs();
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      const { config } = yield* provisioner.saveConfig({
        config: configInput,
        apiKey: "boat_test",
      });
      // A host copy that names no project here, or another directory, is ignored.
      yield* provisioner.launch({
        configId: config.id,
        threadId,
        project: { ...remoteProject, hostCopy: { projectId, workspaceRoot: "/etc" } },
      });
      const waiting = yield* snapshotWhere(provisioner, (snapshot) => snapshot.awaitingHandoff);
      expect(stageOf(waiting, "env-files")?.status).toBe("skipped");
      expect(fake.commands.some((command) => command.includes("API_TOKEN"))).toBe(false);
    }).pipe(
      Effect.provide(
        provisionerLayer({}, discardingRepository, {
          configs: configs.layer,
          workspace: { ".env": "API_TOKEN=shh" },
        }),
      ),
      Effect.provideService(HttpClient.HttpClient, fake.client),
    );
  });

  it.effect("refuses a launch it cannot start before anything bills", () => {
    const fake = boatFake();
    const configs = memoryConfigs();
    return Effect.gen(function* () {
      const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
      const open = yield* provisioner.saveConfig({ config: configInput, apiKey: "boat_test" });
      const notGithub = yield* provisioner
        .launch({
          configId: open.config.id,
          threadId,
          project: { ...project, remoteUrl: "https://gitlab.com/octo/hello.git" },
        })
        .pipe(Effect.flip);
      expect(notGithub.detail).toBe(
        "Only projects with a github.com remote can start in a sandbox.",
      );
      const gone = yield* provisioner
        .launch({ configId: "missing", threadId, project })
        .pipe(Effect.flip);
      expect(gone.detail).toBe("This sandbox config no longer exists.");
      expect(fake.requests.filter((request) => request.startsWith("POST"))).toEqual([]);
    }).pipe(
      Effect.provide(provisionerLayer({}, discardingRepository, { configs: configs.layer })),
      Effect.provideService(HttpClient.HttpClient, fake.client),
    );
  });

  it.effect(
    "flags tagged sandboxes without a record and deletes a launch nobody is finishing",
    () => {
      const base: SandboxRecord = {
        instanceId: "tracked",
        environmentId: testEnvironmentId,
        provider: "boat",
        sandboxId: boatSandboxId,
        label: "hello on Boat small",
        size: "small",
        state: "running",
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
        httpBaseUrl: "https://boat.example/t3",
        runningSince: "1970-01-01T00:00:00.000Z",
        maxRunningMinutes: 480,
        threadId,
      };
      // The server restarted mid-launch: the record says provisioning, but no fiber owns it.
      const abandoned: SandboxRecord = {
        ...base,
        instanceId: "abandoned",
        environmentId: null,
        sandboxId: "bx_abandon",
        state: "provisioning",
      };
      const repository = memoryRepository([base, abandoned]);
      // Boat no longer has the abandoned launch's machine.
      const fake = boatFake({
        states: { bx_abandon: "gone" },
        listed: [
          { id: boatSandboxId, name: "hello on Boat small" },
          { id: "bx_orphan", name: "lost", labels: { "t3.code/instance": "gone" } },
        ],
      });
      return Effect.gen(function* () {
        const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
        yield* provisioner.sweep;
        expect(deletes(fake)).toEqual(["DELETE https://boat.dev/api/v1/sandboxes/bx_abandon"]);
        expect(repository.records.has("abandoned")).toBe(false);
        const listed = yield* provisioner.list;
        expect(listed.sandboxes.map((record) => record.instanceId)).toEqual(["tracked"]);
        // A tagged sandbox no record tracks is only reported; the user decides.
        expect(listed.orphans).toEqual([
          { provider: "boat", sandboxId: "bx_orphan", name: "lost", instanceId: "gone" },
        ]);

        // A thread's machine cannot become a template, since saving deletes its source.
        const refused = yield* provisioner
          .saveTemplate({ instanceId: "tracked", name: "web" })
          .pipe(Effect.flip);
        expect(refused.detail).toContain("cannot be saved as a template");

        yield* provisioner.delete({ provider: "boat", sandboxId: "bx_orphan" });
        expect(deletes(fake).at(-1)).toBe("DELETE https://boat.dev/api/v1/sandboxes/bx_orphan");
        expect((yield* provisioner.list).orphans).toEqual([]);
      }).pipe(
        Effect.provide(
          provisionerLayer(
            { sandboxProviders: { boat: { apiKey: "boat_test" } } },
            repository.layer,
          ),
        ),
        Effect.provideService(HttpClient.HttpClient, fake.client),
      );
    },
  );

  describe("agent tooling", () => {
    const appKey = NodeCrypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const toolingSettings = {
      sandboxTooling: {
        githubAppId: "42",
        githubAppSlug: "t3-sandboxes",
        githubAppOwner: "octo",
        githubAppPrivateKey: appKey.privateKey,
        mapleAdminKey: "maple_admin_KEY",
        northflankToken: "nf_shared_TOKEN",
        railwayToken: "railway_ws_TOKEN",
        railwayWorkspaceId: "ws_1",
        railwayWorkspaceName: "Omar's projects",
      },
    } as const;
    const toolingHost = {
      gitIdentity: { name: "Ada Lovelace", email: "ada@example.test" },
      mcpEntries: [
        {
          name: "maple",
          scope: "user" as const,
          config: {
            type: "http",
            url: "https://api.maple.dev/mcp",
            headers: { Authorization: "Bearer host_maple_KEY" },
          },
        },
        {
          name: "docs",
          scope: "user" as const,
          config: { type: "http", url: "https://docs.test/mcp" },
        },
        { name: "local", scope: "user" as const, config: { command: "railway" } },
        // The hosted server signs in with OAuth; a sandbox gets the CLI's stdio server instead.
        {
          name: "railway",
          scope: "user" as const,
          config: { type: "http", url: "https://mcp.railway.com" },
        },
      ],
      claudeFiles: [
        { path: "CLAUDE.md", content: "# Be kind" },
        { path: "skills/gh-stack/SKILL.md", content: "---\nname: gh-stack\n---" },
      ],
    };
    const toolingConfig = {
      ...configInput,
      githubApp: true,
      setupScript: "sudo apt-get install -y postgresql-client",
      mcpServers: ["maple", "docs", "local", "railway"],
      claudeMd: true,
      skills: ["gh-stack"],
      northflank: true,
      railway: true,
    } as const;
    const railwayTokenName = `t3-sandbox-${boatSandboxId}`;

    interface ServiceCalls {
      readonly calls: Array<{ method: string; url: string; auth?: string; body?: unknown }>;
      tokens: number;
      /** Railway operations as `operation variables`, all sent with the saved token. */
      readonly railway: Array<string>;
      /** Railway answers every request with "Not Authorized". */
      railwayDown: boolean;
    }

    // GitHub and Maple in front of the Boat fake, plus the answers T3's own scripts look for.
    const withServices = (
      fake: BoatFake,
      options: { readonly installed?: boolean; readonly setupExit?: number } = {},
    ) => {
      const state: ServiceCalls = { calls: [], tokens: 0, railway: [], railwayDown: false };
      const respond = (request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            status === 204 ? new Response(null, { status }) : Response.json(body, { status }),
          ),
        );
      const client = HttpClient.make((request) => {
        const body =
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : undefined;
        if (
          request.url.startsWith("https://api.github.com/") ||
          request.url.startsWith("https://api.maple.dev/")
        ) {
          state.calls.push({
            method: request.method,
            url: request.url,
            ...(request.headers.authorization === undefined
              ? {}
              : { auth: request.headers.authorization }),
            ...(body === undefined ? {} : { body }),
          });
          // Like GitHub, refuse a request that names no client.
          if (request.headers["user-agent"] === undefined) {
            return respond(request, { message: "Missing User-Agent" }, 403);
          }
        }
        if (request.url === "https://backboard.railway.com/graphql/v2") {
          expect(request.headers.authorization).toBe("Bearer railway_ws_TOKEN");
          const operation = /(apiTokenCreate|workspaceApiTokenDelete|workspaceApiTokens)/u.exec(
            body.query,
          )?.[1];
          state.railway.push(`${operation} ${JSON.stringify(body.variables)}`);
          if (state.railwayDown)
            return respond(request, { errors: [{ message: "Not Authorized" }] });
          if (operation === "apiTokenCreate") {
            return respond(request, { data: { apiTokenCreate: "rw_SANDBOX" } });
          }
          if (operation === "workspaceApiTokens") {
            return respond(request, {
              data: {
                workspaceApiTokens: {
                  edges: [
                    { node: { id: "tok_saved", name: "t3 sandboxes" } },
                    { node: { id: "tok_sandbox", name: railwayTokenName } },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            });
          }
          return respond(request, { data: { workspaceApiTokenDelete: true } });
        }
        if (request.url === "https://api.github.com/repos/octo/hello/installation") {
          return options.installed === false
            ? respond(request, { message: "Not Found" }, 404)
            : respond(request, { id: 7 });
        }
        if (request.url === "https://api.github.com/app/installations/7/access_tokens") {
          state.tokens += 1;
          return respond(
            request,
            { token: `ghs_SANDBOX${state.tokens}`, expires_at: "1970-01-01T01:00:00Z" },
            201,
          );
        }
        if (request.url === "https://api.github.com/installation/token")
          return respond(request, null, 204);
        if (request.url === "https://api.maple.dev/v2/api_keys") {
          return respond(request, { id: "key_sandbox", secret: "maple_ak_SANDBOX" });
        }
        if (request.url.startsWith("https://api.maple.dev/v2/api_keys/"))
          return respond(request, {});
        if (request.url.endsWith("/commands")) {
          const command: string = body?.command ?? "";
          if (command.includes("setup-scripts")) {
            fake.commands.push(command);
            return respond(request, {
              exitCode: 0,
              stdout:
                options.setupExit === undefined
                  ? "T3_SETUP:ran\n"
                  : `T3_SETUP:failed ${options.setupExit}\n`,
              stderr: "",
            });
          }
          if (command.includes("@railway/cli")) {
            fake.commands.push(command);
            return respond(request, {
              exitCode: 0,
              stdout: "T3_RAILWAY_CLI:/home/boat/.local/bin/railway\n",
              stderr: "",
            });
          }
          if (command.includes("T3_CLAUDE_DIR")) {
            fake.commands.push(command);
            return respond(request, {
              exitCode: 0,
              stdout: "T3_CLAUDE_DIR:/home/boat/.claude\n",
              stderr: "",
            });
          }
        }
        return fake.client.execute(request);
      });
      return { client, state };
    };

    // The fake prints no tool report, which every launch here warns about the same way.
    const launchWarnings = (snapshot: SandboxSetupSnapshot) =>
      snapshot.warnings.filter((warning) => !warning.startsWith("T3 Code could not check"));

    // Boat writes a command's secrets to a private file through its files API; this reads them back.
    const secretsFileWith = (fake: BoatFake, name: string) =>
      fake.bodies
        .map((entry) => entry.body as { path?: string; content?: string })
        .find(
          (body) => body.path?.startsWith("/tmp/t3-secrets-") && body.content?.includes(`${name}=`),
        )?.content ?? "";

    it.effect(
      "gives a launched sandbox its own GitHub token, git identity, tools, MCP servers and skills, and revokes them on delete",
      () => {
        const fake = boatFake();
        const services = withServices(fake);
        const repository = memoryRepository();
        const secrets = memorySecrets();
        return Effect.gen(function* () {
          const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
          const { config } = yield* provisioner.saveConfig({
            config: toolingConfig,
            apiKey: "boat_test",
          });
          const { instanceId } = yield* provisioner.launch({
            configId: config.id,
            threadId,
            project,
          });
          const waiting = yield* snapshotWhere(provisioner, (snapshot) => snapshot.awaitingHandoff);
          expect(stageOf(waiting, "credentials")?.status).toBe("done");
          // The stdio server is the only thing that could not go, and the card says why.
          expect(stageOf(waiting, "tools")).toMatchObject({ status: "warning" });
          expect(launchWarnings(waiting)).toEqual([
            "local wasn't copied. Runs a program on this machine, so it can't be copied.",
          ]);

          // An hour-long token for this repository alone, kept as a server secret.
          const tokenRequest = services.state.calls.find((call) =>
            call.url.endsWith("/access_tokens"),
          );
          expect(tokenRequest?.body).toEqual({ repositories: ["hello"] });
          const record = repository.records.get(instanceId)!;
          expect(record.githubApp).toMatchObject({ installationId: 7, repository: "octo/hello" });
          expect(new TextDecoder().decode(secrets.values.get(record.githubApp!.secret))).toBe(
            "ghs_SANDBOX1",
          );
          expect(secretsFileWith(fake, "T3_GITHUB_TOKEN")).toContain("ghs_SANDBOX1");
          expect(record.mapleKey).toEqual({
            keyId: "key_sandbox",
            apiBaseUrl: "https://api.maple.dev",
          });

          // A Railway token of its own, named for the sandbox and kept as a server secret.
          expect(services.state.railway).toEqual([
            `apiTokenCreate {"i":{"name":"${railwayTokenName}","workspaceId":"ws_1"}}`,
          ]);
          expect(record.railwayToken).toMatchObject({
            name: railwayTokenName,
            workspaceId: "ws_1",
          });
          expect(new TextDecoder().decode(secrets.values.get(record.railwayToken!.secret))).toBe(
            "rw_SANDBOX",
          );
          expect(secretsFileWith(fake, "T3_RAILWAY_ENV")).toContain("rw_SANDBOX");

          // Maple gets the sandbox's own key, never this machine's; the plain HTTP server copies as is.
          const mcp = secretsFileWith(fake, "T3_MCP_SERVERS");
          expect(mcp).toContain("maple_ak_SANDBOX");
          expect(mcp).toContain("https://docs.test/mcp");
          expect(mcp).not.toContain("host_maple_KEY");
          expect(mcp).not.toContain('"local"');
          // Railway's MCP is the sandbox's CLI, signed in with the sandbox's token.
          expect(mcp).toContain("/home/boat/.local/bin/railway");
          expect(mcp).toContain("rw_SANDBOX");
          expect(mcp).not.toContain("mcp.railway.com");
          expect(secretsFileWith(fake, "T3_NORTHFLANK_TOKEN")).toContain("nf_shared_TOKEN");
          for (const secret of [
            "ghs_SANDBOX1",
            "maple_ak_SANDBOX",
            "nf_shared_TOKEN",
            "host_maple_KEY",
            "rw_SANDBOX",
            "railway_ws_TOKEN",
          ]) {
            expect(fake.commands.some((command) => command.includes(secret))).toBe(false);
          }

          // The agent can commit as the user, and the setup script runs in the clone after it.
          const step = (marker: string) =>
            fake.commands.findIndex((command) => command.includes(marker));
          expect(fake.commands[step("git config --global")]).toContain("Ada Lovelace");
          expect(step("git clone")).toBeLessThan(step("setup-scripts"));
          expect(fake.commands[step("setup-scripts")]).toContain("/home/boat/work/hello");
          expect(fake.bodies).toContainEqual({
            url: `https://boat.dev/api/v1/sandboxes/${boatSandboxId}/files`,
            body: {
              path: "/home/boat/.claude/skills/gh-stack/SKILL.md",
              content: "---\nname: gh-stack\n---",
            },
          });
          expect(fake.bodies).toContainEqual({
            url: `https://boat.dev/api/v1/sandboxes/${boatSandboxId}/files`,
            body: { path: "/home/boat/.claude/CLAUDE.md", content: "# Be kind" },
          });

          yield* provisioner.pairLaunch({ threadId });
          yield* provisioner.completeLaunch({ threadId });
          services.state.calls.length = 0;
          services.state.railway.length = 0;
          const deleted = yield* provisioner.delete({
            provider: "boat",
            sandboxId: boatSandboxId,
            instanceId,
          });
          expect(deleted.warnings).toEqual([]);
          expect(services.state.calls).toEqual([
            {
              method: "DELETE",
              url: "https://api.github.com/installation/token",
              auth: "Bearer ghs_SANDBOX1",
            },
            {
              method: "DELETE",
              url: "https://api.maple.dev/v2/api_keys/key_sandbox",
              auth: "Bearer maple_admin_KEY",
            },
          ]);
          expect(secrets.values.has(record.githubApp!.secret)).toBe(false);
          // Found by its name and revoked; the saved token is left alone.
          expect(services.state.railway).toEqual([
            'workspaceApiTokens {"w":"ws_1","after":null}',
            'workspaceApiTokenDelete {"id":"tok_sandbox","w":"ws_1"}',
          ]);
          expect(secrets.values.has(record.railwayToken!.secret)).toBe(false);
        }).pipe(
          Effect.provide(
            provisionerLayer(toolingSettings, repository.layer, {
              configs: memoryConfigs().layer,
              host: toolingHost,
              secrets: secrets.layer,
            }),
          ),
          Effect.provideService(HttpClient.HttpClient, services.client),
        );
      },
    );

    it.effect(
      "revokes what a launch minted when it fails, and warns when the app is not installed",
      () => {
        const fake = boatFake({ failing: { text: "--label t3-sandbox-bridge", times: 99 } });
        const services = withServices(fake, { setupExit: 2 });
        const repository = memoryRepository();
        const secrets = memorySecrets();
        return Effect.gen(function* () {
          const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
          const { config } = yield* provisioner.saveConfig({
            config: toolingConfig,
            apiKey: "boat_test",
          });
          yield* provisioner.launch({ configId: config.id, threadId, project });
          const waiting = yield* snapshotWhere(provisioner, (snapshot) => snapshot.awaitingHandoff);
          expect(waiting.warnings).toContain(
            "Your setup script failed (exit 2). See ~/.t3/setup-script.log on the sandbox.",
          );
          services.state.calls.length = 0;
          yield* provisioner.cancelLaunch({ threadId });
          yield* snapshotWhere(provisioner, (snapshot) => snapshot.phase !== "running");
          expect(
            services.state.calls
              .map((call) => `${call.method} ${call.url} ${call.auth}`)
              .toSorted(),
          ).toEqual([
            "DELETE https://api.github.com/installation/token Bearer ghs_SANDBOX1",
            "DELETE https://api.maple.dev/v2/api_keys/key_sandbox Bearer maple_admin_KEY",
          ]);
          expect(services.state.railway.at(-1)).toBe(
            'workspaceApiTokenDelete {"id":"tok_sandbox","w":"ws_1"}',
          );
          expect(secrets.values.size).toBe(0);
          expect(repository.records.size).toBe(0);
        }).pipe(
          Effect.provide(
            provisionerLayer(toolingSettings, repository.layer, {
              configs: memoryConfigs().layer,
              host: toolingHost,
              secrets: secrets.layer,
            }),
          ),
          Effect.provideService(HttpClient.HttpClient, services.client),
        );
      },
    );

    it.effect(
      "warns when Railway won't revoke a sandbox's token, and revokes an untracked sandbox's by name",
      () => {
        const fake = boatFake();
        const services = withServices(fake);
        const secrets = memorySecrets();
        secrets.values.set("sandbox-railway-token-1", new TextEncoder().encode("rw_SANDBOX"));
        const record: SandboxRecord = {
          ...runningRecord,
          instanceId: "railway",
          railwayToken: {
            name: railwayTokenName,
            workspaceId: "ws_1",
            secret: "sandbox-railway-token-1",
          },
        };
        const repository = memoryRepository([record]);
        return Effect.gen(function* () {
          const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
          services.state.railwayDown = true;
          const deleted = yield* provisioner.delete({
            provider: "boat",
            sandboxId: boatSandboxId,
            instanceId: "railway",
          });
          expect(deleted.warnings).toEqual([
            `T3 Code could not revoke the Railway token it made for hello on Boat small. Delete the token named ${railwayTokenName} in Railway's workspace settings.`,
          ]);
          // The sandbox and this server's copy go anyway.
          expect(repository.records.has("railway")).toBe(false);
          expect(secrets.values.size).toBe(0);

          // No record names an untracked sandbox's token, but its name is the sandbox's own.
          services.state.railwayDown = false;
          services.state.railway.length = 0;
          const orphan = yield* provisioner.delete({ provider: "boat", sandboxId: boatSandboxId });
          expect(orphan.warnings).toEqual([]);
          expect(services.state.railway).toEqual([
            'workspaceApiTokens {"w":"ws_1","after":null}',
            'workspaceApiTokenDelete {"id":"tok_sandbox","w":"ws_1"}',
          ]);
        }).pipe(
          Effect.provide(
            provisionerLayer({ ...boatSettings, ...toolingSettings }, repository.layer, {
              secrets: secrets.layer,
            }),
          ),
          Effect.provideService(HttpClient.HttpClient, services.client),
        );
      },
    );

    it.effect(
      "saves a Railway token only once Railway answers for its workspace, asking when there is a choice",
      () => {
        const workspaces: Record<string, ReadonlyArray<{ id: string; name: string }>> = {
          "ws-token": [{ id: "ws_1", name: "Omar's projects" }],
          "account-token": [
            { id: "ws_1", name: "Omar's projects" },
            { id: "ws_2", name: "Team" },
          ],
        };
        const client = HttpClient.make((request) => {
          const body =
            request.body._tag === "Uint8Array"
              ? JSON.parse(new TextDecoder().decode(request.body.body))
              : {};
          const token = request.headers.authorization?.replace("Bearer ", "") ?? "";
          const known = workspaces[token];
          const answer =
            known === undefined
              ? { errors: [{ message: "Not Authorized" }] }
              : String(body.query).includes("apiToken {")
                ? { data: { apiToken: { workspaces: known } } }
                : known.some((workspace) => workspace.id === body.variables.w)
                  ? {
                      data: {
                        workspace: {
                          name: known.find((workspace) => workspace.id === body.variables.w)!.name,
                        },
                      },
                    }
                  : { errors: [{ message: "Not Authorized" }] };
          return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(answer)));
        });
        return Effect.gen(function* () {
          const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
          const service = yield* ServerSettings.ServerSettingsService;

          const wrong = yield* provisioner.connectRailway({ token: "nope" });
          expect(wrong.saved).toBeUndefined();
          expect(wrong.problem).toContain("Railway did not accept this token.");

          const several = yield* provisioner.connectRailway({ token: "account-token" });
          expect(several).toEqual({
            workspaces: workspaces["account-token"],
            problem: "This token reaches several workspaces. Pick the one sandboxes get tokens in.",
          });
          expect((yield* service.getSettings).sandboxTooling.railwayToken).toBe("");
          expect((yield* provisioner.providers).host.railway).toBe(false);

          const picked = yield* provisioner.connectRailway({
            token: "account-token",
            workspaceId: "ws_2",
          });
          expect(picked.saved).toEqual({ id: "ws_2", name: "Team" });

          const only = yield* provisioner.connectRailway({ token: "ws-token" });
          expect(only).toEqual({
            saved: { id: "ws_1", name: "Omar's projects" },
            workspaces: [],
            problem: null,
          });
          expect((yield* service.getSettings).sandboxTooling).toMatchObject({
            railwayToken: "ws-token",
            railwayWorkspaceId: "ws_1",
            railwayWorkspaceName: "Omar's projects",
          });
          expect((yield* provisioner.providers).host.railway).toBe(true);

          // A workspace the token can't read is refused and the saved one stays.
          const elsewhere = yield* provisioner.connectRailway({
            token: "ws-token",
            workspaceId: "ws_2",
          });
          expect(elsewhere.saved).toBeUndefined();
          expect((yield* service.getSettings).sandboxTooling.railwayWorkspaceId).toBe("ws_1");
        }).pipe(
          Effect.provide(provisionerLayer()),
          Effect.provideService(HttpClient.HttpClient, client),
        );
      },
    );

    it.effect("tells the user to install the GitHub App on a repository it is not on", () => {
      const fake = boatFake();
      const services = withServices(fake, { installed: false });
      return Effect.gen(function* () {
        const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
        const { config } = yield* provisioner.saveConfig({
          config: { ...configInput, githubApp: true },
          apiKey: "boat_test",
        });
        yield* provisioner.launch({ configId: config.id, threadId, project });
        const waiting = yield* snapshotWhere(provisioner, (snapshot) => snapshot.awaitingHandoff);
        expect(stageOf(waiting, "credentials")?.status).toBe("warning");
        expect(launchWarnings(waiting)).toEqual([
          "The GitHub App isn't installed on octo/hello. Install it at https://github.com/apps/t3-sandboxes/installations/new",
        ]);
        expect(services.state.tokens).toBe(0);
      }).pipe(
        Effect.provide(
          provisionerLayer(toolingSettings, memoryRepository().layer, {
            configs: memoryConfigs().layer,
            host: toolingHost,
          }),
        ),
        Effect.provideService(HttpClient.HttpClient, services.client),
      );
    });

    it.effect(
      "refuses a launch before anything bills when a credential it needs is not saved",
      () => {
        const fake = boatFake();
        return Effect.gen(function* () {
          const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
          const failures: Array<string | null> = [];
          for (const tooling of [
            { githubApp: true },
            { northflank: true },
            { railway: true },
          ] as const) {
            const { config } = yield* provisioner.saveConfig({
              config: { ...configInput, ...tooling },
              apiKey: "boat_test",
            });
            yield* provisioner.launch({ configId: config.id, threadId, project });
            failures.push(
              (yield* snapshotWhere(provisioner, (snapshot) => snapshot.phase === "failed")).error,
            );
          }
          expect(failures).toEqual([
            "Connect the GitHub App under Sandboxes in Settings → Connections, or turn off GitHub for this config.",
            "Save a Northflank token under Sandboxes in Settings → Connections, or turn off Northflank for this config.",
            "Save a Railway token under Sandboxes in Settings → Connections, or turn off Railway for this config.",
          ]);
          expect(fake.requests.some((request) => request.endsWith("/sandboxes"))).toBe(false);
        }).pipe(
          Effect.provide(
            provisionerLayer({}, memoryRepository().layer, { configs: memoryConfigs().layer }),
          ),
          Effect.provideService(HttpClient.HttpClient, fake.client),
        );
      },
    );

    it.effect(
      "renews a running sandbox's GitHub token before it expires and revokes the old one",
      () => {
        const fake = boatFake({ states: { bx_stopped: "archived" } });
        const services = withServices(fake);
        const secrets = memorySecrets();
        secrets.values.set("sandbox-github-token-old", new TextEncoder().encode("ghs_OLD"));
        const record: SandboxRecord = {
          ...runningRecord,
          instanceId: "renewing",
          githubApp: {
            installationId: 7,
            repository: "octo/hello",
            secret: "sandbox-github-token-old",
            // The test clock starts at the epoch: ten minutes left.
            expiresAt: "1970-01-01T00:10:00.000Z",
          },
        };
        const stopped: SandboxRecord = {
          ...record,
          instanceId: "stopped",
          sandboxId: "bx_stopped",
          state: "stopped",
          runningSince: null,
        };
        const repository = memoryRepository([record, stopped]);
        return Effect.gen(function* () {
          const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
          yield* provisioner.sweep;
          const renewed = repository.records.get("renewing")!;
          expect(renewed.githubApp).toMatchObject({
            installationId: 7,
            expiresAt: "1970-01-01T01:00:00Z",
          });
          expect(new TextDecoder().decode(secrets.values.get(renewed.githubApp!.secret))).toBe(
            "ghs_SANDBOX1",
          );
          expect(secrets.values.has("sandbox-github-token-old")).toBe(false);
          // A known installation needs no lookup; the old token is revoked with itself.
          expect(services.state.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            "POST https://api.github.com/app/installations/7/access_tokens",
            "DELETE https://api.github.com/installation/token",
          ]);
          expect(services.state.calls[1]?.auth).toBe("Bearer ghs_OLD");
          expect(secretsFileWith(fake, "T3_GITHUB_TOKEN")).toContain("ghs_SANDBOX1");
          // A stopped sandbox is not woken for it.
          expect(repository.records.get("stopped")?.githubApp?.secret).toBe(
            "sandbox-github-token-old",
          );
        }).pipe(
          Effect.provide(
            provisionerLayer({ ...boatSettings, ...toolingSettings }, repository.layer, {
              secrets: secrets.layer,
            }),
          ),
          Effect.provideService(HttpClient.HttpClient, services.client),
        );
      },
    );

    it.effect(
      "connects the GitHub App from the manifest flow's code and keeps its key on the server",
      () => {
        const client = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              request.url === "https://api.github.com/app-manifests/code123/conversions"
                ? Response.json(
                    {
                      id: 99,
                      slug: "t3-code-sandboxes",
                      name: "T3 Code sandboxes",
                      pem: "PEM_SECRET",
                      owner: { login: "octo" },
                    },
                    { status: 201 },
                  )
                : Response.json({}, { status: 404 }),
            ),
          ),
        );
        return Effect.gen(function* () {
          const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
          const connected = yield* provisioner.connectGithubApp({ code: "code123" });
          expect(connected).toEqual({
            slug: "t3-code-sandboxes",
            owner: "octo",
            installUrl: "https://github.com/apps/t3-code-sandboxes/installations/new",
          });
          const saved = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
          expect(saved.sandboxTooling).toMatchObject({
            githubAppId: "99",
            githubAppSlug: "t3-code-sandboxes",
            githubAppOwner: "octo",
            githubAppPrivateKey: "PEM_SECRET",
          });
          expect((yield* provisioner.providers).host.githubApp).toEqual({
            slug: "t3-code-sandboxes",
            owner: "octo",
          });
          const expired = yield* provisioner.connectGithubApp({ code: "stale" }).pipe(Effect.flip);
          expect(expired.detail).toBe(
            "GitHub no longer accepts this code. Create the app again from Settings.",
          );
        }).pipe(
          Effect.provide(provisionerLayer()),
          Effect.provideService(HttpClient.HttpClient, client),
        );
      },
    );
  });
});
