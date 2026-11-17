// Pi on a sandbox: the CLIProxyAPI hub's non-Claude models, on the key the sandbox gets for Claude.
// The key reaches the sandbox only through `secrets` and lands in Pi's models.json (mode 600), the
// same way Claude's settings.json holds it.

import {
  SANDBOX_PI_INSTANCE_ID,
  SANDBOX_PI_PROVIDER,
  sandboxPiModelSlug,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import type { SandboxScript } from "./sandboxSetup.ts";

export class SandboxPiModelsError extends Schema.TaggedError<SandboxPiModelsError>()(
  "SandboxPiModelsError",
  { detail: Schema.String },
) {}

/** The hub's OpenAI-compatible root for Claude's endpoint, which may already end in `/v1`. */
export const hubOpenAiBaseUrl = (claudeBaseUrl: string) =>
  `${claudeBaseUrl.trim().replace(/\/+$/u, "").replace(/\/v1$/u, "")}/v1`;

/** The models Pi gets: everything but Claude, and `vendor/Model` over a bare `Model` alias. */
export const hubAgentModels = (ids: ReadonlyArray<string>): ReadonlyArray<string> => {
  const others = [
    ...new Set(ids.map((id) => id.trim()).filter((id) => id !== "" && !/(^|\/)claude/iu.test(id))),
  ];
  const prefixed = new Set(
    others.filter((id) => id.includes("/")).map((id) => id.slice(id.lastIndexOf("/") + 1)),
  );
  return others.filter((id) => id.includes("/") || !prefixed.has(id));
};

// Wafer's public catalog (pass.wafer.ai/v1/models) gives each a 1M context; only GLM-5.3-Flash has
// an output cap of its own, so the others get a bounded one. Models not listed keep Pi's defaults.
const MODEL_LIMITS: Readonly<Record<string, { contextWindow: number; maxTokens: number }>> = {
  "GLM-5.3": { contextWindow: 1_048_576, maxTokens: 131_072 },
  "GLM-5.3-Flash": { contextWindow: 1_048_576, maxTokens: 196_608 },
  "DeepSeek-V4.1-Flash-1017": { contextWindow: 1_048_576, maxTokens: 262_144 },
};

// Pi level → the `reasoning_effort` the hub passes on. Without a map Pi offers no xhigh or max.
const THINKING_LEVEL_MAP = {
  off: "none",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
  max: "max",
} as const;

const modelName = (id: string) => id.slice(id.lastIndexOf("/") + 1).replaceAll("-", " ");

/** Pi's `models.json` provider entry for the hub. */
export const piHubProvider = (input: {
  readonly claudeBaseUrl: string;
  readonly apiKey: string;
  readonly models: ReadonlyArray<string>;
}) => ({
  name: "CLIProxyAPI hub",
  baseUrl: hubOpenAiBaseUrl(input.claudeBaseUrl),
  api: "openai-completions",
  apiKey: input.apiKey,
  compat: { supportsReasoningEffort: true, thinkingFormat: "openai" },
  models: input.models.map((id) => {
    const limits = MODEL_LIMITS[id.slice(id.lastIndexOf("/") + 1)];
    return {
      id,
      name: modelName(id),
      reasoning: true,
      thinkingLevelMap: THINKING_LEVEL_MAP,
      ...(limits === undefined ? {} : { input: ["text", "image"], ...limits }),
    };
  }),
});

const HubModels = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });
const decodeHubModels = Schema.decodeUnknownEffect(HubModels);

