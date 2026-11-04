import { SandboxProviderError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Random from "effect/Random";
import { HttpClientRequest } from "effect/http";
import * as Schema from "effect/Schema";

import {
  attemptSandboxName,
  commandRequestSeconds,
  type CreatedSandbox,
  jsonBody,
  mayHaveCreated,
  requestJson,
  requestText,
  type SandboxProviderDriver,
  type SandboxProviderStatus,
  shellQuote,
} from "../SandboxProvider.ts";

// Upstash publishes no REST reference; paths and bodies follow its SDK, `@upstash/box` 0.7.10.
const UPSTASH_API_BASE = "https://us-east-1.box.upstash.com/v2/box";
const SERVER_PORT = 3773;
const POLL_INTERVAL = "2 seconds";
const POLL_ATTEMPTS = 90;

// Upstash runs this on every container start, including a resume or a wake from a URL visit, which
// T3 does not see. The userdata check skips a fresh box until the provisioner has started T3 once.
const INIT_COMMAND = `export PATH="$HOME/.local/bin:$PATH"
if [ -d "$HOME/.t3/userdata" ] && command -v t3 >/dev/null 2>&1; then
  setsid nohup t3 serve --host 0.0.0.0 --port ${SERVER_PORT} >"$HOME/.t3/sandbox-server.log" 2>&1 </dev/null &
  echo "$!" >"$HOME/.t3/sandbox-server.pid"
fi`;

const UpstashBox = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
});

const UpstashStatus = Schema.Struct({ status: Schema.String });

