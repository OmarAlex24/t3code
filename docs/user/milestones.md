# Milestones

On long, multi-phase work, an agent plans its phases as milestones and marks each one as it starts and finishes. The thread's **Milestones** view shows that plan on one timeline: what is done, what is running, what is left, and which subagents worked on each phase. Short tasks don't get milestones.

Switch a thread between **Chat** and **Milestones** with the toggle in its header, the command palette, or `mod+alt+m`. Each thread remembers its view, and a new thread opens in the view you used last. The composer stays at the bottom in both. Milestones is available on web and desktop.

## The whole thread

Milestones opens zoomed out: every milestone on one time axis, with the coordinator's own work on top and a **now** line. Milestones still to come sit after now, sized by how long finished ones took. Long stretches where nothing ran fold into a short break labelled with the idle time, so the axis keeps the work readable while its labels still show real time.

- The live milestone lists the groups its subagents work in, such as UI or Backend, with one line per subagent. Lines that overlap ran at the same time. Use the arrow beside any other milestone to show its groups.
- When the agent or a subagent waits on you, it shows above the timeline. Answer a secret or a link request right there; **Answer** opens a subagent's chat.
- When a subagent failed, **N failed** at the top opens its milestone and points at it.

A thread without milestones shows one row per turn instead.

## One milestone

Select a milestone, or one of its groups, to zoom in. The axis rescales to that milestone, each group lists its subagents, and the milestone's board follows below.

- Select a subagent to open its chat beside the view. Closing that tab doesn't delete the subagent.
- Select **Comment on this milestone** to start a message that names it. The agent receives it like any other message, and the comment stays on that milestone.
- The agent can post notes and images to a milestone. Visual replies it shows during a milestone appear there too; select one to see it in Chat.
- Press `Esc` or **All milestones** to zoom back out, and the left and right arrow keys to step through milestones.

## The plan in Chat

While you read Chat, the thread details card keeps the plan at its top: progress, each milestone, and how the live milestone's groups are doing. Select a milestone to open Milestones on it, or **Open in Milestones** for the whole thread. Hide it from the details card's menu with **Milestone plan**.

Only the loaded part of a long thread fills the view; scrolling back in Chat loads more.
