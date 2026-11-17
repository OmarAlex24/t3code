import { waitingMessageCanResend } from "./ChatView.logic";
import { describe, expect, it } from "vite-plus/test";

describe("waitingMessageCanResend", () => {
  const ready = {
    waitingDraftId: "draft-1",
    draftId: "draft-1",
    isLocalDraftThread: true,
    onSandbox: true,
    canOperateThread: true,
    isSendBusy: false,
    isRevertingCheckpoint: false,
    threadDetailLoading: false,
    clientSettingsHydrated: true,
    needsLoadBalancing: false,
    activeEnvironmentUnavailable: false,
    hasPendingUserInput: false,
    feedbackUploading: false,
  };

  it("resends once the draft is idle", () => {
    expect(waitingMessageCanResend(ready)).toBe(true);
  });

  // A sandbox paired a moment ago can show its project before its session grants this app any
  // scope; a send then would be dropped while the message no longer waits.
  it("waits until the draft's sandbox lets this app start threads", () => {
    expect(waitingMessageCanResend({ ...ready, canOperateThread: false })).toBe(false);
    expect(waitingMessageCanResend({ ...ready, onSandbox: false, canOperateThread: false })).toBe(
      true,
    );
  });

  it("waits only for its own draft", () => {
    expect(waitingMessageCanResend({ ...ready, draftId: "draft-2" })).toBe(false);
    expect(waitingMessageCanResend({ ...ready, waitingDraftId: null })).toBe(false);
  });
});
