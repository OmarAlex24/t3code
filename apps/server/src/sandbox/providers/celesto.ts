// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no RSA encryption.
import * as NodeCrypto from "node:crypto";

import { SandboxProviderError, type SandboxProviderLimits } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import { HttpClientRequest } from "effect/http";
import * as Schema from "effect/Schema";

import {
  authorize,
  commandRequestSeconds,
  type CreatedSandbox,
  jsonBody,
  mayHaveCreated,
  requestJson,
  requestText,
  type SandboxExecResult,
  type SandboxProviderConfig,
  type SandboxProviderDriver,
  type SandboxProviderStatus,
  shellQuote,
} from "../SandboxProvider.ts";
import { OAEP } from "../sandboxPairing.ts";

const CELESTO_API_BASE = "https://api.celesto.ai/v1";
const SERVER_PORT = 3773;
const POLL_INTERVAL = "2 seconds";
const POLL_ATTEMPTS = 90;
// Celesto refuses an exec over 300 s or 10,000 characters, so longer work runs detached.
const EXEC_MAX_SECONDS = 300;
const EXEC_MAX_CHARS = 10_000;
const UPLOAD_CHUNK_CHARS = 8_000;
// Each poll waits in the sandbox, so a ten-minute install costs about two dozen requests.
const POLL_WAIT_SECONDS = 25;
const STEP_SECONDS = 30;

