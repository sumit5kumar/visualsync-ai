import { describe, expect, it } from "vitest";
import { compareNaturalFilenames, getWorkerCapabilities } from "./workerContracts";

describe("VisualSync local-worker contract", () => {
  it("sorts numbered story frames naturally before downstream analysis", () => {
    const files = ["10.jpg", "2.jpg", "001.jpg", "1.jpg"].sort(compareNaturalFilenames);
    expect(files).toEqual(["001.jpg", "1.jpg", "2.jpg", "10.jpg"]);
  });

  it("requires FAISS and variable-timeline rendering in the capability declaration", () => {
    const capabilities = getWorkerCapabilities();
    expect(capabilities.guarantees.join(" ")).toContain("FAISS");
    expect(capabilities.guarantees.join(" ")).toContain("variable-duration");
  });
});
