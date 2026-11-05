# Sandbox environments

A sandbox provider turns an API key into a T3 environment the same way a user would add one by
hand: it creates a machine, starts `t3 serve` on port `3773`, exposes that port on a public HTTPS
origin (or only on the tailnet), and mints a pairing token. The client registers the returned
origin and token as an ordinary bearer environment, so projects, providers, terminals, and
reconnects use the existing remote path. Nothing downstream knows the machine is a sandbox.

Each thread on a sandbox gets its own machine. The server the user configures sandboxes on (the
host) is only the control plane: it keeps the configs, provisions a machine per thread, streams
the launch's stages, brokers the pairing, and stops, resumes, lists, and deletes the machines. The
thread itself runs on the sandbox's own T3 server, as on any remote environment.

## The driver contract

[`SandboxProviderDriver`](../../apps/server/src/sandbox/SandboxProvider.ts) is the whole extension
point: `create`, `execute`, `exposePort`, `destroy`, the optional `stop`/`resume` pair, `limits`,
`listEnvironments`, `status`, `usage`, `uploadFile`, `listSandboxes`, and templates, and the
presentation metadata in `info`. Clients learn which optional
methods exist from the `capabilities` the provisioner derives; they never branch on provider kind.
[`providers/index.ts`](../../apps/server/src/sandbox/providers/index.ts) is the registry; settings,
RPC, provisioning, and the Add environment UI read the driver's `info`.

Drivers must keep two invariants:

- **Reachability.** The exposed origin must serve the T3 server without a provider-specific header
  or cookie, because the browser client only knows how to send T3's bearer credential. Providers
  that gate URLs with their own token use the provider's public or ungated mode.
  If the provider's proxy answers CORS itself, the driver sets
  `serveEnvironment: { T3CODE_PROXY_HANDLES_CORS: "true" }` so `t3 serve` adds no CORS headers.
  Daytona's preview proxy echoes the caller's origin, and with the server's `*` the response
  carries two `Access-Control-Allow-Origin` values, which browsers reject.