const CelestoComputer = Schema.Struct({
  id: Schema.String,
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  status: Schema.String,
  last_error: Schema.optionalKey(Schema.NullOr(Schema.String)),
  disk_delete_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const CelestoExec = Schema.Struct({
  exit_code: Schema.NullOr(Schema.Number),
  stdout: Schema.optionalKey(Schema.NullOr(Schema.String)),
  stderr: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const CelestoPublishedPort = Schema.Struct({
  port: Schema.Number,
  status: Schema.String,
  url: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const CelestoUsage = Schema.Struct({
  state: Schema.String,
  running_count: Schema.Number,
  running_limit: Schema.Number,
});

// `restorable` then `restoring` is a spot move Celesto finishes on its own, so like any `starting`
// it leaves the record alone.
const CELESTO_STATUS: Record<string, SandboxProviderStatus> = {
  running: "running",
  creating: "starting",
  pending: "starting",
  starting: "starting",
  restorable: "starting",
  restoring: "starting",
  stopping: "stopped",
  stopped: "stopped",
  error: "error",
  lost: "error",
  deleting: "deleted",
  deleted: "deleted",
};

// Celesto's `size_id` for each size; it refuses CPU and memory overrides.
const SIZES: Record<string, string> = {
  "celesto-micro": "micro",
  "celesto-small": "small",
  "celesto-standard": "standard",
  "celesto-memory": "memory",
  "celesto-large": "large",
  "celesto-xl": "xl",
};

const info = {
  kind: "celesto",
  label: "Celesto",
  detail:
    "Ubuntu microVMs with a public URL per port. Celesto never stops one on its own, so T3's lifetime limit is the only stop.",
  apiKeyLabel: "Celesto API key",
  apiKeyPlaceholder: "Paste your API key",
  docsUrl: "https://celesto.ai/docs/cloud/authentication",
  sizes: [
    { id: "celesto-micro", label: "Micro", detail: "1 vCPU · 2 GB · 20 GB · trial" },
    { id: "celesto-small", label: "Small", detail: "1 vCPU · 4 GB · 25 GB" },
    { id: "celesto-standard", label: "Standard", detail: "2 vCPU · 4 GB · 30 GB" },
    { id: "celesto-memory", label: "Memory", detail: "2 vCPU · 8 GB · 40 GB" },
    { id: "celesto-large", label: "Large", detail: "4 vCPU · 16 GB · 60 GB" },
    { id: "celesto-xl", label: "Extra large", detail: "8 vCPU · 32 GB · 100 GB" },
  ],
} satisfies SandboxProviderDriver["info"];

const computerUrl = (sandboxId: string, path = "") =>
  `${CELESTO_API_BASE}/computers/${encodeURIComponent(sandboxId)}${path}`;

const getComputer = (apiKey: string, sandboxId: string) =>
  requestJson({
    provider: "celesto",
    stage: "start",
    schema: CelestoComputer,
    request: authorize(HttpClientRequest.get(computerUrl(sandboxId)), apiKey),
  });

const waitUntilRunning = Effect.fn("Celesto.waitUntilRunning")(function* (
  apiKey: string,
  sandboxId: string,
) {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const computer = yield* getComputer(apiKey, sandboxId);
    if (computer.status === "running") return computer;
    const mapped = CELESTO_STATUS[computer.status];
    if (mapped === "error" || mapped === "deleted" || mapped === "stopped") {
      return yield* new SandboxProviderError({
        provider: "celesto",
        stage: "start",
        detail: `The sandbox entered the ${computer.status} state while starting.`,
        ...(computer.last_error ? { cause: new Error(computer.last_error.slice(0, 2000)) } : {}),
      });
    }
    if (attempt < POLL_ATTEMPTS - 1) yield* Effect.sleep(POLL_INTERVAL);
  }
  return yield* new SandboxProviderError({
    provider: "celesto",
    stage: "start",
    detail: "Timed out waiting for the sandbox to start.",
  });
});

// Celesto answers 409 while another operation, such as a create or a stop, is still running.
const afterBusy = <A, R>(effect: Effect.Effect<A, SandboxProviderError, R>) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error.status === 409,
      schedule: Schedule.spaced(POLL_INTERVAL),
      times: POLL_ATTEMPTS - 1,
    }),
  );

const exec = (config: SandboxProviderConfig, sandboxId: string, command: string, seconds: number) =>
  requestJson({
    provider: "celesto",
    stage: "install",
    schema: CelestoExec,
    request: jsonBody(
      authorize(HttpClientRequest.post(computerUrl(sandboxId, "/exec")), config.apiKey),
      { command, timeout: seconds },
    ),
    timeoutSeconds: commandRequestSeconds(seconds),
  }).pipe(
    Effect.map((result) => ({
      exitCode: result.exit_code,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    })),
  );

const commandFailed = (result: SandboxExecResult) =>
  new SandboxProviderError({
    provider: "celesto",
    stage: "install",
    // Only the exit status is an attribute; command output can contain secrets.
    detail: `The command exited with ${result.exitCode ?? "an unknown status"}.`,
    cause: new Error(
      [result.stderr, result.stdout]
        .map((part) => part.trim())
        .filter((part) => part !== "")
        .join("\n")
        .slice(-4000),
    ),
  });

const succeeded = (result: SandboxExecResult) =>
  result.exitCode === 0 ? Effect.succeed(result) : Effect.fail(commandFailed(result));

/** A short step of T3's own, which must succeed. */
const step = (config: SandboxProviderConfig, sandboxId: string, command: string) =>
  exec(config, sandboxId, `sh -c ${shellQuote(command)}`, STEP_SECONDS).pipe(
    Effect.flatMap(succeeded),
  );

const randomPath = (prefix: string) =>
  Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER).pipe(
    Effect.map((value) => `/tmp/${prefix}-${value.toString(36)}`),
  );

// Uploads the script, starts it under `setsid` so it outlives the exec, and reads its exit status
// from a file. `timeout` holds it to the caller's time in the sandbox itself.
const runDetached = Effect.fn("Celesto.runDetached")(function* (
  config: SandboxProviderConfig,
  sandboxId: string,
  script: string,
  timeoutSeconds: number,
) {
  const job = yield* randomPath("t3-job");
  yield* step(config, sandboxId, `umask 077\nmkdir ${job}`);
  const encoded = Buffer.from(script, "utf8").toString("base64");
  for (let start = 0; start < encoded.length; start += UPLOAD_CHUNK_CHARS) {
    const chunk = encoded.slice(start, start + UPLOAD_CHUNK_CHARS);
    yield* step(config, sandboxId, `printf '%s' '${chunk}' >>${job}/script.b64`);
  }
  yield* step(
    config,
    sandboxId,
    `base64 -d ${job}/script.b64 >${job}/script
setsid -f sh -c 'timeout -k 10 ${timeoutSeconds} sh "$1" >"$2/out" 2>"$2/err"; echo $? >"$2/rc.tmp"; mv "$2/rc.tmp" "$2/rc"' sh ${job}/script ${job} </dev/null >/dev/null 2>&1`,
  );
  const polls = Math.ceil((timeoutSeconds + 60) / POLL_WAIT_SECONDS);
  let exitCode: number | null = null;
  for (let poll = 0; poll < polls && exitCode === null; poll++) {
    // A poll only reads a file, so one that failed in transit is safe to send again.
    const read = yield* step(
      config,
      sandboxId,
      `i=0
while [ "$i" -lt ${POLL_WAIT_SECONDS} ] && [ ! -f ${job}/rc ]; do sleep 1; i=$((i + 1)); done
cat ${job}/rc 2>/dev/null || true`,
    ).pipe(Effect.option);
    if (read._tag === "None") {
      yield* Effect.sleep("5 seconds");
      continue;
    }
    const status = read.value.stdout.trim();
    if (/^\d+$/u.test(status)) exitCode = Number(status);
  }
  if (exitCode === null) {
    return yield* new SandboxProviderError({
      provider: "celesto",
      stage: "install",
      detail: "The command did not finish in time.",
    });
  }
  const output = yield* step(
    config,
    sandboxId,
    `tail -c 12000 ${job}/out
tail -c 4000 ${job}/err >&2
rm -rf ${job}`,
  );
  return yield* succeeded({ exitCode, stdout: output.stdout, stderr: output.stderr });
});

const run = (
  config: SandboxProviderConfig,
  sandboxId: string,
  script: string,
  timeoutSeconds: number,
) => {
  const seconds = Math.max(timeoutSeconds, 1);
  const command = `sh -c ${shellQuote(script)}`;
  return seconds <= EXEC_MAX_SECONDS && command.length <= EXEC_MAX_CHARS
    ? exec(config, sandboxId, command, seconds).pipe(Effect.flatMap(succeeded))
    : runDetached(config, sandboxId, script, seconds);
};

const PUBLIC_KEY_PEM = /-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----/u;
// The inverse of `sandboxPairing.ts`'s `openssl pkeyutl -encrypt`, and of Node's `OAEP`.
const OPENSSL_OAEP =
  "-pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -pkeyopt rsa_mgf1_md:sha256";

/** Seals `content` to the RSA key in `stdout`, one OAEP block per piece; null for any other key. */
const sealToSandbox = (stdout: string, content: string): ReadonlyArray<string> | null => {
  const pem = PUBLIC_KEY_PEM.exec(stdout)?.[0];
  if (pem === undefined) return null;
  let key: NodeCrypto.KeyObject;
  try {
    key = NodeCrypto.createPublicKey(pem);
  } catch {
    return null;
  }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (key.asymmetricKeyType !== "rsa" || bits < 2048) return null;
  // OAEP with SHA-256 spends 66 bytes of each block.
  const size = Math.floor(bits / 8) - 66;
  const bytes = Buffer.from(content, "utf8");
  const pieces: Array<string> = [];
  for (let start = 0; start < bytes.length; start += size) {
    pieces.push(
      NodeCrypto.publicEncrypt({ key, ...OAEP }, bytes.subarray(start, start + size)).toString(
        "base64",
      ),
    );
  }
  return pieces;
};

const publishedPorts = (apiKey: string, sandboxId: string) =>
  requestJson({
    provider: "celesto",
    stage: "expose",
    schema: Schema.Array(CelestoPublishedPort),
    request: authorize(HttpClientRequest.get(computerUrl(sandboxId, "/published-ports")), apiKey),
  });

// A route is usable once it is `published` and has a URL; a stopped sandbox's routes are suspended,
// so this also brings the route back after a start.
const exposePort = Effect.fn("Celesto.exposePort")(function* (
  apiKey: string,
  sandboxId: string,
  port: number,
) {
  let published = false;
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const route = (yield* publishedPorts(apiKey, sandboxId)).find(
      (candidate) => candidate.port === port,
    );
    if (route?.status === "published" && route.url) return route.url;
    if (route?.status === "error") {
      return yield* new SandboxProviderError({
        provider: "celesto",
        stage: "expose",
        detail: `Celesto could not publish port ${port}.`,
      });
    }
    if (!published && (route === undefined || route.status === "unpublished")) {
      published = true;
      yield* requestJson({
        provider: "celesto",
        stage: "expose",
        schema: CelestoPublishedPort,
        request: jsonBody(
          authorize(HttpClientRequest.post(computerUrl(sandboxId, "/published-ports")), apiKey),
          { port },
        ),
      });
      continue;
    }
    if (attempt < POLL_ATTEMPTS - 1) yield* Effect.sleep(POLL_INTERVAL);
  }
  return yield* new SandboxProviderError({
    provider: "celesto",
    stage: "expose",
    detail: `Timed out waiting for Celesto to publish port ${port}.`,
  });
});

