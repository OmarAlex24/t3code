import { describe, expect, it } from "vite-plus/test";

import { plainSubagentDetail, subagentDetailPreview } from "./subagentDisplay.js";

describe("subagentDetailPreview", () => {
  it("prefers progress for live work and results for settled work", () => {
    const details = { progress: "Reading files", result: "Found two\n  problems" };
    expect(subagentDetailPreview({ ...details, status: "running" })).toBe("Reading files");
    expect(subagentDetailPreview({ ...details, status: "completed" })).toBe("Found two problems");
    expect(
      subagentDetailPreview({ status: "failed", progress: "Last progress", result: " " }),
    ).toBe("Last progress");
    expect(subagentDetailPreview({ status: "pending" })).toBeNull();
  });

  it("drops the tool list Claude puts before a result", () => {
    expect(
      subagentDetailPreview({
        status: "completed",
        result: "<tools-used-before-summary>Bash, Read</tools-used-before-summary>\n\n## Summary",
      }),
    ).toBe("## Summary");
  });
});

describe("plainSubagentDetail", () => {
  it.each([
    [
      "leading tag block and heading",
      "<tools-used-before-summary>Bash, Read</tools-used-before-summary>\n\n## Resumen\n\nHay un método.",
      "Resumen Hay un método.",
    ],
    [
      "escaped tag block",
      "&lt;tools-used-before-summary&gt;Bash&lt;/tools-used-before-summary&gt; Done",
      "Done",
    ],
    ["markup later in the text", "Renders <b>bold</b> now", "Renders <b>bold</b> now"],
    [
      "links, code and bullets",
      "- Read [auth](./auth.ts)\n- Ran `vp test`",
      "Read auth Ran vp test",
    ],
  ])("%s", (_name, text, expected) => {
    expect(plainSubagentDetail(text)).toBe(expected);
  });
});

it.each([279, 280, 281])("preserves the preview boundary at %i characters", (length) => {
  const result = "x".repeat(length);
  expect(subagentDetailPreview({ status: "completed", result })).toBe(
    length > 280 ? "x".repeat(280) + "…" : result,
  );
});

it("normalizes Unicode whitespace and ignores a large hidden suffix", () => {
  const progress = " \u00a0Reading\tfiles\n" + "x".repeat(1_000_000);
  expect(subagentDetailPreview({ status: "running", progress })).toBe(
    "Reading files " + "x".repeat(266) + "…",
  );
  expect(
    subagentDetailPreview({ status: "completed", result: "x".repeat(280) + " \n\u2028" }),
  ).toBe("x".repeat(280));
  expect(subagentDetailPreview({ status: "completed", result: "x".repeat(279) + " \n y" })).toBe(
    "x".repeat(279) + "…",
  );
  expect(
    subagentDetailPreview({ status: "running", progress: "\uFEFF\u2029", result: " Done " }),
  ).toBe("Done");
  expect(subagentDetailPreview({ status: "failed", result: "x".repeat(279) + "😀" })).toBe(
    "x".repeat(279) + "…",
  );
});
