# Sandbox environments

A sandbox provider turns an API key into a T3 environment the same way a user would add one by
hand: it creates a machine, starts `t3 serve` on port `3773`, exposes that port on a public HTTPS
origin (or only on the tailnet), and mints a pairing token. The client registers the returned
origin and token as an ordinary bearer environment, so projects, providers, terminals, and
reconnects use the existing remote path. The sandbox's own server does not know it is one; only
the client does, and it shows the machine as part of its host (see
[Lifecycle and hard limits](#lifecycle-and-hard-limits)).

Each thread on a sandbox gets its own machine. The server the user configures sandboxes on (the
host) is only the control plane: it keeps the configs, provisions a machine per thread, streams
the launch's stages, brokers the pairing, and stops, resumes, lists, and deletes the machines. The
thread itself runs on the sandbox's own T3 server, as on any remote environment.

## The driver contract

[`SandboxProviderDriver`](../../apps/server/src/sandbox/SandboxProvider.ts) is the whole extension
point: `create`, `execute`, `exposePort`, `destroy`, the optional `stop`/`resume` pair, `limits`,
`listEnvironments`, `status`, `usage`, `uploadFile`, `listSandboxes`, `agentAccess`, and templates, and the
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

A sandbox starts with none of the provisioning server's credentials, and with the server's settings
only where they mean the same off the host. The create form can opt into
two: Claude's endpoint and token, and the server's github.com token. `SandboxProvidersResult.host`
tells clients only whether each exists and which Claude path applies; values never leave the
server except into the sandbox.

- **A sandbox follows the host's settings.** Once T3 is installed, before the tailnet, Claude, Pi
  and `t3 serve`, the provisioner merges the host's followed settings into the sandbox's
  `$HOME/.t3/userdata/settings.json`; Pi setup then merges its provider instance and default model
  into the same file, keeping them.
  [`sandboxSettings.ts`](../../packages/contracts/src/sandboxSettings.ts) classifies every server
  setting as followed or host-only, and its test fails when a new setting is in neither list, so a
  new setting stays on the host until someone decides it can follow.
  Host-only means secrets and secret references, host paths and hardware, the host's identity and
  links, settings keyed by the host's project ids, the default and fallback models Pi setup sets,
  and the thread environment mode. The seed holds only followed values that differ from the
  defaults, so a sandbox on an older T3 that cannot decode a new value loses less. A failed seed
  is a warning on the create result.
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
- **Pi rides the same hub key.** A config's `pi` sets up the Pi agent with the hub's non-Claude
  models ([`sandboxPi.ts`](../../apps/server/src/sandbox/sandboxPi.ts)), so it is refused without a
  hub: a copied token could not be revoked. The host lists `/v1/models` with the sandbox's own key,
  so Pi gets exactly what that key reaches, and a `vendor/Model` wins over the hub's bare alias for
  it. The script writes Pi's `models.json`, makes the chosen model Pi's default, and turns on T3's
  Pi instance before `t3 serve`, so the first probe lists it. Model limits come from a small table
  (Wafer's catalog); unknown models keep Pi's defaults. Pi does not get the userspace tailnet proxy,
  so a private hub reached only through it works for Claude and not for Pi.
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
- **The agent's provider key belongs to one sandbox.** With `agentProviderAccess`, a driver that
  implements `agentAccess` (Boat only) gives the sandbox's agent its own key. `prepare` refuses it
  with a credential environment and runs `agentAccess.check` before anything bills; Boat's check
  asks to mint a key for a sandbox no account has (`bx_t3probe0`), where only a key allowed to mint
  gets as far as `403 api_key_sandbox_forbidden`, and any other 401/403 fails with
  `scoped_keys_unavailable`. `provisionMachine` then creates an environment for this sandbox alone
  (Boat answers a create with every environment, so the unique name finds it), turns off every
  `pass*` flag and reads it back, deleting it and failing when anything is still passed, and
  creates the sandbox in it. Forks land in the parent's environment, so `sandbox.create` scoped to
  that environment is what lets `boat fork` work; without it Boat answers 403. After create, it
  mints the key (`sandboxIds: [id]`, `environmentIds: [envId]`, ttl the running limit) and revokes
  it on the spot when Boat reports a wider scope, since an empty `sandboxIds` means every sandbox.
  The login script reads the key from `secrets`. A key that cannot be minted or signed in is a
  warning and a revoke, not a failed launch. The record keeps the environment id and name and the
  key id, never the key. Rollback destroys the machine, then deletes the environment, and revokes
  the key; a user delete revokes the key first, deletes the forks it finds in the environment, then
  the machine, and the environment only when nothing is left in it, since it is the only way to
  find a fork again. The sweep's abandoned-launch delete never touches forks. The driver hides
  `t3-sandbox-*` environments from `listEnvironments`, so they never show as credential choices.
- **Every sandbox's agents are told the machine is disposable.** A stop empties `/tmp` and the
  sandbox is deleted when its chat ends, so a deliverable left only in a file is lost. A skill is
  loaded only when Claude chooses to, so the facts that lose work go in a block that is always
  loaded: `SANDBOX_AGENT_INSTRUCTIONS` in
  [`sandboxSetup.ts`](../../apps/server/src/sandbox/sandboxSetup.ts), between
  `SANDBOX_INSTRUCTIONS_START`/`END` markers in Claude's `CLAUDE.md`, Codex's `AGENTS.md` and Pi's
  global context file (each agent's override file when one exists). `sandboxAgentGuidanceScript`
  writes the block and Claude's `t3-sandbox-files` skill, which shares the lifetime sentence and
  covers where files go. It replaces only the marked block, so the rest of each file stays and the
  block never duplicates. The launch's tools step runs it after the user's `CLAUDE.md` and skills
  are copied, every launch including a subagent's sandbox; every resume runs it before `t3 serve`.
  It carries no secrets. It counts in the tools step only when it fails, so a config that asks for
  nothing still reads "Nothing to set up", and either failure is a warning.
- **A GitHub App token covers the whole installation.** `mintGithubToken` finds the installation
  through the sandbox's repository (`GET /repos/{owner}/{repo}/installation`; a 404 is "not
  installed", a launch warning with the install link), then mints with no `repositories` in the
  body, so the token reaches every repository the user installed the app on and an agent can push
  to a second repository from one sandbox. The record keeps `{ installationId, repository, secret,
  expiresAt }`; the sweep renews a running sandbox's token 20 minutes before it expires (and a
  resume renews it at once) with the known installation id, writes it with the login script, then
  revokes the old one. The manifest
  asks for `workflows: "write"` because GitHub refuses a push that touches `.github/workflows/`
  without it; an app made from an older manifest needs it added on GitHub and approved by each
  installation.
- **A Railway token belongs to one sandbox.** The saved workspace token mints
  `t3-sandbox-<sandboxId>` in its workspace ([`railwayApi.ts`](../../apps/server/src/sandbox/railwayApi.ts)).
  Railway returns only the token's value, so every revoke lists the workspace's tokens and deletes
  each with that name; the record names the token before the mint, so a crash in between still
  leaves one to find, and an untracked sandbox's delete looks it up by its id. GraphQL refusals
  arrive as HTTP 200 with `errors`. The token goes into Claude's settings `env` as
  `RAILWAY_API_TOKEN` (the CLI reads it first and never refreshes it), so Claude and its tools get
  it but other providers and terminals do not. A selected Railway MCP server, hosted or not, becomes
  the sandbox's own `railway mcp` with the token in its `env`: `@railway/mcp-server` is now a shim
  for that command, and the hosted server's OAuth sign-in cannot be reused.
- **Templates do not inherit access.** The template scrub also removes the Claude endpoint (and
  `RAILWAY_API_TOKEN`), Pi's hub provider, the `gh` login, `~/.railway`, and the tailnet node
  (`tailscale logout` and its state), and a successful save revokes the source's hub key and
  Railway token along with deleting the source.
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
config does not allow or one without a github.com remote. A thread has one machine: a launch for a
thread whose record is not `deleted` returns that record's instance id and creates
nothing, since a client that lost its handoff sends again. An abandoned launch's machine is the
exception, and it is deleted first; when that delete fails the launch fails, so the old machine
never bills beside a new one. The launch runs in a fiber forked into
the provisioner's own scope, so it outlives the RPC that started it, and reports a
`SandboxSetupSnapshot` per change through
[`sandboxLaunches.ts`](../../apps/server/src/sandbox/sandboxLaunches.ts), which clients read with
`sandboxes.subscribeLaunch`. Stages run in a fixed order: `preflight`, `create`, `install`,
`credentials`, `start`, `repo`, `env-files`, `pair`.

- **Tailnet.** `launchJoinsTailnet` decides at each launch: the config's `joinTailnet` (stored
  `false` means automatic), a tailnet-only `access`, or Claude's endpoint resolving only to
  private or tailnet addresses (`SandboxHostAccess.endpointIsPrivate`) while a Tailscale client
  is saved. A private endpoint with no client fails `preflight`, before anything bills, with code
  `tailscale_required` and `recovery: "set-up-tailscale"`; the card links to Tailscale under Sandboxes → Integrations.
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
  for the project to appear, and calls `sandboxes.completeLaunch`, which marks the record with the
  thread id and returns once the launch fiber (bridge credential included) has ended. The client
  then links the host thread (see [Sandbox bridge](#sandbox-bridge)) and sends on the sandbox's
  project, linked or not.

## Sandbox bridge

A thread that runs on a sandbox lives on the sandbox's own T3 server, which only clients paired with
it can drive. The bridge lets any client of the host (the phone included) drive it through the host,
without pairing with the sandbox.

- **One provider instance.** `sandboxes` (displayName "Sandboxes", driver `acpRegistry`, source
  `local`) runs this server's own entrypoint as `sandbox-bridge`, a fast path in
  [`bin.ts`](../../apps/server/src/bin.ts). The agent is
  [`packages/sandbox-bridge`](../../packages/sandbox-bridge/src/bridge.ts); the process wiring is
  [`sandboxBridgeCli.ts`](../../apps/server/src/sandbox/sandboxBridgeCli.ts).
  [`sandboxBridge.ts`](../../apps/server/src/sandbox/sandboxBridge.ts) seeds the instance at
  startup and rewrites it only when its command or secrets directory is stale, keeping user edits.
  It is off machine-wide on first seed; each host project of a sandbox thread enables it with a
  project override (`providerInstances.sandboxes.enabled`), so it shows in that project's pickers
  only. Project-enabled instances are probed and routed even when off machine-wide.
- **Same thread id.** The host thread and the sandbox thread share a `ThreadId`. `session/new`
  reads the host thread through the thread-scoped MCP credential (`t3_thread_configure`) and
  answers `sandbox:<threadId>`; the provider probe (`t3-code-provider-test`), a session without
  that MCP server, or a thread with no link gets a dry-run session that explains itself. Sessions
  resume without replay: the host keeps the conversation.
- **A turn.** Each prompt opens one WebSocket to the sandbox (a ticket from
  `/api/auth/websocket-ticket/rpc` with the bridge's bearer and `orchestrationProtocol`). The
  bridge forwards the user's text and images: it unwraps the host's `<t3_code_instructions>` /
  `<user_request>` wrapper, drops the `<runtime_info>` block and the host-path attachment lines,
  saves image blocks on the sandbox (`assets.persistChatAttachments`) and names any other file in a
  notice, since only images reach it. The host's ACP adapter puts the T3 message in the prompt's
  `_meta` (`SANDBOX_BRIDGE_MESSAGE_META`), and the bridge reuses that id on the sandbox: a message the
  sandbox already has (sent on the computer, or forwarded before a restart) is followed, replaying
  its run, instead of sent again, and the host's own "continue" after a restart follows the
  sandbox's latest message. A new message launches the thread there (same id, the sandbox project,
  the sandbox's default model or Claude) or is dispatched, after moving the sandbox thread to the
  host thread's runtime and interaction modes. It streams new text, plans and summarized tool,
  command and subagent activity, and ends the ACP turn (`state_update` idle) when the run carrying
  the message ends. What was on the thread before is never streamed, judged by when the sandbox
  last touched each item, not by membership in its first read or by ordinal:
  `getThreadProjection` returns a bounded window while `subscribeThread`'s snapshot is the whole
  thread, and item ordinals restart with each provider thread.
- **Modes.** The sandbox thread runs in the host thread's runtime and interaction modes. The host
  forwards a mode change on a `sandboxes` thread as soon as it happens (`SandboxThreadRemote`), and
  each new message re-checks them, so Supervised asks and other modes do not wait.
- **Approvals and questions.** Nothing the sandbox asks is ever left unanswerable. On a Supervised
  host thread a pending approval becomes `session/request_permission` with an `edit` or `execute`
  tool kind (never a read kind the host's policy would allow on its own); on any other mode, whose
  policy would answer a permission request alone, it becomes a one-question form. Questions become an
  `elicitation/create` form; declining dismisses them. The bridge keeps reading the sandbox while the
  host asks: when the request is answered on the sandbox (on the computer), it sends
  `SANDBOX_BRIDGE_WITHDRAW_METHOD` and the host's ACP adapter cancels its copy. Requests already
  pending when a turn starts are surfaced first.
- **Cancel.** The `sandboxes` instance has no native steering, so the host steers by cancelling
  the prompt and restarting the run with the new message. A cancel that is not the user's Stop
  (no runtime restart requested) carries `_meta` `SANDBOX_BRIDGE_CANCEL_META: "steer"`
  (`steerCancelMeta` on the ACP flavor); the bridge ends the host turn `cancelled` and leaves the
  sandbox working, and the next prompt sends the message with `deliveryIntent: "auto"`, as any
  chat send does, so a busy sandbox thread takes it as a steer or queues it. Every send uses
  that intent. Any other cancel is Stop: `thread.stop` where the sandbox advertises it (which, as
  in any chat, also stops the thread's delegated tasks), else `run.interrupt`.
- **Credential.** After the launch hand-off the provisioner runs
  [`bridgeCredentialScript`](../../apps/server/src/sandbox/sandboxBridgeCredential.ts) on the
  sandbox: `t3 auth session issue` with `orchestration:read` and `orchestration:operate`, label
  `t3-sandbox-bridge`, 365 days (the CLI has no cap, and the token dies with the machine). The
  token comes back sealed to a one-time key in 180-byte parts, like the pairing code. The record
  keeps `bridge: { sessionId, secret, expiresAt }`; the token, address, sandbox project and ids sit
  in the server secret `sandbox-bridge-<hex thread id>`, which the bridge reads from the directory
  the instance environment names (`T3_SANDBOX_BRIDGE_SECRETS_DIR`). Resume rewrites the link and
  re-mints a bearer within 30 days of expiry, revoking the old one; delete removes the secret.
- **Linking.** `sandboxes.linkHostThread` (settings-write scope) picks the host project: the
  launch's verified host copy (`hostProjectId` on the record), or a lightweight project, an empty
  folder `<baseDir>/sandbox-projects/<owner>/<repo>` titled with the repository name, reused per
  repository and never a checkout (`isSandboxHostProjectRoot` recognises it). It enables the
  instance there, ensures the credential, saves `hostProjectId`, and returns the model selection
  (`sandboxes` / `sandbox`) to create the host thread with. Call it after `completeLaunch`.
- **The client's handoff**
  ([`useSandboxLaunch.tsx`](../../apps/web/src/components/chat/useSandboxLaunch.tsx)). After
  linking, the draft keeps its thread id and waits until the host's provider list has `sandboxes`
  ready and the project override arrived (`sandboxBridgeReady`), so the host can create its
  thread; then it moves to the sandbox's project, keeping the model and modes the user picked, and
  sends. Past 60 seconds it sends anyway; when linking fails it sends with a warning that the
  phone cannot follow the thread. A config whose chats start on Pi (`pi.startModel`) cannot be
  picked on the host, which lists no hub models, so the draft also waits for the sandbox to list
  Pi with that model and moves onto it; the sandbox's default model is set to it too, so a chat
  the bridge starts from the phone runs there. The client stays paired with the sandbox for files, diffs and
  terminals. This state lives only in the composer, and the host's card is gone 30 seconds after
  `completeLaunch`, so the record is what resumes it: a draft whose thread has a running record
  on a sandbox this client is paired with, while no launch runs, links and sends on that sandbox
  (a remount or a reload), and a send for a thread whose sandbox is stopped or unreachable waits
  with a toast instead of launching.
- **One thread on the computer.** A sandbox chat the host mirrors lists as one of its two threads.
  `sandboxChatAliases` (in `state/sandboxThreads.ts`) shows the sandbox's own thread only while
  `showsSandboxOwnThread`: the sandbox is running, not resuming, and its environment is connected.
  Otherwise the host's mirror stands for it, since the host keeps it live and a send there waits on
  the host while the sandbox resumes. The sidebar, the command palette and `ChatView`'s redirect
  all read that one map, so the chat never has two rows. The redirect carries an unsent draft
  across (`moveComposerPromptAndImages`) and waits while the user is scrolled back with an empty
  composer. A chat with no mirror listed keeps its sandbox's thread and the client-side resume
  path (`sandboxResendPending`). `sandboxHostMirrors` pairs the two threads when both are listed,
  and the mirror takes the sandbox thread's title. Each
  message the composer sends on a linked sandbox thread (not on the mirror) is copied to the mirror with the same
  message id and `dispatchMode: "queue"`
  ([`useSandboxMirrorSend.ts`](../../apps/web/src/components/chat/useSandboxMirrorSend.ts)), after
  setting the mirror's modes to the thread's, creating the mirror on the first message. Its bridge
  finds the message already on the sandbox and streams the answer instead of sending it again.
  Attachments stay on the sandbox; the mirror's message notes how many were sent.
- **Which thread is the sandbox's.** `findThreadSandbox` matches a record by the sandbox's
  environment and thread id, or, on the provisioning environment, by thread id once the record has
  `hostProjectId`. Whether the conversation survives a delete depends on whether a host thread with
  that id exists, not on the record: a launch that fell back still has `hostProjectId`.
  A host thread never takes the client-side resume path; un-settle and the header's **Resume** call
  `sandboxes.resume` without waiting, and a send relies on the watcher below.
- **Placeholder projects.** A project whose root `isSandboxHostProjectRoot` matches gets no git
  status, scripts, open-in, files or terminal in the web app.
- **Stopped sandbox.** A run starting on a `sandboxes` thread whose sandbox is stopped makes the
  host resume it. Meanwhile the bridge retries for `SANDBOX_RESUME_WAIT_SECONDS` (16 minutes:
  every step of a resume at its limit, `SANDBOX_RESUME_STEP_SECONDS`, plus a minute), showing
  "Starting sandbox bx_…", then says the sandbox is not answering. Messages sent meanwhile queue
  behind that run on the host, so they go out after it whether or not a client stays open.

## Sub-sandboxes

`delegate_task` with `target.sandbox` starts the child on a sandbox of its own
([`SubSandboxes.ts`](../../apps/server/src/sandbox/SubSandboxes.ts), rules in
[`subSandboxPolicy.ts`](../../apps/server/src/sandbox/subSandboxPolicy.ts)): the parent's sandbox
config or the project's, a place held within the config's `subSandboxes` limits, `createSubSandbox`,
a peer link, and `RemoteDelegation.delegate`. When the task ends, `settle` runs `checkWork` and
deletes the sandbox when it is clean, else stops and keeps it.

Agents on a sandbox reach the same path through a helper the host installs, since the sandbox runs
the official T3 Code ([`subSandboxHelper.ts`](../../apps/server/src/sandbox/subSandboxHelper.ts),
[`SubSandboxRequests.ts`](../../apps/server/src/sandbox/SubSandboxRequests.ts)).

- **The helper** is a stdio MCP server, `~/.t3/userdata/sub-sandbox/mcp.mjs`, using only Node
  built-ins. Node is what the fork already needs to register MCP servers in Claude's
  `~/.claude.json`, where it is registered as `t3-sub-sandbox` with the absolute path of the Node
  that installed it. The name goes in `~/.t3/mcp-servers.json`, so `MCP_SERVERS_SCRUB` removes it.
  The official `t3` binary is a Node single executable and gives no `node` of its own. Claude
  hands its environment, `T3CODE_THREAD_ID` included, to the MCP servers it spawns. The helper
  sends that id, its working directory, the upstream branch there and the thread's model, read
  with `t3 thread show <id> --json`.
- **Files.** `requests/<id>.json` is written by the helper with a temp file and a rename. The
  host's poll claims each request by moving it to `claimed/`. A helper that gets no response
  within its wait (45 seconds, or 20 when `host-seen` is over 3 minutes old; every call stays
  under 60 seconds, which some MCP clients allow a tool) moves the request to
  `withdrawn/` instead. Each rename has one winner, so a withdrawn request never starts.
  `responses/<id>.json` is written by the host, also with a temp file and a rename. Its statuses
  are `queued`, `starting_sandbox`, `running` (with `taskId` and the sub-sandbox),
  `completed`/`failed`/`cancelled` (with `result`, or `code` for a refusal). The last one moves
  the request to `done/`.
- **Host poll.** `SubSandboxRequests` ticks every 5 seconds and runs `SUB_SANDBOX_POLL_SCRIPT`
  through `SandboxProvisioner.runScript` (`driver.execute`). It polls a running chat sandbox
  (`threadId` set, no `parentThreadId`, not resuming) every 15 seconds while the chat's thread
  here has an active run, a request is open, or one came in the last 5 minutes. Otherwise it polls
  every 60 seconds. A sandbox whose poll finds no helper is not polled again until its next
  running stretch. The bridge's bearer cannot be used instead: it has only `orchestration:*`
  scopes, and the official server's file RPCs need `filesystem:*`.
- **Handling.** A new request gets `queued` written first, and nothing starts until that write
  lands. The parent is the chat's thread here (`SandboxRecord.threadId`, the bridge's mirror),
  with its latest active run, since `RemoteDelegation` records tasks on a running turn. The
  sandbox's clone comes from `record.repository` at the request's upstream branch. Env files are
  copied only when the host project is a real checkout. The scope acts as that thread, on the
  run's provider instance (`sandboxes`). The child runs on the request's model, or the bridge's
  Claude fallback, with `mode: "wait"`, so a result is not delivered again to a turn that is
  still running.
- **Restarts.** In-flight state lives in memory and on the sandbox. A claimed request that already
  has a response is recovered from that response. With a `taskId` it is followed until the task
  has a result. Without one, the server stopped while starting its sandbox, so it is failed and
  never started again.
- **Install.** `setUpTools` writes the helper after T3 Code's skill and instructions on every launch except a
  subagent's sandbox. Every resume of a chat sandbox rewrites it before T3 starts
  (`SANDBOX_RESUME_STEP_SECONDS.subSandboxHelper`). A failure is a warning. The template scrub
  removes the folder (`SUB_SANDBOX_HELPER_SCRUB`) before T3's userdata goes.

## Lifecycle and hard limits

Every machine gets a row in `sandbox_instances` (see
[`SandboxRecords.ts`](../../apps/server/src/persistence/SandboxRecords.ts)) keyed by an instance id
the provisioner picks before create, since the environment id is only known once T3 answers on
the machine. Environments stay the source of truth for connection details; the record only adds
what the provider needs to act on the machine (provider, sandbox id, size, credential environment)
and the thread, config, and project it belongs to. A sandbox's environment is that thread's machine,
so the web app lists it under Settings → Environments only (`useSandboxEnvironmentIds`, from every
record, launching ones included). It is not offered where a project is added, in the settings
scope or project settings, in usage and its price overrides, in limit notices, or in provider
updates; a settings scope link that names it opens its host. Usage counts the sandbox's spend
under the host. Settings the user saves on the host through the settings scope, including "All
environments", repeat on the host's connected sandboxes (`useSandboxFollowers`,
`ScopeTargets.followers`), limited to the followed keys; the save neither waits for them nor
reports them, and neither does the shared-settings sync that writes every machine. A stopped
sandbox keeps what it had. A project override follows to the sandbox's clone of that project; an
override made before the sandbox existed is not copied at create.

`maxRunningMinutes` (480 by default, clamped to the provider's `maxTtlMinutes`) limits how long a
sandbox runs since its last start (`runningSince`); a resume starts the count again. The sweep runs
once a minute and calls the driver's `stop` on a sandbox past its limit; a failed stop is logged and
retried on the next sweep. `idleStopMinutes` is stored for a later idle stop and does nothing yet.
A stop sets `stoppedAt`, which the Sandboxes list shows as the disk's age against the provider's
`diskRetentionDays`. Nothing deletes a stopped sandbox automatically, and a config's `onSettle: delete`
deletes only after a clean work check.

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

Forks carry no tags (Boat gives a fork empty labels), so the sweep also lists the environment of
each record with `agentProviderAccess` and reports the sandboxes in it that no record tracks, with
`forkOf` naming the parent's instance id. The list shows them under that sandbox, and a listing
failure keeps the forks the last sweep found.

Templates are saved only from a sandbox with no thread: saving deletes the source machine.

### Settling and deleting a thread's sandbox

The thread lives on the sandbox's own server, which this host never hears from, so settle,
resume-on-send, and thread delete start in the client. `SandboxThreadCoordinator` (mounted once at
the root) registers handlers in `state/sandboxThreads.ts`. `useThreadActions.settleThread` calls
`notifySandboxThreadSettled`, which applies the config's `onSettle` (`ask` when unset). Settles the
sandbox's server makes on its own are not hooked, since this host is not told about them.
`unsettleThread` and the composer's send on a stopped sandbox with no host mirror call
`ensureSandboxThreadRunning`: resume, then wait for the environment to connect (4 minutes at
most), then send. A chat the host mirrors sends on the mirror instead (see above).

Thread delete runs `deleteSandboxThread`. After the user confirms, it deletes the thread while the
sandbox's server still answers, then deletes the sandbox and forgets its environment. Every delete
first runs `sandboxes.checkWork`: `git status --porcelain` and
`git rev-list --count HEAD --not --remotes` in the record's `repoDir`, run with a 10-second command
timeout inside a 15-second limit. A stopped sandbox, a record without `repoDir` (launched before
the field existed), or a timeout returns `unknown`, and the client then always asks. A remembered
`delete` skips the prompt only when the check comes back `clean`, and only after a 10-second wait
held in client memory: the coordinator's toast takes over the settle's Undo (`settleThread` then
skips its own notice), and an Undo, an un-settle from anywhere, or the sandbox stopping cancels
it. A reload during the wait deletes nothing.

A bridged chat keeps its conversation in the host thread. However its sandbox goes (a delete from
the header menu or the settle prompt, the sweep, or a new launch replacing an abandoned one), the
provisioner publishes the removed record (`SandboxProvisioner.removed`) and the bridge cancels the
host thread's queued messages and settles it, so the chat is kept under Settled on every client and
is no longer a mirror. The client lands on that host thread once
the sandbox's environment is gone. Deleting the chat itself deletes both of its threads and the
sandbox. Dialogs and toasts say "The chat is kept, under Settled" the same way.

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
