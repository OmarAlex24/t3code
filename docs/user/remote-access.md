# Remote access

Connect a phone, browser, or another desktop app to T3 Code running on a different
machine. That machine must stay running and reachable while you work.

## Sandbox environments

A sandbox gives a thread its own cloud machine, with its own T3 Code server and a fresh clone of
the project. Each thread you start on a sandbox gets a different machine, so threads never share
files, processes, or ports.

### Add a sandbox config

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

### Start a thread on a sandbox

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

### Manage sandboxes

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

### Drive a sandbox thread from your phone

A sandbox thread also appears on this computer under the **Sandboxes** provider, in the project it
came from (or a small project named after the repository when the repository is not on this
computer). The T3 Code app reaches it there through this computer, without pairing with the sandbox.
Sending a message forwards it to the sandbox, its answer streams back, and the sandbox's approvals
and questions appear as usual. Threads launched this way start there, Supervised.

A sandbox chat starts only from T3 Code on this computer (**Run on → Sandbox**), where the sandbox
configs live; a new thread started from the phone gets a reply saying so. Once it has started, you
can keep the conversation going from the phone.

The small project is an empty folder, not the repository, so it offers no git actions, scripts,
files, or terminal; a notice above the composer says so. The repository's files, diffs, and
terminals are on the sandbox: **Open sandbox thread**, in that notice or in the sandbox menu in the
thread's header, opens the same thread on the sandbox.

- Keep the thread **Supervised**. In another mode the sandbox's approvals cannot reach you: the
  request waits on the sandbox and the thread says so.
- While the sandbox is stopped or starting, this computer shows the chat as its thread under
  **Sandboxes**. A message sent then waits there, marked "Starting sandbox", resumes the sandbox,
  and goes out once it is up, even if you switch chats or close the app. Messages after it queue
  behind it. Once the sandbox is running and connected, the chat shows the sandbox's own thread
  again.
- Attachments and images are not forwarded yet.
- The thread under **Sandboxes** shows only what was sent through it; messages sent to the sandbox
  directly appear on the sandbox's own thread.
- The **Sandboxes** provider shows only in projects that hold a sandbox thread.

### Settle or delete a sandbox chat

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

### Boat sandboxes stay on while they work

A thread's Boat sandbox has no running limit while its agents work. It stops on its own once they
have been idle for the config's **Stop when idle** time (30 minutes by default).

- Every 5 minutes the sandbox checks whether any thread on it, subagents included, is queued,
  starting or running. If one is, it moves Boat's auto-stop to the idle time plus 5 minutes from
  now. A thread waiting on you, for an approval or an answer, counts as idle.
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

### GitHub in a sandbox

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

### Let the agent use Boat

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

### Sandboxes for subagents

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

### Templates

A template starts each sandbox with your tools and dependencies already installed. Save one from a
sandbox that belongs to no thread, with **Save as template…** in the Sandboxes list; a thread's
sandbox cannot be saved, because saving deletes the source machine. Then choose the template under
**Start from** in a config. Saving resets T3 Code on the source so each copy connects as a new
environment. Its files live on in the template, `.env` files included, so leave out secrets you do
not want in every copy; T3 Code removes only its own identity and the Claude, GitHub, and Tailscale
logins it set up.

### Private endpoints (Tailscale)

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

## T3 Connect

T3 Connect makes an environment available to your other devices without setting
up router forwarding. In the desktop app on the host, open **Settings →
Sharing & access**, sign in, and enable **T3 Connect** for that environment.

For a command-line host, run:

```bash
t3 up
```

It asks how your other devices reach the machine: T3 Connect, the local network,
or both. Choose T3 Connect and follow the sign-in instructions. It then runs
T3 Code as a [background service](./background-service.md).
`t3 connect` is the same as `t3 up --connect`. Run `t3 up` again to change your
choice, and `t3 status` to see it.

Instead of the background service, you can keep the desktop app running with
its local environment enabled. Closing the desktop app's last window stops its
local server. Saving your sign-in alone does not start a server or make the
machine reachable.

On your other device, sign in to the same T3 Connect account and choose the
environment. On the app.t3.codes home page with no computer added yet, signing
in adds compatible computers linked to your account. Over SSH, the CLI prints a
browser link and a short code. Open the link on any device, confirm the code
matches, and approve. The CLI continues on its own, so you do not need to forward
an OAuth callback port.

T3 Connect renews access credentials when needed without disconnecting a healthy
connection. Pull request diffs and provider settings keep working after the
previous credential expires. A failed renewal affects that request; it does not
disconnect an otherwise healthy conversation.

