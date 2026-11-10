import {
  activeMilestoneId,
  type ChatImageAttachment,
  CommandId,
  isProviderSendTurnSupportedImageMimeType,
  MILESTONE_NOTE_MAX_CHARS,
  MILESTONE_POST_MAX_CHARS,
  MILESTONE_POST_MAX_IMAGES,
  MILESTONE_TITLE_MAX_CHARS,
  OrchestrationV2MilestoneAction,
  OrchestratorMcpFailure,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ThreadId,
  type ThreadMilestoneMcpInput,
  type ThreadMilestoneMcpResult,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  chatAttachmentStableKey,
  createDeterministicAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { summarizeMilestones } from "../orchestration-v2/MilestoneDecider.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { fileHeaderMimeType } from "../workspace/fileHeaderMimeType.ts";
import { type McpInvocationScope, requireThreadScope } from "./McpInvocationContext.ts";

export class ThreadMilestoneMcpService extends Context.Service<
  ThreadMilestoneMcpService,
  {
    /** Marks a milestone on the calling thread, from its live run. */
    readonly apply: (
      scope: McpInvocationScope,
      input: ThreadMilestoneMcpInput,
    ) => Effect.Effect<ThreadMilestoneMcpResult, OrchestratorMcpFailure>;
  }
>()("t3/mcp/ThreadMilestoneMcpService") {}

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const stablePart = (value: string) => encodeURIComponent(value);

const decodeAction = Schema.decodeUnknownExit(OrchestrationV2MilestoneAction);
const isMcpFailure = Schema.is(OrchestratorMcpFailure);

/** Checks each field against the action, so the model gets the fix instead of a schema dump. */
function actionFromInput(
  input: ThreadMilestoneMcpInput,
  attachments: ReadonlyArray<ChatImageAttachment>,
): OrchestrationV2MilestoneAction | OrchestratorMcpFailure {
  const allowed: Record<ThreadMilestoneMcpInput["action"], ReadonlyArray<string>> = {
    plan: ["titles"],
    start: ["id", "title", "note"],
    done: ["id", "note"],
    change: ["id", "title", "note"],
    drop: ["id", "note"],
    post: ["note", "images"],
  };
  const extra = (["titles", "id", "title", "note", "images"] as const).filter(
    (field) => input[field] !== undefined && !allowed[input.action].includes(field),
  );
  if (extra.length > 0) {
    return invalid(`\`${input.action}\` takes ${allowed[input.action].join(", ")}; drop ${extra}.`);
  }
  const titles = [...(input.titles ?? []), ...(input.title === undefined ? [] : [input.title])];
  if (titles.some((title) => title.trim().length > MILESTONE_TITLE_MAX_CHARS)) {
    return invalid(`Titles are at most ${MILESTONE_TITLE_MAX_CHARS} characters.`);
  }
  const noteLimit = input.action === "post" ? MILESTONE_POST_MAX_CHARS : MILESTONE_NOTE_MAX_CHARS;
  if (input.note !== undefined && input.note.trim().length > noteLimit) {
    return invalid(`\`note\` is at most ${noteLimit} characters.`);
  }
  const candidate = (() => {
    switch (input.action) {
      case "plan":
        return { action: "plan", titles: input.titles ?? [] };
      case "start":
        return { action: "start", id: input.id, title: input.title, note: input.note };
      case "done":
        return { action: "done", id: input.id, note: input.note };
      case "change":
        return { action: "change", id: input.id, title: input.title, reason: input.note };
      case "drop":
        return { action: "drop", id: input.id, reason: input.note };
      case "post":
        return { action: "post", text: input.note, attachments };
    }
  })();
  if ((input.action === "change" || input.action === "drop") && input.note === undefined) {
    return invalid(`\`${input.action}\` needs \`id\` and \`note\` (the reason).`);
  }
  const decoded = decodeAction(
    Object.fromEntries(Object.entries(candidate).filter(([, value]) => value !== undefined)),
  );
  if (Exit.isSuccess(decoded)) return decoded.value;
  return invalid(
    input.action === "plan"
      ? "`plan` needs nonempty `titles`."
      : "Ids look like `m3`; text must not be blank.",
  );
}

const make = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;

  /** Copies each image into the thread's attachments; returns the paths this call created. */
  const storeImages = Effect.fn("ThreadMilestoneMcpService.storeImages")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnItemId: TurnItemId;
    readonly images: ReadonlyArray<string>;
  }) {
    if (input.images.length > MILESTONE_POST_MAX_IMAGES) {
      return yield* invalid(`At most ${MILESTONE_POST_MAX_IMAGES} images per post.`);
    }
    const created: Array<string> = [];
    const attachments: Array<ChatImageAttachment> = [];
    for (const [index, imagePath] of input.images.entries()) {
      const name = path.basename(imagePath);
      if (!path.isAbsolute(imagePath)) {
        return yield* invalid("`images` are absolute paths on this machine.");
      }
      const info = yield* fileSystem
        .stat(imagePath)
        .pipe(Effect.mapError(() => invalid(`Cannot read ${imagePath}.`)));
      if (info.type !== "File") return yield* invalid(`${imagePath} is not a file.`);
      if (Number(info.size) > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        return yield* invalid(`${name} is over 10 MB.`);
      }
      const bytes = yield* fileSystem
        .readFile(imagePath)
        .pipe(Effect.mapError(() => invalid(`Cannot read ${imagePath}.`)));
      const mimeType = fileHeaderMimeType(bytes.subarray(0, 16));
      if (mimeType === undefined || !isProviderSendTurnSupportedImageMimeType(mimeType)) {
        return yield* invalid(`${name} is not a PNG, JPEG, GIF or WebP image.`);
      }
      // Retries with the same request key reuse the same ids, so a retry adds no copies.
      const id = createDeterministicAttachmentId(
        input.threadId,
        chatAttachmentStableKey(input.turnItemId, index, bytes),
      );
      if (id === null) return yield* invalid("This thread cannot store images.");
      const attachment: ChatImageAttachment = {
        type: "image",
        id,
        name: name.slice(0, 255),
        mimeType,
        sizeBytes: bytes.byteLength,
      };
      const target = resolveAttachmentPath({ attachmentsDir, attachment });
      if (target === null) return yield* invalid("This thread cannot store images.");
      yield* fileSystem
        .makeDirectory(path.dirname(target), { recursive: true })
        .pipe(Effect.ignore);
      const wrote = yield* fileSystem.writeFile(target, bytes, { flag: "wx" }).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error._tag === "PlatformError" && error.reason._tag === "AlreadyExists",
          () => Effect.succeed(false),
        ),
        Effect.mapError(() => invalid(`Could not store ${name}.`)),
      );
      if (wrote) created.push(target);
      attachments.push(attachment);
    }
    return { attachments, created };
  });

  const removeFiles = (paths: ReadonlyArray<string>) =>
    Effect.forEach(paths, (file) => fileSystem.remove(file, { force: true }).pipe(Effect.ignore), {
      discard: true,
    });

  const apply = Effect.fn("ThreadMilestoneMcpService.apply")(function* (
    callerScope: McpInvocationScope,
    input: ThreadMilestoneMcpInput,
  ) {
    const scope = yield* requireThreadScope(callerScope, "t3_milestone");
    if (scope.thread.subagent === true) {
      return yield* invalid("Only the coordinating thread marks milestones.");
    }
    const threadId = scope.thread.threadId;
    const records = yield* threadManagement.getThreadRecords(threadId, ["runs"]).pipe(
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: `Could not read thread ${threadId}.`,
          }),
      ),
    );
    const run = ThreadManagementService.latestActiveRun(records);
    if (
      run === undefined ||
      run.rootNodeId === null ||
      run.providerInstanceId !== scope.thread.providerInstanceId
    ) {
      return yield* new OrchestratorMcpFailure({
        code: "parent_not_active",
        message: "Milestones are marked from this thread's running turn.",
      });
    }
    const requestKey = input.clientRequestId ?? (yield* random.uuidV4());
    const turnItemId = TurnItemId.make(
      `turn-item:milestone:${stablePart(threadId)}:${stablePart(requestKey)}`,
    );
    const images =
      input.action === "post" && input.images !== undefined && input.images.length > 0
        ? yield* storeImages({ threadId, turnItemId, images: input.images })
        : { attachments: [], created: [] };
    const action = actionFromInput(input, images.attachments);
    if (isMcpFailure(action)) {
      yield* removeFiles(images.created);
      return yield* action;
    }
    yield* threadManagement
      .dispatch({
        type: "thread.milestone.apply",
        commandId: CommandId.make(
          [
            "command",
            "mcp",
            stablePart(scope.requestNamespace),
            "milestone",
            stablePart(threadId),
            stablePart(requestKey),
          ].join(":"),
        ),
        threadId,
        runId: run.id,
        nodeId: run.rootNodeId,
        turnItemId,
        action,
      })
      .pipe(
        // Only a final rejection frees the images: other failures may have committed them.
        Effect.catch((error) =>
          error._tag === "OrchestratorMilestoneRejectedError" ||
          error._tag === "OrchestratorCommandPreviouslyRejectedError"
            ? Effect.andThen(removeFiles(images.created), Effect.fail(invalid(error.detail)))
            : Effect.fail(
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: `Could not mark the milestone: ${error.message}`,
                }),
              ),
        ),
      );
    const { milestones } = yield* threadManagement.getThreadRecords(threadId, ["milestones"]).pipe(
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: `Could not read thread ${threadId}.`,
          }),
      ),
    );
    return {
      state: summarizeMilestones(
        milestones,
        input.action === "post" ? (activeMilestoneId(milestones) ?? null) : undefined,
      ),
    };
  });

  return ThreadMilestoneMcpService.of({ apply });
});

export const layer: Layer.Layer<
  ThreadMilestoneMcpService,
  never,
  | SecureRandom.SecureRandom
  | ThreadManagementService.ThreadManagementService
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig.ServerConfig
> = Layer.effect(ThreadMilestoneMcpService, make);
