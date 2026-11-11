# Milestones

On long, multi-phase work, an agent plans its phases as milestones and marks each one as it starts and finishes. The thread's **Milestones** view draws that plan as a map: what is done, what is running, what is left, and which subagents worked on each phase. Short tasks don't get milestones.

Switch a thread between **Chat** and **Milestones** with the toggle in its header, the command palette, or `mod+alt+m`. Each thread remembers its view, and a new thread opens in the view you used last. The composer stays at the bottom in both. Milestones is available on web and desktop.

## The whole thread

Milestones run down a line in the order work started, each card showing its status, what the agent did last, how its subagents did, and how long it took. Work the agent did outside its plan branches off to the side and rejoins the plan at the next milestone. When the agent replaces its plan, the new plan branches from the milestone it left off at, and the old plan's unfinished milestones show as dropped.

- Drag to move around, scroll to pan, and pinch or hold `mod` while scrolling to zoom. The controls at the bottom left zoom in, zoom out, and fit the whole thread.
- When a subagent asks you for a secret or for approval, the ask shows above the composer, named after the subagent and its milestone. Hide a secret ask to fold it to one line; **Answer** opens it again.

A thread without milestones shows one card per turn instead.

## One milestone

Select a milestone to zoom in. Its subagents fan out beside it, grouped the way the agent grouped them, such as UI or Backend, with sub-subagents under the subagent that started them. Its posts and a comment box follow. On a narrow window the subagents sit under the milestone instead.

- Select a subagent's name to open its chat beside the view. Closing that tab doesn't delete the subagent.
- **Answer** on a subagent that waits on you takes you to its ask above the composer, or to its chat for a question.
- Select **Comment on this milestone** to start a message that names it. The agent receives it like any other message, and the comment stays on that milestone.
- The agent can post notes and images to a milestone. Visual replies it shows during a milestone appear there too; select one to see it in Chat.
- Press `Esc` or the back arrow to zoom back out, and the arrow keys to step through milestones.

## The plan in Chat

While you read Chat, the thread details card keeps the plan at its top: progress, each milestone, and how the live milestone's groups are doing. Select a milestone to open Milestones on it, or **Open in Milestones** for the whole thread. Hide it from the details card's menu with **Milestone plan**.

Only the loaded part of a long thread fills the view; scrolling back in Chat loads more.