### Scripts and agents

`t3 up` asks nothing when you name a choice: `--connect`, `--lan`, or their
`--no-` forms. Choices you do not name keep their settings, and `--yes` takes
the defaults. Without a terminal:

- T3 Connect sign-in prints a URL and a code. Approve it on any device.
- A needed restart runs without asking, and stops running agent turns.
- With nothing set up and no choice named, `t3 up` stops and names the flags.

`t3 status --json` prints the settings. `t3 up --help` lists every flag with
examples.

### More machines with T3 Chat

Each T3 Connect account can link up to 3 machines. Phones and browsers do not
count. A paid T3 Chat plan raises the limit to 10 machines with Pro, or 100 with
Premier.

To link T3 Chat, open your account menu on the web or desktop app, go to
**T3 Chat**, and select **Link T3 Chat**. Sign in to T3 Chat in the window that
opens and approve. The new limit applies the next time you add a machine. If you
cancel or downgrade T3 Chat, machines you already linked stay linked, but you
cannot add more until you are under the limit again.

## Pair over a LAN or private network

Use direct pairing when the other device can reach the host's network address.

On a desktop host, open **Settings → Sharing & access**, enable **Network access**,
then create a pairing link using an address the other device can reach. Changing
network access restarts the desktop app. You can turn it off in the same place.

For a command-line host, choose the local network in `t3 up`, or run:

```bash
t3 up --lan
```

For a server in a terminal, run `t3 serve --lan`. Either way, T3 Code then
accepts connections from your local network and tailnet, so a pairing code is
all that keeps other devices on them out.

If a server is already running, generate a fresh link without restarting it:

```bash
t3 pair
```

Scan the QR code on your phone or paste the pairing URL into **Add environment**
in the receiving app. Connection settings are under **Settings → Environments**
on web and desktop and **Settings → Environments** on mobile. A loopback address
such as `127.0.0.1` reaches only the device opening the link.

On a computer with the desktop app, you can open the printed `t3code://pair`
app link instead. The desktop app asks you to confirm the server address, then
adds it.

If your HTTPS endpoint uses a certificate from your own certificate authority,
install that CA on Android as a **CA certificate** in its security settings; the
Android app then trusts it.

Pairing authorizes that device for future connections. Use a fresh one-time link
for each new device; you do not need the original token to reconnect. Links
created in Settings can only be copied from the client that created them while
its Sharing & access page stays open. If you leave or reload that page, create
another link to share.

### Reach one machine several ways

A machine can have more than one route: LAN, Tailscale, another VPN, a public
URL, SSH, or T3 Connect. Tailscale shares its `100.64.0.0/10` address range with
other VPNs such as Cloudflare WARP, so an address in that range shows as VPN
unless the machine confirms it is on Tailscale. To add a route, choose **Add
route** in the machine's route list, or next to it in the T3 Connect list.
A pairing link for a saved machine is refused when it comes from an address
that machine does not have yet; add that address with **Add route** instead.
Pairing again over an address the machine already has still works. A new route
is placed by speed, in that order, and you can reorder routes at any time.

