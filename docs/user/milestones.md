# Milestones

On long, multi-phase work, an agent plans its phases as milestones and marks each one as it starts and finishes. The thread's **Milestones** view shows that plan: where the agent is, what it finished, what changed since it planned, and which subagents work on each phase. Short tasks don't get milestones.

Switch a thread between **Chat** and **Milestones** with the toggle in its header, the command palette, or `mod+alt+m`. Each thread remembers its view, and a new thread opens in the view you used last. The composer stays at the bottom in both. Milestones is available on web and desktop.

- Select a milestone, or one of your messages, to jump to that point in Chat.
- Finished milestones fold into a summary of their agents and posts; select it to unfold one. When an agent fails, **N agents failed** at the top takes you to it.
- Select a subagent to open its chat beside the view. Closing that tab doesn't delete the subagent.
- When the agent or a subagent is waiting on you, the milestone it is working on says so. Answer the agent in the composer; **Answer** opens a subagent's chat.
- Select **Comment on this milestone** to start a message that names it. The agent receives it like any other message, and the comment stays on that milestone.
- The agent can post notes and images to a milestone. Visual replies it shows during a milestone appear there too.

A thread without milestones shows one entry per turn instead. Only the loaded part of a long thread fills the view; scrolling back in Chat loads more.
