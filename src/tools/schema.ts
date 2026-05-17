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
        "Replace a string in a file with another string. Fails if old_string is not unique unless replace_all is true.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          file_path: {
            type: "string",
            description: "Absolute path to the file to modify.",
          },
          old_string: {
            type: "string",
            description: "Exact string to replace.",
          },
          new_string: {
            type: "string",
            description:
              "String to replace it with (must differ from old_string).",
          },
          replace_all: {
            type: "boolean",
            description:
              "Replace every occurrence of old_string. Defaults to false.",
            default: false,
          },
        },
        required: ["file_path", "old_string", "new_string"],
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
        additionalProperties: false,
        properties: {
          file_path: {
            type: "string",
            description: "Absolute path to the file to read.",
          },
          offset: {
            type: "integer",
            minimum: 1,
            description:
              "Line number to start reading from (1-indexed). Only provide if the file is too large to read at once.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            description:
              "Max number of lines to read. Only provide if the file is too large to read at once.",
          },
        },
        required: ["file_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web and return result titles, URLs, and snippets. Use for current events or information beyond the training cutoff. Follow up with a fetch of a result URL if you need the full page.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description: "The search query.",
          },
          max_results: {
            type: "integer",
            minimum: 1,
            maximum: 20,
            description: "Maximum number of results to return (default: 10).",
            default: 10,
          },
        },
        required: ["query"],
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
        additionalProperties: false,
        properties: {
          file_path: {
            type: "string",
            description:
              "Absolute path to the file to write (must be absolute, not relative).",
          },
          content: {
            type: "string",
            description: "Full contents of the file.",
          },
        },
        required: ["file_path", "content"],
      },
    },
  },
];