While connected through T3 Connect or a paired address, T3 Code also learns the
machine's current LAN and Tailscale addresses and adds them as routes, so
pairing once through T3 Connect is enough to use the LAN at home. When the
machine's LAN address changes, for example after it joins another Wi-Fi network,
the learned route follows it. The machine must allow network access for its LAN
address to be learned: **Network access** in the desktop app, or the
[local network](./background-service.md#local-network-access) choice in `t3 up`.
You can reorder a learned route, but not remove it; it
goes away with the route it was learned through, or when the machine stops
reporting that address.

T3 Code connects over the first route that answers. Away from home, a LAN
address that does not answer is checked briefly and skipped. It is only tried
again, after the other routes, if none of them connect. While connected over a
later route, T3 Code checks the earlier ones when your network changes, when you
return to the app, and every minute, and moves back as soon as one works.

On web and desktop, select the route count under the machine's name in
**Settings → Environments** to see its routes. Drag a route to change the order,
or remove it. On mobile, open the machine under **Settings → Environments** and
choose **Edit**. Signing out of T3 Connect removes only that route; a machine
you can still reach another way stays saved.

Open **Permissions** next to **Routes** in web or desktop, or **Your permissions**
in the mobile route details, to see what your current connection can do on that
environment. For a remote environment, this is in its route details. Permissions
shown there apply only to the route marked **In use**; other routes are not
checked. Direct pairing and T3 Connect have separate sessions and may grant
different permissions.

### Balance new threads across machines

Auto balance is off by default. On web and desktop, enable it in
**Settings → Environments → Load balancing** to automatically choose a machine for
new threads in projects grouped across connected environments. The section
appears once two or more machines are switched on.
Each machine starts at **Normal**. Choose **Prefer** to favor it when it has CPU and
memory available, **Less often** to reduce its share, or **Manual only** to exclude
it from automatic selection. These are preferences, not fixed traffic percentages.
Preferences are saved separately in each client.

The composer checks eligible machines when choosing a draft's environment, then keeps
that choice stable. Choose **Auto balance** again to check current resources, or choose
a specific machine to override it. Choosing a branch or worktree also keeps the draft
on that machine. Existing threads stay where they started. If resource checks are
unavailable or all eligible machines are full, choose a machine manually to continue.
Mobile keeps its manual environment selection.

### Tailscale HTTPS

Join both devices to the same tailnet. In the desktop app, enable **Tailscale
HTTPS** in **Settings → Sharing & access**. Turn it off there to remove that route.

To start a command-line server with Tailscale HTTPS:

```bash
t3 serve --tailscale-serve
```

For an already-running server:

```bash
t3 pair --tailscale
```

The pairing link uses an address such as `https://machine.tailnet.ts.net/`.
The mapping created by `pair --tailscale` persists across restarts. Remove its
default-port mapping with:

```bash
tailscale serve --https=443 --set-path=/ off
```

If that port is already in use, choose another with
`--tailscale-serve-port`. See `t3 pair --help` for other pairing options.

### Hosted web app

[app.t3.codes](https://app.t3.codes) needs an HTTPS endpoint. It connects directly
to your server; a hosted pairing link does not make an unreachable backend
reachable or convert HTTP to HTTPS.

For a plain HTTP LAN endpoint, use the direct pairing URL in a browser that can
open it, or pair from the desktop app. On mobile, an IP address entered without a
scheme uses HTTP, so include `https://` when your server uses HTTPS.

## Desktop-managed SSH

In the desktop app, open **Settings → Environments → Add environment**, choose
**SSH**, and enter a host or SSH alias such as `user@example.com`. T3 Code starts
or reuses a server there and opens the port forward for you. Projects, provider
credentials, and agent work stay on the remote machine.

The remote host must be Linux or an Apple Silicon Mac with `curl` or `wget`,
`tar`, `sha256sum` or `shasum`, and [provider setup](./install.md#providers).
The first launch downloads T3 Code's server to `~/.t3/runtime` on the host, so
it takes longer than later ones.
Provider CLIs must be on the `PATH` of a non-interactive login shell there;
check with:

```bash
ssh user@example.com 'sh -lc "command -v claude codex"'
```

If SSH reconnecting fails after an app update, retry the launch once. Removing
the connection stops a server that T3 Code launched; a server that was already
running is left alone.

Each desktop app keeps one session on the host for its SSH connection and reuses
it when it reconnects. Revoke sessions you no longer use in **Settings →
Sharing & access** on the host, or on a headless host with `t3 auth session list` and
`t3 auth session revoke <id>`. A desktop that can still sign in over SSH pairs
again on its next connect.

For Antigravity's Google callback on a remote host, see
[remote sign-in](./providers-antigravity.md#sign-in-from-a-remote-device).

## Browser on a remote environment

Browser tabs belong to the environment, so you and your agents see the same
tabs from any device. The desktop app shows its own environment's tabs
directly. Every other device, and the desktop app for other environments,
streams them from the host. Agents keep using them while no device is
connected, and `localhost` addresses reach servers on the host.

The first tab downloads a headless Chrome, about 120 MB, into the T3 home. It
is the same browser [HTML renders](html-renders.md) use, so a host downloads it
only once. Some Linux hosts need [setup](#browser-host-setup) before it can
start.

Agent tabs have separate storage and share a Chromium process. Take control before
typing into an agent's tab, then release control when you want the agent to
continue. Read-only connections can watch without changing the page.

While you have control, the tab works with your device: text the page copies or
cuts goes to your clipboard, a file picker on the page opens your device's
picker, and a finished download is offered for you to save. Popups such as
sign-in windows open as their own tabs. Downloads stay on the host until the
tab closes. Audio does not play on your device.

On a phone, tap the floating preview's corner dot to show its controls, then
**Pop into separate window** to keep watching in picture-in-picture over other
apps.

### Local servers

The browser lists ports held by processes your terminals and agents started.
T3 Code reads which process holds each port and never connects to it, so a
listed port opens as `http://localhost:<port>` and might not be a web page. For
an HTTPS server or a specific path, set the **Preview URL** on the project
script that starts it; T3 Code checks that address and opens it as written.

To stop listing ports, set `T3CODE_PORT_DISCOVERY=0` in the environment that
starts the T3 Code server, such as
[`service.env`](./background-service.md#configure-the-service-environment) for
the background service, and restart it. Script preview URLs still appear.

### Browser host setup

macOS, Windows, and Linux desktops run the browser as is. Some Linux hosts need
one-time setup: Ubuntu 23.10 and later block the sandbox the browser runs in,
and minimal images and containers lack libraries it loads. When that happens,
the server says so at startup, and browser tabs and HTML previews show the
command to run on the host:

```sh
sudo t3 browser setup
```

The server shows the exact line for how you started it, and keeps your `PATH`
when you started it with `npx` and Node is installed only for your user. Where `t3` is not on your `PATH`, such as with only the
desktop app installed, it names the full path of the app's own `t3` instead. It allows Chrome's sandbox with an AppArmor profile and installs
any missing libraries and system fonts with apt; pages that load without text
can mean the host has no fonts. It is safe to run again. Without `sudo`, it only
reports what it would change.

The browser runs in Chrome's sandbox by default. Chrome cannot start that sandbox
as root. If your T3 server runs as root, run it as a nonroot user to keep
sandboxing enabled. `t3 browser setup` does not fix this root restriction.

If you need to run as root, or cannot enable the sandbox on your host, set
`T3CODE_SERVER_BROWSER_SANDBOX=0` in the **T3 server's environment** and restart
the server. This disables Chrome's sandbox. For a manual launch:

```sh
T3CODE_SERVER_BROWSER_SANDBOX=0 t3 serve
```

For a systemd service, add `Environment=T3CODE_SERVER_BROWSER_SANDBOX=0` under
`[Service]` in its configuration, run `sudo systemctl daemon-reload`, then restart
your T3 service. Setting the variable in an agent's terminal does not change the
environment of an already running T3 server.

## Connect an outside agent

Claude Code, Codex, ChatGPT and other agents T3 Code did not start can drive
threads on an environment through its MCP server. See
[outside agents](./outside-agents.md) for setup.

## Link another environment

Link two machines, such as your laptop and a VPS, and agents on one can work on
the other: launch, message, wait on and stop its threads, answer their
questions, and manage its queues, projects and scheduled tasks.

Linked environments is a beta. Turn it on for both machines in **Settings →
Labs**; on mobile, **Settings → Labs** lists each connected machine. While it is
off on either machine, agents start nothing over a link between them. A task
already running on the other machine still finishes, and if that machine has it
off, its result arrives once it is back on.

On the machine you will work from, open **Settings → Environments → Linked environments**,
choose **Link**, and pick the other machine or enter its address. The list
holds the machines this app knows and those on your T3 Connect account. If this
app has an address for that machine and is connected to it with a session that
manages access there, it makes the pairing code itself; otherwise paste one
from that machine's **Settings → Sharing & access**. An address you type always
needs a pasted code. From a terminal, use
`t3 environment link <address> --pairing-code <code> --access <mode>`.

You can also ask an agent to link a machine by name, such as "delegate this to
my vps". It shows a card in the thread where you pick the machine the same way
and the access, then approve. An address the agent gives that this app does
not know for one of your machines also needs a pasted code. Paste one only for
an address you trust: the code is sent there.

- The access you pick is the most agents from this machine may do there. An
  agent also never gets more there than its own mode here.
- Threads a link starts are marked **From** and this machine's name there.
- A full-access link works there like that machine's own agents. Below full
  access, the link's agents can change only threads it started, not that
  machine's own threads, projects or settings, and they skip its project setup
  scripts.
- The link shows up in that machine's **Settings → Sharing & access** like any
  outside agent. Revoke it there to end it. **Forget** on this machine only
  removes it here.
- Links last 30 days. Link again with a new pairing code to renew one.

An agent can also hand a task to a linked machine with `delegate_task`: it runs
there as an ordinary thread, in the project with the same repository (or the
one `target.projectId` names), and this thread wakes with its result when it
ends, as for any delegated task. It keeps following the task across restarts.
If the other machine revokes the link, or the link is removed here, the task
fails with that reason.

## Manage or revoke access

On the host, **Settings → Sharing & access** lets authorized administrators create
pairing links and revoke client sessions. Revoking an unused link prevents new
pairings; revoke a device's session to remove its existing access. Command-line
management is available through `t3 auth --help`.

When the app connects to more than one environment, choose one at the top of the
page. A desktop app with **Local environment** off can manage a background
service on the same machine this way, including its T3 Connect link.

A session with an open connection stays listed after its access credential
expires.

To choose a token's permissions, pass `--scope` once for each scope you want:

```sh
t3 pair --scope orchestration:read --scope relay:read
```

The selected scopes replace the default permissions. The same option works with
`t3 auth pairing create` and `t3 auth session issue`; each command's
`--help` lists the available scopes. Without `--scope`, pairing tokens and issued
bearer sessions get every permission, including managing access and T3 Connect.
A terminal or a full-access agent on the host can reach those as well, so a
client that should not manage access also needs to go without `terminal:operate`
and `orchestration:operate`.

To change an existing client's permissions, create a fresh pairing link with the
scopes it needs. In a browser opened directly on the environment, open that link
to replace the browser's current grant. For mobile or a saved remote environment
in web or desktop, use **Add Environment** with the fresh link or code; pairing
the same environment replaces its saved grant. Reconnecting alone does not change
permissions.

Grouping checkouts does not combine their permissions. Shared project settings
require `orchestration:operate` on every member environment; actions on one
checkout use that checkout's permissions.

`source-control:write` covers direct Git and pull request changes made from the
client: pushing, switching or creating branches, cloning, and removing
worktrees. It does not restrict what a task does. Starting a task in a new
worktree still creates that branch and worktree with `orchestration:operate`,
and the agent it runs can use Git however the environment allows.

Settings changes, provider management, environment maintenance, access
management, and T3 Connect management can each be granted separately. New
pairings without `--scope` include all of them. Existing clients keep the
permissions they paired with and can stay connected after an update, but newly
separated features may require pairing again with the permissions they need.
Older clients may show controls that the server denies. Create a fresh pairing
link to change a client's permissions.

`filesystem:read` allows browsing host files, opening workspace files, and viewing
local changes. Add `filesystem:write` to allow editing files or saving plans to
the workspace. These scopes control direct file access from the client.

To remove an environment from T3 Connect, open your account menu's **T3 Connect**
page, or **Settings → T3 Connect** on mobile, and choose **Deregister**. This
revokes its cloud access and frees its host space even when the environment is
offline or has been wiped. When T3 Connect rejects a host's link, the host
shows that it was removed from T3 Connect. To link it again, turn on
**T3 Connect** in **Settings → Sharing & access** on a desktop host, or run
`t3 connect link` on a command-line host and then restart T3 Code there. A
command-line host that released its tunnel when it last stopped may link itself
again on its next start; run `t3 connect unlink` on that host to keep it off.
Removing an environment from a device's connection settings only forgets it on
that device and doesn't change your T3 Connect account. A device keeps a saved
environment after it's deregistered until you remove it from that device.

When idle tunnel cleanup is enabled, T3 Connect removes a linked environment's
tunnel after it stays offline for several minutes. The environment stays linked
and keeps the same address. When the host starts again or wakes, T3 Connect
creates a replacement tunnel on its own. You do not need to pair again. Cleanup
usually runs five to ten minutes after the tunnel goes down.

T3 Connect also removes the tunnel of an environment running an older version of
T3 Code once it has been offline for seven days. That environment shows a message
asking you to update. Start T3 Code on that computer and update it to the latest
version; it reconnects at the same address without pairing again.

On a command-line host, `t3 connect unlink` disables exposure while retaining
your login; `t3 connect logout` also clears that login. Background-service
[removal](./background-service.md#manage-the-service) is separate.

Treat pairing URLs and authorization codes as passwords. Do not include them in
screenshots, logs, or bug reports.

## T3 Connect troubleshooting

When a T3 Connect connection fails, see
[T3 Connect troubleshooting](./t3-connect-troubleshooting.md). It explains each
error, where the problem is, and how to fix it.

## Using the Desktop App as a Remote Only

If a computer should only drive work running elsewhere, turn off its local environment. In the
desktop app, open **Settings → Environments** and switch off **Local
environment**. T3 Code restarts without a local server: no local agents or terminals run, WSL
backends stay off, and other devices can no longer connect to this computer. Your projects,
history, and saved connections are kept, and you keep working through pairing, T3 Connect, or SSH.
If a [background service](./background-service.md) on this computer uses the same T3 home, the
app still treats it as this computer: **Open in** and file reveal for its projects run here,
whichever connection you reach it through.

Switch **Local environment** back on in the same place to restart with your previous local
settings.