/** The ids the hub lists for `key`. Failures carry a fixed detail: a hub answer can echo the key. */
export const fetchHubModels = Effect.fn("SandboxPi.fetchHubModels")(function* (
  claudeBaseUrl: string,
  key: string,
) {
  const client = yield* HttpClient.HttpClient;
  const failed = () => new SandboxPiModelsError({ detail: "The hub did not list its models." });
  const response = yield* client
    .execute(
      HttpClientRequest.get(`${hubOpenAiBaseUrl(claudeBaseUrl)}/models`).pipe(
        HttpClientRequest.bearerToken(key),
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((ok) => ok.json),
      Effect.timeout("15 seconds"),
      Effect.mapError(failed),
    );
  const decoded = yield* decodeHubModels(response).pipe(Effect.mapError(failed));
  return decoded.data.map((model) => model.id);
});

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/**
 * Installs Pi when missing, merges the hub provider into Pi's models.json, makes `model` Pi's
 * default, and turns on T3's Pi provider. With `startsChats`, T3's default model is Pi's too, so a
 * chat the bridge starts runs there. Runs before `t3 serve`, so its first probe already lists Pi.
 */
export const piSetupScript = (input: {
  readonly provider: ReturnType<typeof piHubProvider>;
  readonly model: string;
  readonly startsChats: boolean;
}): SandboxScript => ({
  secrets: {
    T3_PI_PROVIDER: JSON.stringify(input.provider),
    T3_PI_CHOICE: JSON.stringify({
      model: input.model,
      ...(input.startsChats
        ? {
            t3Default: {
              instanceId: SANDBOX_PI_INSTANCE_ID,
              model: sandboxPiModelSlug(input.model),
            },
          }
        : {}),
    }),
  },
  command: `set -eu
umask 077
export PATH="$HOME/.local/bin:$PATH"
if ! command -v pi >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  npm install -g --prefix "$HOME/.local" ${PI_PACKAGE} >/dev/null 2>&1 || true
fi
if ! pi --version >/dev/null 2>&1; then
  unset T3_PI_PROVIDER T3_PI_CHOICE
  echo "Pi could not be installed." >&2
  exit 3
fi
mkdir -p "$HOME/.pi/agent" "$HOME/.t3/userdata"
node -e '
const fs = require("node:fs");
const [agent, t3Settings, binary, name, instance] = process.argv.slice(1);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const read = (file) => {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(file + " is not valid JSON");
  }
  if (!isObject(value)) throw new Error(file + " is not an object");
  return value;
};
const write = (file, value) => {
  fs.writeFileSync(file + ".t3-tmp", JSON.stringify(value, null, 2) + "\\n", { mode: 0o600 });
  fs.renameSync(file + ".t3-tmp", file);
  fs.chmodSync(file, 0o600);
};
const provider = JSON.parse(process.env.T3_PI_PROVIDER);
const choice = JSON.parse(process.env.T3_PI_CHOICE);
const models = read(agent + "/models.json");
models.providers = { ...(isObject(models.providers) ? models.providers : {}), [name]: provider };
write(agent + "/models.json", models);
write(agent + "/settings.json", { ...read(agent + "/settings.json"), defaultProvider: name, defaultModel: choice.model });
const t3 = read(t3Settings);
const instances = isObject(t3.providerInstances) ? t3.providerInstances : {};
const current = isObject(instances[instance]) ? instances[instance] : {};
const config = isObject(current.config) ? current.config : {};
t3.providerInstances = {
  ...instances,
  [instance]: { ...current, driver: "pi", enabled: true, config: { ...config, enabled: true, binaryPath: binary } },
};
if (choice.t3Default !== undefined) t3.defaultModelSelection = choice.t3Default;
write(t3Settings, t3);
' "$HOME/.pi/agent" "$HOME/.t3/userdata/settings.json" "$(command -v pi)" ${SANDBOX_PI_PROVIDER} ${SANDBOX_PI_INSTANCE_ID}
unset T3_PI_PROVIDER T3_PI_CHOICE`,
});

// Run before a template save: a copy must not inherit the hub key. T3's settings go with userdata,
// and the binary stays so a copy that sets Pi up skips the install.
export const PI_SETTINGS_SCRUB = `if command -v node >/dev/null 2>&1; then
  node -e '
const fs = require("node:fs");
const [agent, name] = process.argv.slice(1);
const edit = (file, change) => {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return; }
  if (value === null || typeof value !== "object") return;
  change(value);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\\n", { mode: 0o600 });
};
edit(agent + "/models.json", (models) => { if (models.providers) delete models.providers[name]; });
edit(agent + "/settings.json", (settings) => {
  if (settings.defaultProvider === name) { delete settings.defaultProvider; delete settings.defaultModel; }
});
' "$HOME/.pi/agent" ${SANDBOX_PI_PROVIDER} >/dev/null 2>&1 || true
fi`;