const toLimits = (usage: typeof CelestoUsage.Type): SandboxProviderLimits => {
  const trial = usage.state === "trial";
  return {
    canStart: true,
    concurrency: { active: usage.running_count, max: usage.running_limit },
    ...(trial
      ? {
          plan: "Trial",
          // Trials get `403 trial_micro_only` for anything bigger.
          sizes: info.sizes.map((size) =>
            size.id === "celesto-micro"
              ? { id: size.id, available: true }
              : { id: size.id, available: false, reason: "The Celesto trial runs Micro only." },
          ),
        }
      : {}),
  };
};

export const celestoDriver: SandboxProviderDriver = {
  info,
  defaultSize: "celesto-micro",
  serverPort: SERVER_PORT,
  create: Effect.fn("Celesto.create")(function* (input) {
    const send = requestJson({
      provider: "celesto",
      stage: "create",
      schema: CelestoComputer,
      request: jsonBody(
        HttpClientRequest.setHeaders(
          authorize(HttpClientRequest.post(`${CELESTO_API_BASE}/computers`), input.config.apiKey),
          { "Idempotency-Key": input.idempotencyKey, "X-Celesto-Client": "sdk" },
        ),
        // Without a size the template's default is Standard, not Micro.
        { template_id: "coding-agent", size_id: SIZES[input.size] ?? "micro" },
      ),
    });
    // Celesto takes no name or label, so only the same key finds what a lost create made.
    const created = yield* send.pipe(Effect.catchIf(mayHaveCreated, () => send));
    // Nothing on Celesto stops a sandbox, so one that never starts would bill until deleted.
    const started = yield* waitUntilRunning(input.config.apiKey, created.id).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : celestoDriver
              .destroy({ config: input.config, sandboxId: created.id })
              .pipe(Effect.ignore),
      ),
    );
    return { id: started.id, name: input.name } satisfies CreatedSandbox;
  }),
  limits: (input) =>
    requestJson({
      provider: "celesto",
      stage: "config",
      schema: CelestoUsage,
      request: authorize(
        HttpClientRequest.get(`${CELESTO_API_BASE}/billing/usage-overview`),
        input.config.apiKey,
      ),
    }).pipe(
      Effect.map(toLimits),
      // A scoped key can be refused billing endpoints (`api_key_endpoint_not_allowed`).
      Effect.catchIf(
        (error) => error.status === 403,
        () => Effect.succeed(null),
      ),
    ),
  execute: Effect.fn("Celesto.execute")(function* (input) {
    if (input.secrets === undefined) {
      return yield* run(input.config, input.sandboxId, input.command, input.timeoutSeconds);
    }
    // Exec takes only command text, which Celesto keeps, and Celesto has no files API. So the
    // sandbox makes a key pair and returns only its public half, and the secrets file reaches the
    // sandbox sealed to it; the private key never leaves the sandbox and is removed once used.
    const { config, sandboxId } = input;
    const dir = yield* randomPath("t3-secrets");
    const content = Object.entries(input.secrets)
      .map(([name, value]) => `export ${name}=${shellQuote(value)}\n`)
      .join("");
    return yield* Effect.gen(function* () {
      const key = yield* step(
        config,
        sandboxId,
        `umask 077
mkdir ${dir}
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out ${dir}/key 2>/dev/null
openssl pkey -in ${dir}/key -pubout`,
      );
      const sealed = sealToSandbox(key.stdout, content);
      if (sealed === null) {
        return yield* new SandboxProviderError({
          provider: "celesto",
          stage: "install",
          detail: "The sandbox did not return a usable key for its secrets.",
        });
      }
      // Each piece lands in its own file, so a step sent again rewrites rather than appends.
      const parts = sealed.map((_, index) => `${dir}/${index}`).join(" ");
      const lines = [
        ...sealed.map((piece, index) => `printf %s ${piece} | part ${index} || exit 1\n`),
        `cat ${parts} >${dir}/env || exit 1\nrm -f ${dir}/key ${parts}\n`,
      ];
      const header = `umask 077\npart() { openssl base64 -d -A | openssl pkeyutl -decrypt -inkey ${dir}/key ${OPENSSL_OAEP} >${dir}/$1; }\n`;
      let batch = "";
      for (const line of lines) {
        if (batch !== "" && batch.length + line.length > UPLOAD_CHUNK_CHARS) {
          yield* step(config, sandboxId, header + batch);
          batch = "";
        }
        batch += line;
      }
      yield* step(config, sandboxId, header + batch);
      return yield* run(
        config,
        sandboxId,
        `. ${dir}/env\nrm -rf ${dir}\n${input.command}`,
        input.timeoutSeconds,
      );
    }).pipe(Effect.onError(() => step(config, sandboxId, `rm -rf ${dir}`).pipe(Effect.ignore)));
  }),
  exposePort: (input) => exposePort(input.config.apiKey, input.sandboxId, input.port),
  stop: (input) =>
    requestText({
      provider: "celesto",
      stage: "delete",
      request: authorize(
        HttpClientRequest.post(computerUrl(input.sandboxId, "/stop")),
        input.config.apiKey,
      ),
    }).pipe(Effect.asVoid),
  resume: Effect.fn("Celesto.resume")(function* (input) {
    yield* requestText({
      provider: "celesto",
      stage: "start",
      request: authorize(
        HttpClientRequest.post(computerUrl(input.sandboxId, "/start")),
        input.config.apiKey,
      ),
    }).pipe(afterBusy);
    yield* waitUntilRunning(input.config.apiKey, input.sandboxId);
    return { publicUrl: yield* exposePort(input.config.apiKey, input.sandboxId, SERVER_PORT) };
  }),
  status: Effect.fn("Celesto.status")(function* (input) {
    const computer = yield* getComputer(input.config.apiKey, input.sandboxId).pipe(
      Effect.catchIf(
        (error) => error.code === "not_found",
        () => Effect.succeed(null),
      ),
    );
    if (computer === null) return "deleted" as const;
    const mapped = CELESTO_STATUS[computer.status] ?? null;
    // Celesto keeps a stopped disk for 30 days and then deletes it.
    if (mapped === "stopped" && computer.disk_delete_at) {
      const deleteAt = Date.parse(computer.disk_delete_at);
      if (!Number.isNaN(deleteAt) && deleteAt <= (yield* Clock.currentTimeMillis)) {
        return "expired" as const;
      }
    }
    return mapped;
  }),
  destroy: (input) =>
    requestText({
      provider: "celesto",
      stage: "delete",
      request: authorize(
        HttpClientRequest.delete(computerUrl(input.sandboxId)),
        input.config.apiKey,
      ),
    }).pipe(afterBusy, Effect.asVoid),
};
