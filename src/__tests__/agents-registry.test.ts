import { describe, it, expect } from "vitest";
import {
  resolveAgentTools,
  getAgent,
  getAllAgents,
} from "../agents/registry.js";
import type { AgentDefinition } from "../agents/types.js";

function def(partial: Partial<AgentDefinition>): AgentDefinition {
  return {
    agentType: "test",
    whenToUse: "test agent",
    getSystemPrompt: () => "you are a test agent",
    ...partial,
  };
}

describe("agent registry", () => {
  it("includes the built-in agents", () => {
    const types = getAllAgents().map((a) => a.agentType);
    expect(types).toContain("general-purpose");
    expect(types).toContain("Explore");
    expect(getAgent("general-purpose")).toBeDefined();
    expect(getAgent("nope-not-real")).toBeUndefined();
  });

  describe("resolveAgentTools", () => {
    const names = (d: AgentDefinition) =>
      resolveAgentTools(d).map((t) => t.function.name);

    it("undefined tools → all tools except the never-allowed set", () => {
      const tools = names(def({ tools: undefined }));
      // a normal tool is present
      expect(tools).toContain("read_file");
      expect(tools).toContain("bash");
      // the never-allowed set is always stripped (no recursion / no headless prompts)
      expect(tools).not.toContain("agent");
      expect(tools).not.toContain("ask_user_question");
      expect(tools).not.toContain("skill");
      expect(tools).not.toContain("task_output");
      expect(tools).not.toContain("task_stop");
    });

    it("empty tools list → no tools at all", () => {
      expect(names(def({ tools: [] }))).toEqual([]);
    });

    it("explicit allowlist → only those tools (minus excluded)", () => {
      const tools = names(def({ tools: ["read_file", "grep", "agent"] }));
      expect(tools.sort()).toEqual(["grep", "read_file"]);
      // even if listed, an excluded tool never leaks through
      expect(tools).not.toContain("agent");
    });

    it("denylist removes tools after the allowlist", () => {
      const tools = names(def({ disallowedTools: ["bash"] }));
      expect(tools).toContain("read_file");
      expect(tools).not.toContain("bash");
    });
  });
});
