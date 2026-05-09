// JSON Schema definitions for DeepDive tools.
// Tools are sorted by name for prefix-cache stability.

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const ALL_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "Execute a shell command in the workspace directory and return stdout/stderr.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace a string in a file with another string. Fails if old_string is not unique.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file, relative to workspace root.",
          },
          old_string: {
            type: "string",
            description: "Exact string to replace (must be unique in file).",
          },
          new_string: {
            type: "string",
            description: "String to replace it with.",
          },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files matching a glob pattern.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Glob pattern, e.g. 'src/**/*.ts'.",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents with a regular expression.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Regular expression to search for.",
          },
          path: {
            type: "string",
            description: "File or directory to search in (default: workspace).",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file, relative to workspace root.",
          },
          offset: {
            type: "integer",
            description: "Line number to start reading from (0-indexed).",
          },
          limit: {
            type: "integer",
            description: "Max number of lines to read.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create a new file or overwrite an existing file.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file, relative to workspace root.",
          },
          content: {
            type: "string",
            description: "Full contents of the file.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
];
