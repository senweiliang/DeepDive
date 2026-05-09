import { describe, it, expect } from "vitest";
import { toolNeedsApproval, toolAllowed } from "../tools/approval.js";

describe("approval", () => {
  describe("toolAllowed", () => {
    it("plan mode allows read-only tools", () => {
      expect(toolAllowed("read_file", "plan")).toBe(true);
      expect(toolAllowed("glob", "plan")).toBe(true);
      expect(toolAllowed("grep", "plan")).toBe(true);
    });

    it("plan mode denies writes and exec", () => {
      expect(toolAllowed("write_file", "plan")).toBe(false);
      expect(toolAllowed("edit_file", "plan")).toBe(false);
      expect(toolAllowed("bash", "plan")).toBe(false);
    });

    it("default mode allows all tools", () => {
      expect(toolAllowed("read_file", "default")).toBe(true);
      expect(toolAllowed("write_file", "default")).toBe(true);
      expect(toolAllowed("bash", "default")).toBe(true);
    });

    it("yolo mode allows all tools", () => {
      expect(toolAllowed("read_file", "yolo")).toBe(true);
      expect(toolAllowed("write_file", "yolo")).toBe(true);
      expect(toolAllowed("bash", "yolo")).toBe(true);
    });
  });

  describe("toolNeedsApproval", () => {
    it("plan mode requires approval for writes and exec", () => {
      expect(toolNeedsApproval("write_file", "plan")).toBe(true);
      expect(toolNeedsApproval("edit_file", "plan")).toBe(true);
      expect(toolNeedsApproval("bash", "plan")).toBe(true);
    });

    it("plan mode: read tools do not need approval", () => {
      // They're allowed, but don't need approval
      expect(toolNeedsApproval("read_file", "plan")).toBe(false);
      expect(toolNeedsApproval("glob", "plan")).toBe(false);
      expect(toolNeedsApproval("grep", "plan")).toBe(false);
    });

    it("default mode requires approval for writes and exec", () => {
      expect(toolNeedsApproval("write_file", "default")).toBe(true);
      expect(toolNeedsApproval("edit_file", "default")).toBe(true);
      expect(toolNeedsApproval("bash", "default")).toBe(true);
    });

    it("default mode: read tools do not need approval", () => {
      expect(toolNeedsApproval("read_file", "default")).toBe(false);
      expect(toolNeedsApproval("glob", "default")).toBe(false);
      expect(toolNeedsApproval("grep", "default")).toBe(false);
    });

    it("yolo mode never needs approval", () => {
      expect(toolNeedsApproval("read_file", "yolo")).toBe(false);
      expect(toolNeedsApproval("write_file", "yolo")).toBe(false);
      expect(toolNeedsApproval("bash", "yolo")).toBe(false);
    });
  });
});