- **Cleanup.** `SandboxProvisioner` destroys the machine when any step after `create` fails or is
  interrupted (including exposing the port), so a provisioned machine never bills without an
  environment pointing at it. Drivers must make `destroy` safe on a machine that never started.
  The provisioner never receives an id the driver did not return, so the driver cleans up two
  paths itself: a machine it creates before its own start polling, and a create whose answer was
  lost (`mayHaveCreated`). Boat and Celesto replay the create with the same `Idempotency-Key`;
  Daytona, Upstash, and Vercel name each attempt uniquely (`attemptSandboxName`) and delete that
  name. The provisioner writes a record with `state: "provisioning"` as soon as `create`
  returns, before any later step, so a crash mid-launch leaves a record that the next sweep
  destroys (a provisioning record with no live launch fiber). A provider sandbox with no record at
  all is only flagged, never deleted (see [Orphans](#orphans)).
- **Tags.** `create` receives `tags: { host, instance }`, the host's environment id and the
  record's instance id. A driver that can label sandboxes stores both, and `listSandboxes` returns
  the sandboxes carrying this host's tag. Boat stores them as `t3.code/host` and `t3.code/instance`
  labels; the other drivers do not tag yet, so they report no orphans.

## Adding a provider

Every provider in the registry implements the same contract. A new provider is a driver file, a registry
entry, its kind in contracts, and its logo; nothing else branches on the provider.

1. **Write the driver.** Add `apps/server/src/sandbox/providers/<provider>.ts` exporting a
   `SandboxProviderDriver`. Start from
   [`boat.ts`](../../apps/server/src/sandbox/providers/boat.ts) when the provider returns the public
   URL at create time, or from
   [`daytona.ts`](../../apps/server/src/sandbox/providers/daytona.ts) when it needs a separate
   preview-URL call, or from [`vercel.ts`](../../apps/server/src/sandbox/providers/vercel.ts) when
   it names sandboxes and runs them in sessions. Reuse `requestJson` (or `requestText` for bodies
   that are not one JSON document, such as an ND-JSON command stream), `jsonBody`, and `authorize`
   from `SandboxProvider.ts` so status handling and error mapping stay consistent. Their client has
   no transport timeout, because a synchronous command answers only when it ends; each call is cut
   at 300 s instead, so one that runs a command passes `commandRequestSeconds` of its run time.
   Celesto refuses an exec over 300 s or 10,000 characters, so its driver uploads a longer command,
   starts it under `setsid`, and polls a status file; any `execute` must honor the full
   `timeoutSeconds` the provisioner asks for (ten minutes for install).
   `requestJson` turns provider error bodies into a stable `code` (rate limited, concurrency full,
   billing required, size unavailable, …) with a bounded message; add the provider's own error
   codes to its table instead of writing messages in the driver, because clients react to `code`.
   It also sends a request again, within that deadline, when the provider documents the failure as
   safe to repeat: a short rate-limit wait, or a 5xx or lost connection on a GET, PUT, DELETE, or a
   create carrying `Idempotency-Key`. A command POST is never repeated unless the provider says it
   did not run (Boat's `sandbox_restoring`), so add such codes to that table, not a loop in the driver.
2. **Fill in `info`.** `kind`, `label`, `detail`, `apiKeyLabel`, `apiKeyPlaceholder`, `docsUrl`,
   and `sizes`. The settings UI, the API-key field, and the machine picker are generated from it.
   An account setting the provider needs besides the key (Vercel's team and project) is a
   `settingsFields` entry: the form shows it under the key, the server saves it next to the key,
   and the driver reads it from `config.settings`. These values are not secret and are sent to
   clients, so a credential never goes in one. When an optional one is empty, the driver picks a
   default or fails at the `config` stage with a short message naming the values that would work.
   Each record keeps the settings its sandbox was created with, plus any `settings` that `create`
   returns for defaults it resolved, and every later call for that sandbox uses them, so a
   setting that decides where a sandbox lives must be returned once resolved.
3. **Declare the provider kind and its mark.** Add it to `SandboxProviderKind` in
   `packages/contracts/src/sandbox.ts`. This is what persists on records and settings, so changing
   it later needs a migration. Add the brand mark to `SandboxProviderLogo.tsx`.
4. **Register the driver.** Add the import and the array entry in
   `providers/index.ts`. Scopes, RPCs, settings, and the rest of the UI need no changes.
5. **Decide the optional capabilities.**
   - `stop`/`resume` only if the provider can stop and start the same machine. The record's
     running limit still rules: a provider auto-stop must not be shorter than it, and one that
     deletes must run after it (see [Lifecycle and hard limits](#lifecycle-and-hard-limits)).
   - `uploadFile` only if the provider has a files API. The provisioner writes copied env files
     through it so their contents never appear in a command; without it they go through
     `execute`'s `secrets` like any other secret.
   - `listSandboxes` only if the provider can list sandboxes by the label `create` set.
   - `info.diskRetentionDays` only if the provider documents how long it keeps a stopped disk.
     The Sandboxes list warns three days before it.
   - `listEnvironments` only if the provider has named credential environments. Return **flags
     only** (`passGithub`, `passSecrets`, …). Never map `envContents`, `secretFiles`, or any other
     value that carries a real secret into `SandboxCredentialEnvironment`.
   - `limits` only if the provider reports quotas; with no quota API, omit it rather than guess.
     Return `null` when the account's limits can't be read (a key without that scope, for
     example), never an error. The provisioner runs `assessSandboxStart` before every create and
     resume, and it blocks only on what the provider says it would refuse; unknown or failed
     limits let the start through so the provider decides. A plan maximum for auto-stop
     (`maxTtlMinutes`) clamps the lifetime T3 records, so it is never a per-session cap: a
     provider that caps sessions clamps its own timeout in the driver and lets the session stop.
   - `status` lets the sweep notice a machine stopped, expired, or deleted outside T3. A machine
     the provider no longer has is `deleted`, not an error, and a provider state T3 does not track
     returns `null` so the record is left alone.
   - `usage` only if one request can return every T3 sandbox's cost; the sweep calls it once per
     provider, never once per machine. Tag sandboxes at create so the provider can filter them.
   - `saveTemplate`/`listTemplates`/`deleteTemplate` (with `stop`, and `create`'s `template`) only
     if the provider can snapshot a stopped machine and start new ones from it. A snapshot copies
     `~/.t3/userdata`: the environment id, auth sessions, and secrets. The provisioner's scrub
     removes them before the driver saves, and create refuses any machine that answers with an id
     a record already has, so a copy never inherits its source's identity or valid bearer tokens.
     Because the source loses its identity too, a successful save deletes it, so the template
     must not depend on the source's disk. List only templates T3 saved, never the provider's base
     images. A provider whose snapshots carry no name can keep a template as a stopped, tagged
     machine and start new ones as forks of it, as Vercel does.
6. **Add a size default and the server port.** `defaultSize` must be one of the `info.sizes` ids,
   and `serverPort` is `3773` unless the provider reserves it.
7. **Test it without the network.** Follow `SandboxProvisioner.test.ts`: `HttpClient.make`
   records the request method, URL, and body, and returns canned provider responses. Cover create
   (including the published port and the TTL), execute failure, expose, destroy, and any cleanup
   path the driver owns. `check:changed` runs them.

Three details apply to every provider:

- **The first successful create must be usable.** Publish port `3773` with a public, ungated
  origin (unless `publishPort` is `false`), and make sure the provider's own auto-stop or
  auto-delete is not shorter than the config's running limit. Where the plan caps it lower, `info.detail` says so.
- **The sandbox id survives a resume.** Record the id that stays the same across stop and resume.
  Vercel starts a new session on every resume, so its driver records the sandbox name and reads
  the current session before each command or stop, caching nothing between calls.
- **The sandbox labels itself.** Provisioning writes `<baseDir>/environment-label` (default
  `~/.t3/environment-label`) before starting the server, so the environment picks up the requested
  name without sudo or a writable `/etc`.

## What a sandbox gets from this server

A sandbox starts with none of the provisioning server's credentials. The create form can opt into
two: Claude's endpoint and token, and the server's github.com token. `SandboxProvidersResult.host`
tells clients only whether each exists and which Claude path applies; values never leave the
server except into the sandbox.

- **Setup runs before `t3 serve`.** The server's Claude status probe reads Claude's settings when
  the server starts, so writing them first lets the new environment report Claude ready on its
  first probe rather than signed out until the next refresh. Install, tool checks, Claude, and
  GitHub each run as their own `execute` before the start step, and a failure in any of them
  except install is a warning on the create result, not a failed create: the user still gets a
  working sandbox and a checklist of what is missing.
- **Secrets never reach command text, a shell parser, or an error.** Providers keep what they ran:
  Boat stores every command and its output for 90 days, and Vercel lists a session's command args.
  So scripts in [`sandboxSetup.ts`](../../apps/server/src/sandbox/sandboxSetup.ts) read secrets
  from environment variables that `execute` takes as `secrets`, and print nothing secret. Daytona
  and Vercel pass them as the command's env, which neither lists; Boat and Upstash have no
  per-command env, so their drivers write them to a 0600 file through the files API, and the
  command sources and deletes it first. Celesto's exec takes only command text and it has no files
  API, so its sandbox makes an RSA key pair and returns the public half; the driver seals that file
  to it (RSA-OAEP, SHA-256, one block per piece), and the sandbox decrypts it with `openssl` and
  removes the private key before the command runs. Only the public key and ciphertext cross the
  API, so keeping command text or output exposes nothing. What remains is Celesto as host: it can
  read the VM, and a public key swapped in an exec answer would reach it, which is no more than it
  already has. Provider errors can echo the command they ran, so a step that carries a secret maps its
  failure to a fixed message instead of the driver's detail.
- **A secret minted in the sandbox leaves it sealed.** Command output is kept as long as command
  text, so the pairing token cannot come back as `t3 pair` prints it. The server makes an RSA key
  pair for each pairing, and [`sandboxPairing.ts`](../../apps/server/src/sandbox/sandboxPairing.ts)
  puts only the public key in the command, which seals the token (RSA-OAEP, SHA-256) with the
  `openssl` CLI, or Node where an image has no `openssl`, and prints only that. A failed
  `t3 pair` reports its exit status and a sealed stderr tail; an image with neither tool fails the
  create rather than printing the token. Headless `t3 serve` also logs a token, URL, and QR code, so the
  start step filters those lines out of the log tail it reports when the server does not answer.
- **A hub key belongs to one sandbox.** When the server's Claude endpoint is a CLIProxyAPI hub with
  a management key, the provisioner adds a fresh `t3-sandbox-<label>-<hex>` key through the hub's
  management API instead of copying the server's own key, so deleting the sandbox can revoke
  exactly what it was given. The key is added before the machine is created, so a hub that refuses
  costs no provider start, and it is removed again if provisioning fails. The record keeps the
  hub source id and a server-secret name, never the key. A failed revoke on delete is a warning
  that names the key prefix; it never blocks the delete, because the machine is already gone.
  Without a hub, the server's token is copied and cannot be revoked by T3; a hub whose management
  key names a secret that cannot be read fails the create instead of falling back to that copy.
- **Reachable here is not reachable there.** A Claude endpoint on a tailnet or LAN address
  works from the provisioning server and times out from a cloud machine. The provisioner curls
  the endpoint from the sandbox after writing the settings; no HTTP answer at all marks Claude as
  failed with a warning, and the hub key is kept, since fixing the network makes it work. The form
  warns earlier when the server's own endpoint resolves only to private addresses, judged by
  address rather than name, because a `*.ts.net` Funnel host is public.
- **A tailnet node belongs to one sandbox.** A private endpoint is reached by joining the sandbox
  to the server's tailnet, never by sharing the OAuth client: the server mints one single-use,
  pre-approved, ephemeral key per join, tagged so the tailnet policy can limit what sandboxes
  reach. Ephemeral means Tailscale removes a node it stops hearing from, so a provider-side delete
  or a lost record cannot leave one behind for long; T3 still deletes the device on delete, on a
  failed create, and when a resume rejoins as a new one, because that removal can take an hour.
  The join runs before Claude's settings, since a sandbox without a TUN device needs Claude
  pointed at tailscaled's userspace proxy.
- **Templates do not inherit access.** The template scrub also removes the Claude endpoint, the
  `gh` login, and the tailnet node (`tailscale logout` and its state), and a successful save revokes the source's hub key along with deleting the source.
- **Missing tools are installed, never required.** git, the GitHub CLI, and Claude Code are
  installed only when `command -v` cannot find them, into `~/.local/bin` where root is not
  available, and the script always exits zero and reports what is still missing. Boat ships all
  three, so it is a no-op there; other images can lack `gh`.

## Configs and per-thread launches

A `SandboxEnvironmentConfig` (`sandbox_configs`, migration 081) holds what each machine is made
from: provider, size or template, what it gets from the host (Claude, GitHub, tailnet), `access`,
the projects allowed, per-project copied files, and the running limit. Saving one validates it and
creates nothing.

`sandboxes.launch` takes a config, a thread id, and the host's project, and refuses a project the
config does not allow or one without a github.com remote. The launch runs in a fiber forked into
the provisioner's own scope, so it outlives the RPC that started it, and reports a
`SandboxSetupSnapshot` per change through
[`sandboxLaunches.ts`](../../apps/server/src/sandbox/sandboxLaunches.ts), which clients read with
`sandboxes.subscribeLaunch`. Stages run in a fixed order: `preflight`, `create`, `install`,
`credentials`, `start`, `repo`, `env-files`, `pair`.

- **Tailnet.** `launchJoinsTailnet` decides at each launch: the config's `joinTailnet` (stored
  `false` means automatic), a tailnet-only `access`, or Claude's endpoint resolving only to
  private or tailnet addresses (`SandboxHostAccess.endpointIsPrivate`) while a Tailscale client
  is saved. A private endpoint with no client fails `preflight`, before anything bills, with code
  `tailscale_required` and `recovery: "set-up-tailscale"`; the card links to the Tailscale card.
  A relaunch re-reads the config, so an edit made after a refusal applies.
- **Failure policy.** A failure up to `start` destroys the machine and ends the launch with
  `recovery: "relaunch"`. A failure in `repo` or `pair` keeps the machine and waits on the
  launch's retry queue with `recovery: "retry"`. `env-files` and the other credential steps only
  warn, except that a sandbox that cannot reach Claude's endpoint (checked with retries for about
  half a minute, since a fresh tailnet join can need a moment for its route) fails `credentials`:
  a thread handed to it would sit on Thinking while Claude retries. `sandboxes.create` keeps that
  check as a warning.
- **Cancel** interrupts the fiber at any stage; its `onExit` destroys the machine, revokes the hub
  key, removes the key's secret, deletes the tailnet device, and removes the record.
- **Clone.** The `repo` step runs `git clone` from the project's GitHub URL into `~/work/<repo>`
  and adds it as a project on the sandbox's server, which prints the directory and project id.
- **Copied files.** By default the git-ignored files `isDefaultCopiedFile` accepts (env files),
  or the config's list for that project, read from the host's checkout and written into the clone
  through `uploadFile` with mode 600.
- **Pairing.** The host pairs with the sandbox (sealed, as below) and hands the client the origin
  and pairing code through `sandboxes.pairLaunch`; the client registers the environment, waits
  for the project to appear, retargets the composer draft onto it, sends, and calls
  `sandboxes.completeLaunch`, which marks the record with the thread id.

## Lifecycle and hard limits

Every machine gets a row in `sandbox_instances` (see
[`SandboxRecords.ts`](../../apps/server/src/persistence/SandboxRecords.ts)) keyed by an instance id
the provisioner picks before create, since the environment id is only known once T3 answers on
the machine. Environments stay the source of truth for connection details; the record only adds
what the provider needs to act on the machine (provider, sandbox id, size, credential environment)
and the thread, config, and project it belongs to.

`maxRunningMinutes` (480 by default, clamped to the provider's `maxTtlMinutes`) limits how long a
sandbox runs since its last start (`runningSince`); a resume starts the count again. The sweep runs
once a minute and calls the driver's `stop` on a sandbox past its limit; a failed stop is logged and
retried on the next sweep. `idleStopMinutes` is stored for a later idle stop and does nothing yet.
A stop sets `stoppedAt`, which the Sandboxes list shows as the disk's age against the provider's
`diskRetentionDays`. Nothing deletes a stopped sandbox automatically.

The provider's own auto-stop is only a backstop for when T3 is offline, and it must never destroy
what T3's stop would keep. Boat's auto-stop is set to the running limit on create and resume, and a
plan with a lower maximum (trial: two hours) stops the machine early. Daytona's TTL deletes the
sandbox, disk included, even when stopped, so it is set 24 hours past the running limit. Vercel's
is the session timeout, capped by the plan (45 minutes on Hobby, a day on Pro), so a Hobby sandbox
stops early and the sweep records it as stopped. Its stopped disk is kept for 30 days. Upstash and
Celesto have no lifetime of their own, so the sweep's stop is the only limit; a Celesto sandbox
bills until T3 stops it. Upstash also pauses an idle box and wakes it on any visit to its URL,
restarting T3 through the box's init command; the sweep records both.

The same sweep makes the record match the provider, because T3 usually runs where webhooks can't
reach it. Each record gets at most one provider call per sweep, with a few in flight at a time. An
unreachable provider changes nothing: the record keeps its state rather than turning into an error,
and an `error` record stays one while the provider reports the machine running, since that state
means T3 is not answering on it. The sweep writes only when the record has not changed since it was
read, so a user's stop or resume during a slow provider call wins. `expired` and `deleted` records
stay listed until the user deletes them; deleting a `deleted` record skips the provider.

### Orphans

The sweep also calls `listSandboxes` once per configured provider and reports every sandbox
carrying this host's tag that no record or running launch accounts for. `sandboxes.list` returns
them as `orphans`, and the Sandboxes list shows them under "Not tracked by T3 Code" with a delete
button. They are never deleted automatically, since a record can be lost while the machine still
holds work.

Templates are saved only from a sandbox with no thread: saving deletes the source machine.

`stop` and `resume` are optional on the driver. A provider without them still provisions and
connects; the settings UI hides the controls and the RPC returns a configuration error instead of
inventing a lifecycle the provider does not have.

## Verification

Driver tests use `HttpClient.make` to assert the provider requests and error mapping; the
provisioner test asserts the install/pair sequence, the returned pairing code, and cleanup. The
per-thread suite in `SandboxProvisioner.test.ts` runs launches against a fake Boat: a full launch
(tags, the env file through the files API, no secret in any command), a failed install, a failed
clone with retry and cancel, a cancel mid-install, the refusals, and the sweep's orphan and
abandoned-record handling. A new
driver needs the same coverage for its create, execute, expose, and destroy paths.
