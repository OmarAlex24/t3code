# Sandbox environments

A sandbox gives a thread its own cloud machine, with its own T3 Code server and a fresh clone of
the project. Each thread you start on a sandbox gets a different machine, so threads never share
files, processes, or ports.

## Add a sandbox config

A config says how each thread's machine is made. Open **Settings → Environments → Add
environment**, choose **Sandbox**, pick Boat, Celesto, Daytona, Upstash, or Vercel, and enter the
provider's API key. Then choose a name, a machine size (or a template to start from), and what each
sandbox gets from this machine. **Add sandbox config** saves it; no machine is made and nothing
bills until a thread starts on it. Edit or delete configs in **Settings → Connections →
Sandboxes**. Deleting a config leaves the sandboxes already made from it running until you delete
them.

The key is saved on the T3 Code server that keeps the configs (this machine, or the first server
you paired on the hosted web app), not on the client. Each sandbox bills the provider account that
owns the key.

A sandbox gets none of this machine's logins unless the config asks. **Agent access** lists only
what this machine has set up, with a switch each; connect more under **Settings → Connections →
Sandboxes → Add integration**. **Claude** appears when Claude here talks to a custom endpoint, and
points Claude in each sandbox at the same one. If that endpoint is a [CLIProxyAPI hub you connected](./usage.md#connect-a-cliproxyapi-hub),
each sandbox gets its own key on the hub, which T3 Code removes when you delete the sandbox;
otherwise this machine's Claude token is copied, and it stays valid after the sandbox is gone. The
sandbox must be able to reach that endpoint. When it only answers on your tailnet or local network,
each sandbox [joins your tailnet](#private-endpoints-tailscale) on its own once Tailscale is set
up; without Tailscale, T3 Code refuses to start the sandbox and points you to its setup. You can
also expose the endpoint publicly instead (for example with Tailscale Funnel or Cloudflare Tunnel).
With a hub, **Pi** also installs the [Pi agent](./providers-pi.md)
in each sandbox with the hub's non-Claude models, on that same key, and **Start new chats on** can
make new chats on the config start on Pi with one of them instead of Claude.
**GitHub** lets `gh` and `git` in each sandbox clone private repositories and push, with a
token from the [GitHub App](#github-in-a-sandbox) or this machine's own. Without it a sandbox can
clone public repositories only.
[**Let the agent use Boat**](#let-the-agent-use-boat) signs the `boat` CLI in on each Boat sandbox
with a key scoped to it. T3 Code also
installs git, the GitHub CLI, and Claude Code when the provider's image lacks them; sign Codex in
from the sandbox's **Settings → Providers**.

Every sandbox's Claude also gets a skill from T3 Code, `t3-sandbox-files`, whether or not you copy
any skills of your own. A stop empties the sandbox's `/tmp`, so the skill tells the agent to keep
screenshots, drafts, logs, downloads and extra git worktrees under its home folder (for example
`~/scratch/<task>/`) instead. A launch writes it; a resume adds it when it is missing, so sandboxes
made before it get it too. A sandbox where it could not be written still works and shows a warning.
Codex agents on a sandbox do not get it.

**Projects** limits which repositories can start a thread on the config. It lists the github.com
repositories of projects on every connected machine, once each, so a project that lives only on a
paired machine counts too: the sandbox clones from GitHub, not from that machine. With none picked,
any project with a github.com remote can. Configs saved by older versions, which named projects on
this server, keep working and switch to repositories the next time you save them. Under
**Advanced**:

- **Running limit** (8 hours by default) stops a sandbox that has run that long since its last
  start. Its disk stays, so **Resume** brings it back with the thread's files. Boat sandboxes show
  **Stop when idle** and an optional **Hard limit** instead (see
  [Boat sandboxes stay on while they work](#boat-sandboxes-stay-on-while-they-work)).
- **Files copied from this machine** chooses, per repository, which git-ignored files go into the
  clone. They come from the repository's copy on the server that keeps the configs, so a project
  open only on another machine gets none. By default each sandbox gets that copy's env files
  (`.env` files, `.envrc`, `.dev.vars`). They are written into the clone with owner-only
  permissions and never appear in a provider's command history.
- **Reach it only through my tailnet** shows only on a config that already has it, so you can turn
  it off. Such a sandbox has no public URL: this app connects over your tailnet, so the machine
  running it has to be on your tailnet too, and the hosted web app cannot reach it.

## Start a thread on a sandbox

In a new thread, open the **Run on** picker under the composer. Below your machines, the
**Sandbox** group lists the configs this project can start on, with the provider's logo; choose one.
Any project with a github.com remote qualifies, on whichever connected machine it lives. With no
config yet, the group offers **New sandbox config…**, which opens the same form as Settings. Write
your message and send it: the message waits in the composer while a card shows the sandbox being
made.

1. **Check limits and access** reads the provider's limits, so a start it would refuse costs
   nothing.
2. **Create machine** creates and exposes it.
3. **Install T3 Code and tools**: git, the GitHub CLI, and Claude Code where missing.
4. **Set up credentials**: Claude, GitHub, and Tailscale, as the config asks.
5. **Start T3 Code**.
6. **Clone repository** from GitHub into `~/work/<repo>` and add it as a project there.
7. **Copy env files**.
8. **Connect and start thread** pairs this app with the sandbox and starts the thread on this
   computer, under the **Sandboxes** provider, so your phone can follow it (see
   [Drive a sandbox thread from your phone](#drive-a-sandbox-thread-from-your-phone)). The message
   waits until this computer shows that provider in the project, usually a few seconds. If this
   computer cannot take the thread, the thread starts on the sandbox itself, as it did before, and
   a notice says your phone cannot drive it.

Once connected, the thread starts with your message. A failure in steps 1 to 5
deletes the machine, and **Start a new sandbox** tries again from scratch. A failed clone or
connection keeps the machine, so **Retry** runs just that step again, and **Discard sandbox**
deletes it. A setup step that fails, such as a GitHub sign-in, or an env file that could not be
copied, shows as a warning and leaves a working sandbox. **Cancel** stops the launch at any point and
deletes everything it made: the machine, its hub key, and its tailnet device.

The thread's sandbox appears under its config in **Settings → Connections → Sandboxes**, not in the
list of environments you paired.

## Manage sandboxes

**Settings → Connections → Sandboxes** groups sandboxes under the config they came from. Each row
shows the thread (with **Open thread**), the project, the machine size, its state, how long it has
been running against its running limit, and Boat's monthly cost. Stop, resume, and delete
sandboxes there; deleting removes the machine and its disk at the provider and forgets the sandbox's
connection in this app. Work you have not pushed is lost with it.

That list follows the provider: a sandbox you stop or delete in the provider's dashboard shows up as
stopped or deleted within a minute. A stopped sandbox shows how long its disk has been kept. Boat
keeps a stopped sandbox's disk for 14 days and then shows it as expired; three days before that the
row recommends deleting it. T3 Code never deletes a sandbox you did not ask it to, except one whose
launch was cut short when this server stopped, which it deletes once it is running again. A row
also says when the thread it belonged to was deleted.

## Drive a sandbox thread from your phone

A sandbox thread also appears on this computer under the **Sandboxes** provider, in the project it
came from (or a small project named after the repository when the repository is not on this
computer). The T3 Code app reaches it there through this computer, without pairing with the sandbox.
Sending a message forwards it to the sandbox, its answer streams back, and the sandbox's approvals
and questions appear as usual. Threads launched this way start there, Supervised.

A sandbox chat starts only from T3 Code on this computer (**Run on → Sandbox**), where the sandbox
configs live; a new thread started from the phone gets a reply saying so. Once it has started, you
can keep the conversation going from the phone.

The small project is an empty folder, not the repository, so it offers no git actions, scripts,
files, or terminal. The repository's files, diffs, terminals and previews are on the sandbox. This
computer connects to a running sandbox on its own when you open its chat; otherwise **Connect to
the sandbox** (in the side panel, the thread details, or the sandbox menu in the thread's header)
connects it, resuming a stopped sandbox first, and the chat then shows the sandbox's own thread. If
a connection fails, the reason shows under that button. The phone does
not connect to sandboxes, so there these are available only from a computer. **Settings →
Connections → Sandboxes** has **Connect** and **Disconnect** for each chat's sandbox; after
**Disconnect**, this device stays disconnected until you connect again, and the chat stays here.

- Keep the thread **Supervised**. In another mode the sandbox's approvals cannot reach you: the
  request waits on the sandbox and the thread says so.
- While the sandbox is stopped or starting, this computer shows the chat as its thread under
  **Sandboxes**. A message sent then waits there, marked "Starting sandbox", resumes the sandbox,
  and goes out once it is up, even if you switch chats or close the app. Messages after it queue
  behind it. Once the sandbox is running and connected, the chat shows the sandbox's own thread
  again.
- Attachments and images are not forwarded yet.
- The thread under **Sandboxes** shows what was sent through it, and the replies the sandbox's
  agent gives on its own, such as when a background task or subagent finishes; messages sent to
  the sandbox directly appear on the sandbox's own thread.
- The **Sandboxes** provider shows only in projects that hold a sandbox thread.

## Settle or delete a sandbox chat

A thread that runs through the **Sandboxes** provider keeps its conversation on this computer, so
deleting its sandbox keeps the conversation. What goes is the sandbox's disk: work not committed
and pushed from it is lost, and the thread needs a new sandbox to continue. A sandbox thread started
before this, or one that could not start on this computer, is stored only on its sandbox, so
deleting the sandbox deletes the conversation too. Every prompt that can delete a sandbox says
which case it is.

**When a chat is settled**, in the sandbox config, says what settling a thread does to its sandbox.
It applies however the chat is settled: from the computer, the phone, an agent, a scheduled task,
or automatic settling.

- **Ask me** (the default) asks: **Keep snapshot** or **Delete sandbox…**. The question waits on
  the sandbox under **Settings → Sandboxes** (**Keep** or **Delete…**) and on the chat's row
  ("Keep sandbox?"), and pops up on a computer that has the app open. Tick **Remember for** the
  config's name to make that choice the config's setting. Keep, from any device, stops a running
  sandbox and keeps its disk. Un-settling the chat drops the question.
- **Keep a snapshot** stops the sandbox and keeps its disk. The provider bills for the stopped disk
  (Boat keeps it for 14 days). Sending a message in the thread resumes the sandbox, from any
  device; the first answer can take a few minutes. Un-settling the thread resumes it too.
- **Delete without asking** waits 10 seconds after the settle; **Undo**, or un-settling the
  thread another way, keeps the sandbox. Then it checks the clone for uncommitted files and commits
  not on a remote. With nothing to lose, it deletes the sandbox. While the chat's agents or tasks
  still run, with work to lose, when the sandbox does not answer within about 10 seconds, or when
  it is stopped, it asks as **Ask me** does. Copied env files count as uncommitted when the repository does not ignore them.

A thread the sandbox settles on its own, and a thread stored only on its sandbox, leave the
sandbox as it is. Deleting a sandbox thread asks first, names the sandbox ("Also deletes sandbox bx_46wr on
Boat"), and shows the same check. Deleting a thread that runs through the **Sandboxes** provider
also deletes the sandbox's copy of it. A stopped sandbox is not started just to check, so its
prompt says the check could not run.

The thread's header shows its sandbox: its state, **Stop and keep its disk** or **Resume**,
**Open sandbox thread** (for a thread under the **Sandboxes** provider), **Open in Sandboxes
list**, and **Delete sandbox…**. A warning icon there means the provider will
soon drop the stopped disk.

**Not tracked by T3 Code** lists sandboxes that carry this server's tag but have no record, for
example after a crash. They may still bill; delete the ones you do not need. Only Boat reports
these. Forks an agent made of its sandbox show under that sandbox instead (see
[Let the agent use Boat](#let-the-agent-use-boat)).

Each provider also stops sandboxes on its own, as a backstop for the running limit. Boat is the
exception: its own auto-stop is what stops a thread's sandbox once its work ends, as the next
section explains.

For Vercel, create an access token at vercel.com/account/settings/tokens; T3 Code uses your only
team and a `t3-sandboxes` project unless you fill in **Team** or **Project** (a change applies to
new sandboxes; existing ones stay where they were created), and a sandbox on the
Hobby plan stops after 45 minutes, so resume it from the Sandboxes list to keep working.

Upstash is new. Create a Box API key in the Upstash Console at console.upstash.com. Upstash pauses
a box after an hour idle (six hours on paid plans) and may not count a running agent as activity,
so a long turn can stop partway and the sandbox then shows as stopped. Opening the sandbox's URL or
choosing **Resume** wakes it, and T3 Code starts again on it. Medium and Large boxes need a paid
plan. Upstash sandboxes cannot be saved as templates and show no cost.

Celesto is new. Create an API key in the Celesto console under **Settings → Security**; a scoped
key needs all three computer permissions (see, create and run, delete). Celesto never stops a
sandbox on its own, so the running limit is the only thing that stops one, and a sandbox keeps
billing while this T3 Code server is off. The free trial runs Micro only and keeps one sandbox,
stopped ones included, so delete it before you start another thread on it. Celesto keeps a stopped
sandbox's disk for 30 days. Celesto can also move a running sandbox to another machine on its own,
and does not promise to keep the sandbox's files when it does, so push work you want to keep. If a
sandbox stops answering after such a move, delete it. Celesto sandboxes cannot be saved as templates
and show no cost.

Daytona deletes a sandbox, files included, a day after its running limit, so copy out anything you
need before then.

## Boat sandboxes stay on while they work

A thread's Boat sandbox has no running limit while its agents work. It stops on its own once they
have been idle for the config's **Stop when idle** time (30 minutes by default).

- Every 5 minutes the sandbox checks whether any thread on it, subagents included, is queued,
  starting or running, is waiting on background work it will pick up again (a subagent, or a
  command or monitor it waits on), or has had any activity since the last check, such as a short
  turn or your answer to a question. If so, it moves Boat's auto-stop to the idle time plus 5
  minutes from now. A thread left waiting on you, for an approval or an answer, counts as idle.
- Background commands no agent waits on, such as a dev server, keep the sandbox on too, but only
  for 8 hours after the sandbox last started.
  The check log in `~/.t3/userdata/sandbox-keepalive/log` shows each decision and how many threads
  had background work.
- The sandbox does this itself, so it keeps working while this machine sleeps or the app is
  closed. With no work, nothing moves the auto-stop, and Boat stops the sandbox when it passes.
  Its disk stays, and sending a message resumes it.
- **Hard limit** (off by default) still stops a sandbox that has run that long since its last start,
  even mid-work.
- For this, T3 Code mints a Boat key named `t3-keepalive-<name>-<random>`, scoped to that one
  sandbox with only `sandbox.read` and `sandbox.update`. It travels in a private file, never in a
  command, and only the sandbox keeps it, under `~/.t3/userdata/sandbox-keepalive/`. It lasts 30
  days, is replaced on a resume once it has less than a week left, and is revoked when you delete
  the sandbox.
- A Boat sandbox made before this gets its key the next time it resumes. If the key cannot be set
  up, the setup card or the resume says so, and that sandbox stops at its running limit as before.
- On a Boat trial the idle time is capped at two hours, Boat's longest trial auto-stop.

## GitHub in a sandbox

With **Sign in with → GitHub App (recommended)**, each sandbox gets an hour-long token from the
app, which T3 Code renews while the sandbox runs and revokes when you delete it.

- The token covers **every repository the app is installed on**, not just the sandbox's own, so an
  agent can clone, push, and open pull requests on another of your repositories in the same
  thread. It is the app's installation that decides this, so the app must still be installed on the
  sandbox's own repository, or the launch warns with a link to install it.
- Choose those repositories on GitHub: **Settings → Applications → Installed GitHub Apps →
  Configure** next to the app (for an organization, the organization's **Settings → GitHub
  Apps**), under **Repository access**. **Install on repositories** in the app's menu under
  **Settings → Connections → Sandboxes** opens the same page. A running sandbox picks up a
  change with its next token, at most about 40 minutes later; a resumed sandbox gets a new token
  as it starts. Because every sandbox reaches every repository on that list, keep it to the
  repositories you want agents to push to.
- The app asks to write contents, pull requests, issues and workflows, and to read checks,
  statuses and actions. Without Workflows, GitHub refuses a push that changes
  `.github/workflows/`; without Issues, an agent cannot open or comment on issues. An app created
  before T3 Code asked for one of these lacks it: open the app's settings on GitHub
  (**Settings → Developer settings → GitHub Apps → Edit**), set **Permissions → Repository
  permissions → Workflows** and **Issues** to **Read and write**, and save. GitHub then asks each
  installation to approve the change; until you accept it under **Installed GitHub Apps →
  Configure**, tokens keep the old permissions.

## Let the agent use Boat

Off by default, and offered only for Boat. With it on, the agent in each sandbox can run `boat`
against its own machine: fork it, host its ports, stop it, and delete the forks it made. Forks bill
like new sandboxes, and they count against Boat's start limits.

- At launch T3 Code makes a Boat environment for that sandbox alone, named
  `t3-sandbox-<name>-<random>`, with **Safe for third parties** on and no GitHub token, secrets,
  sandbox credentials or agent logins passed. The sandbox starts in it, and so do its forks. That is
  also why the option needs **No credentials** as the Boat environment under **Advanced**.
- Once the sandbox exists, T3 Code mints a scoped key with the same name, limited to that sandbox
  and its environment, and signs `boat` in with it. The key travels in a private file, never in a
  command, and only the sandbox keeps it, in `boat`'s own config. Its actions are
  `sandbox.create` (forking makes a sandbox), `sandbox.read`, `sandbox.stop`, `sandbox.fork`,
  `sandbox.delete-own`, `exec`, `file.read`, `file.write` and `host`. It cannot read or delete any
  other sandbox on your account, or the sandbox it runs on.
- The key expires after the config's running limit (8 hours by default), counted from launch, even
  if the sandbox was stopped in between or kept itself running past it. After that `boat` on that sandbox stops working; start a new thread for a new
  key.
- Before anything bills, T3 Code checks that your Boat key can mint scoped keys. A key that cannot
  stops the launch with "Your Boat key can't create scoped keys; use an admin key or turn off Let
  the agent use Boat".
- Forks appear under their sandbox in the Sandboxes list, each with its own delete. Deleting the
  sandbox revokes its key, deletes its forks, and then deletes its environment. T3 Code never
  deletes a fork on its own: a launch cut short by a restart loses its key and machine, but any
  fork stays, with its environment, for you to delete in Boat.

## Sandboxes for subagents

An agent on this machine can give a subagent its own sandbox when the task needs more CPU, RAM or
disk than its machine has, or runs heavy builds in parallel: `delegate_task` with
`target.sandbox`. The child then runs there as a task in a linked environment, so **Linked
environments** has to be on under **Settings → Labs**; the agent says so when it is off.

- The sandbox comes from the parent thread's own sandbox config when the parent is a sandbox chat.
  Otherwise it comes from the config this project's sandbox chats last used, or the only config
  there is. It clones the project at the parent's branch once that branch is pushed (the default
  branch otherwise), with the same env files, tools and keep-alive as a thread's sandbox.
- `target.sandbox.size` can be the config's size or one size larger. A config that starts from a
  template keeps the template's size.
- Each config limits how many run at once: **Subagent sandboxes per thread** (2 by default) and
  **in total** across every thread (4 by default), under **Machine**. Sandboxes still starting
  count. 0 turns them off. Past a limit the agent gets a `concurrency_full` error.
- When the task ends or is cancelled, T3 Code checks the sandbox for uncommitted files and
  unpushed commits. A clean one is deleted. One with work, or one it could not check, is stopped
  and kept, and the task's result says which sandbox and folder hold the work.
- In the Sandboxes list they sit under the thread that delegated their tasks.

Agents on a sandbox can ask too. The sandbox runs the official T3 Code, whose `delegate_task` has no
`target.sandbox`, so T3 Code installs a small helper there that gives Claude two tools:
`sandbox_delegate` asks for a sandbox and `sandbox_task_status` reports on it. The request goes to
this machine, which starts the sandbox the same way: from the same config, within the same limits
and sizes, and ended the same way when the task is done. The task shows under the sandbox's chat
on this machine.

- **This machine must be awake** and running T3 Code, since it holds the configs and provider
  keys. It checks each running sandbox for requests every 15 seconds while that sandbox's chat
  works, and every minute otherwise. When nothing picks a request up within about 45 seconds, the
  helper withdraws it and tells the agent to do the work on its own sandbox.
- The request is recorded on the chat's running turn on this machine, so it works when the
  conversation goes through T3 Code here or on your phone. Each request has an id, and asking
  again with the same id never starts a second sandbox. A result is passed back to the agent when
  it asks for the status, and a result that arrives after its turn has ended starts a new turn,
  as a subagent's result does here.
- Refusals reach the agent with the reason: a limit reached (`concurrency_full`), **Linked
  environments** off, no config to start from, or a size too large. A config whose limits are 0
  still gets the helper, and every request from it is refused with that reason.
- Sandboxes get the helper when they start, and older sandboxes get it when they resume. A
  subagent's own sandbox does not get it. The helper is for Claude; other agents on a sandbox do
  not see it. Saving a template removes it, with any pending requests.

## Templates

A template starts each sandbox with your tools and dependencies already installed. Save one from a
sandbox that belongs to no thread, with **Save as template…** in the Sandboxes list; a thread's
sandbox cannot be saved, because saving deletes the source machine. Then choose the template under
**Start from** in a config. Saving resets T3 Code on the source so each copy connects as a new
environment. Its files live on in the template, `.env` files included, so leave out secrets you do
not want in every copy; T3 Code removes only its own identity and the Claude, GitHub, and Tailscale
logins it set up.

## Private endpoints (Tailscale)

A sandbox can join your tailnet to reach an endpoint that is only on it, such as a CLIProxyAPI
server, without exposing that endpoint publicly. Each sandbox joins as its own ephemeral device,
tagged `tag:t3-sandbox`, with a single-use key; deleting the sandbox removes the device. A sandbox
that stays stopped for more than about an hour drops off the tailnet and rejoins as a new device
when you resume it.

**Settings → Connections → Sandboxes → Add integration → Tailscale** walks through the same three steps,
with the policy snippet filled in for this server's Claude endpoint.

1. Add the tag and an access rule. Open the
   [policy file](https://login.tailscale.com/admin/acls/file) and merge in:

   ```jsonc
   "tagOwners": {
     "tag:t3-sandbox": ["autogroup:admin"],
   },
   "grants": [
     // Sandboxes reach the Claude endpoint and nothing else.
     { "src": ["tag:t3-sandbox"], "dst": ["100.x.y.z"], "ip": ["tcp:443"] },
     // Replace the default allow-all grant ("src": ["*"]) with this one:
     // { "src": ["autogroup:member"], "dst": ["*"], "ip": ["*"] },
   ],
   ```

   Use your endpoint's tailnet IP for `100.x.y.z`, and its port if it is not 443. Tailscale's
   default grant lets every device reach every other, sandboxes included, so narrow it to the
   commented one.

2. Create the OAuth client. Open
   [Trust credentials](https://login.tailscale.com/admin/settings/trust-credentials), then:
   1. Select **Credential**, then **OAuth**.
   2. Under **Scopes**, choose **Custom scopes**.
   3. Expand **Devices** and set **Core** to **Write**.
   4. Expand **Keys** and set **Auth Keys** to **Write**.
   5. Pick `tag:t3-sandbox` as the tag for both.
   6. Select **Generate credential** and copy the secret. Tailscale shows it only once.
3. Paste the secret (`tskey-client-…`) into the Tailscale card and save. T3 Code reads the client
   ID from it and signs in once, asking for the tag, before saving. When something is missing it
   says what, for example `Missing Keys → Auth Keys: Write for tag:t3-sandbox`, or that Tailscale
   won't give the client the tag, which means the tag is not in `tagOwners` yet (step 1) or was not
   selected on the client. If your secret has another form, enter the client ID under
   **Advanced**, where you can also change the tag. The secret stays on this server; sandboxes
   never get it.

A sandbox joins your tailnet on its own whenever Claude's endpoint resolves to a private or tailnet
address. That is decided each time a sandbox starts, so configs saved before Tailscale was set up
work too. For other endpoints, check **Join my tailnet** in the config to join anyway. If the
sandbox still cannot reach Claude after it starts, T3 Code stops the setup and deletes the sandbox
rather than starting a thread that would wait forever.

Most sandboxes get a full Tailscale connection. One that cannot create a network device runs
Tailscale in userspace instead: T3 Code then points Claude at Tailscale's local proxy, and other
programs in the sandbox reach the tailnet only through `http://localhost:1055`. Tailscale needs root
or passwordless sudo on the sandbox, which Boat, Upstash, and Vercel provide.