const UpstashExec = Schema.Struct({
  exit_code: Schema.Number,
  output: Schema.optionalKey(Schema.NullOr(Schema.String)),
  error: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const UpstashPublicUrl = Schema.Struct({ url: Schema.String });

const UPSTASH_STATUS: Record<string, SandboxProviderStatus> = {
  idle: "running",
  running: "running",
  creating: "starting",
  paused: "stopped",
  error: "error",
  deleted: "deleted",
};

const info = {
  kind: "upstash",
  label: "Upstash",
  detail:
    "Debian boxes with a public URL per port. A box pauses after an hour idle (six on paid plans), which may stop a working agent; opening its URL wakes it.",
  apiKeyLabel: "Upstash Box API key",
  apiKeyPlaceholder: "box_...",
  docsUrl: "https://upstash.com/docs/box/overall/quickstart",
  sizes: [
    { id: "small", label: "Small", detail: "2 vCPU · 4 GB · 10 GB" },
    { id: "medium", label: "Medium", detail: "4 vCPU · 8 GB · 20 GB · paid plan" },
    { id: "large", label: "Large", detail: "8 vCPU · 16 GB · 30 GB · paid plan" },
  ],
} satisfies SandboxProviderDriver["info"];

const boxUrl = (sandboxId: string, path = "") =>
  `${UPSTASH_API_BASE}/${encodeURIComponent(sandboxId)}${path}`;

const authorize = (request: HttpClientRequest.HttpClientRequest, apiKey: string) =>
  HttpClientRequest.setHeaders(request, { "X-Box-Api-Key": apiKey });

// Lifecycle, delete, and file calls can answer with an empty body, which is not JSON.
const send = (
  apiKey: string,
  request: HttpClientRequest.HttpClientRequest,
  stage: "start" | "install" | "delete",
) =>
  requestText({ provider: "upstash", stage, request: authorize(request, apiKey) }).pipe(
    Effect.asVoid,
  );

const getBox = (apiKey: string, sandboxId: string) =>
  requestJson({
    provider: "upstash",
    stage: "start",
    schema: UpstashBox,
    request: authorize(HttpClientRequest.get(boxUrl(sandboxId)), apiKey),
  });

const waitUntilRunning = Effect.fn("Upstash.waitUntilRunning")(function* (
  apiKey: string,
  sandboxId: string,
) {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const box = yield* getBox(apiKey, sandboxId);
    if (UPSTASH_STATUS[box.status] === "running") return box;
    if (box.status === "error" || box.status === "deleted") {
      return yield* new SandboxProviderError({
        provider: "upstash",
        stage: "start",
        detail: `The box entered the ${box.status} state while starting.`,
      });
    }
    if (attempt < POLL_ATTEMPTS - 1) yield* Effect.sleep(POLL_INTERVAL);
  }
  return yield* new SandboxProviderError({
    provider: "upstash",
    stage: "start",
    detail: "Timed out waiting for the box to start.",
  });
});

// Upstash has no server-side command timeout: a request that gives up leaves the command running,
// so `timeout` ends it in the box.
const runCommand = (apiKey: string, sandboxId: string, command: string, timeoutSeconds: number) => {
  const seconds = Math.min(Math.max(timeoutSeconds, 1), 600);
  return requestJson({
    provider: "upstash",
    stage: "install",
    schema: UpstashExec,
    request: jsonBody(authorize(HttpClientRequest.post(boxUrl(sandboxId, "/exec")), apiKey), {
      command: ["timeout", "-k", "5", String(seconds), "sh", "-c", command],
    }),
    timeoutSeconds: commandRequestSeconds(seconds),
  }).pipe(
    Effect.flatMap((result) => {
      const stdout = result.output ?? "";
      const stderr = result.error ?? "";
      if (result.exit_code === 0) return Effect.succeed({ exitCode: 0, stdout, stderr });
      return Effect.fail(
        new SandboxProviderError({
          provider: "upstash",
          stage: "install",
          // Only the exit status is an attribute; command output can contain secrets.
          detail: `The command exited with ${result.exit_code}.`,
          cause: new Error(
            [stderr, stdout]
              .map((part) => part.trim())
              .filter((part) => part !== "")
              .join("\n")
              .slice(-4000),
          ),
        }),
      );
    }),
  );
};

export const upstashDriver: SandboxProviderDriver = {
  info,
  defaultSize: "small",
  serverPort: SERVER_PORT,
  create: Effect.fn("Upstash.create")(function* (input) {
    const { apiKey } = input.config;
    const name = attemptSandboxName(input.name, input.idempotencyKey);
    return yield* requestJson({
      provider: "upstash",
      stage: "create",
      schema: UpstashBox,
      request: jsonBody(authorize(HttpClientRequest.post(UPSTASH_API_BASE), apiKey), {
        name,
        size: input.size,
        runtime: "node",
        labels: ["t3-code"],
        init_command: INIT_COMMAND,
      }),
    }).pipe(
      // Upstash takes no idempotency key, but `GET /v2/box/{name}` resolves a name, so the attempt's
      // own name finds what a lost create made.
      Effect.catchIf(mayHaveCreated, (error) =>
        getBox(apiKey, name).pipe(
          Effect.flatMap((lost) =>
            send(apiKey, HttpClientRequest.delete(boxUrl(lost.id)), "delete"),
          ),
          Effect.ignore,
          Effect.andThen(Effect.fail(error)),
        ),
      ),
      Effect.flatMap((box) =>
        waitUntilRunning(apiKey, box.id).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : upstashDriver
                  .destroy({ config: input.config, sandboxId: box.id })
                  .pipe(Effect.ignore),
          ),
        ),
      ),
      Effect.map((box): CreatedSandbox => ({ id: box.id, name: input.name })),
    );
  }),
  execute: Effect.fn("Upstash.execute")(function* (input) {
    const { apiKey } = input.config;
    if (input.secrets === undefined) {
      return yield* runCommand(apiKey, input.sandboxId, input.command, input.timeoutSeconds);
    }
    // Exec takes no per-command env, so secrets go in a private file through the files API, which
    // keeps them out of the command text. `mkdir` without -p fails on a name someone else took.
    const dir = `/tmp/t3-secrets-${(yield* Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER)).toString(36)}`;
    const file = `${dir}/env`;
    yield* runCommand(apiKey, input.sandboxId, `umask 077\nmkdir ${dir}\n: >${file}`, 30);
    return yield* send(
      apiKey,
      jsonBody(HttpClientRequest.post(boxUrl(input.sandboxId, "/files/write")), {
        path: file,
        content: Object.entries(input.secrets)
          .map(([name, value]) => `export ${name}=${shellQuote(value)}\n`)
          .join(""),
      }),
      "install",
    ).pipe(
      Effect.andThen(
        runCommand(
          apiKey,
          input.sandboxId,
          `. ${file}\nrm -rf ${dir}\n${input.command}`,
          input.timeoutSeconds,
        ),
      ),
      Effect.onError(() =>
        send(
          apiKey,
          jsonBody(HttpClientRequest.post(boxUrl(input.sandboxId, "/files/remove")), {
            path: dir,
            recursive: true,
          }),
          "install",
        ).pipe(Effect.ignore),
      ),
    );
  }),
  // Created without a bearer token or basic auth: a browser cannot attach either to a page load or
  // a WebSocket, and T3's own pairing guards the server. One URL per port, so this is repeatable.
  exposePort: (input) =>
    requestJson({
      provider: "upstash",
      stage: "expose",
      schema: UpstashPublicUrl,
      request: jsonBody(
        authorize(HttpClientRequest.post(boxUrl(input.sandboxId, "/preview")), input.config.apiKey),
        { port: input.port },
      ),
    }).pipe(Effect.map((preview) => preview.url)),
  stop: (input) =>
    send(input.config.apiKey, HttpClientRequest.post(boxUrl(input.sandboxId, "/pause")), "delete"),
  resume: Effect.fn("Upstash.resume")(function* (input) {
    yield* send(
      input.config.apiKey,
      HttpClientRequest.post(boxUrl(input.sandboxId, "/resume")),
      "start",
    );
    yield* waitUntilRunning(input.config.apiKey, input.sandboxId);
    return {};
  }),
  status: (input) =>
    requestJson({
      provider: "upstash",
      stage: "start",
      schema: UpstashStatus,
      request: authorize(
        HttpClientRequest.get(boxUrl(input.sandboxId, "/status")),
        input.config.apiKey,
      ),
    }).pipe(
      Effect.map((box) => UPSTASH_STATUS[box.status] ?? null),
      Effect.catchIf(
        (error) => error.code === "not_found",
        () => Effect.succeed("deleted" as const),
      ),
    ),
  destroy: (input) =>
    send(input.config.apiKey, HttpClientRequest.delete(boxUrl(input.sandboxId)), "delete"),
};
