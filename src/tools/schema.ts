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
      name: "agent",
      description:
        "Launch a subagent to handle a complex, multi-step task autonomously, then return its final report. The subagent runs with its OWN isolated context and a scoped tool set — its intermediate tool calls never enter your context. Use it to offload self-contained research/search work so your own context stays clean.\n\nAvailable subagent_type values:\n- general-purpose: research complex questions, search code, run multi-step tasks (all tools).\n- Explore: fast read-only codebase exploration — find files, search code, answer \"how does X work?\" (read/search tools only; cannot modify files).\n\nUsage notes:\n- Write a thorough, self-contained prompt: the subagent does NOT see this conversation. Say what to do, give the context it needs, and state whether to write code or only research.\n- The subagent's result returns to you, not the user — relay a concise summary yourself.\n- Subagents cannot ask for approval: in default mode they can only read/search; file writes and shell commands require acceptEdits or yolo mode.\n- Subagents cannot spawn further subagents.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          description: {
            type: "string",
            description: "A short (3-5 word) description of the task.",
          },
          subagent_type: {
            type: "string",
            enum: ["general-purpose", "Explore"],
            description:
              "Which agent to use. Defaults to general-purpose if omitted.",
          },
          prompt: {
            type: "string",
            description:
              "The full task for the subagent. Must be self-contained — the subagent has no access to this conversation.",
          },
        },
        required: ["description", "prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user_question",
      description:
        "Ask the user one or more multiple-choice questions to gather preferences, clarify ambiguity, or decide between approaches mid-task. A free-form \"Other\" choice is added automatically for every question — never include your own \"Other\" option. If you recommend a choice, make it the first option and append \" (Recommended)\" to its label. In plan mode, use this to clarify requirements before finalizing a plan, but do NOT use it to ask whether the plan looks good. Prefer answering from context; only ask when the answer genuinely changes what you do next.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          questions: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            description: "1 to 4 questions to ask the user.",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                question: {
                  type: "string",
                  description:
                    "The complete question text, ending with a question mark.",
                },
                header: {
                  type: "string",
                  description:
                    "Very short label (max 12 chars) shown as a chip, e.g. \"Auth method\" or \"Approach\".",
                },
                multiSelect: {
                  type: "boolean",
                  default: false,
                  description:
                    "Set true to let the user pick multiple options. Use when choices are not mutually exclusive.",
                },
                options: {
                  type: "array",
                  minItems: 2,
                  maxItems: 4,
                  description:
                    "2 to 4 distinct, mutually-exclusive choices (unless multiSelect is true).",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      label: {
                        type: "string",
                        description:
                          "Short display text the user selects (1-5 words).",
                      },
                      description: {
                        type: "string",
                        description:
                          "What choosing this option means or its trade-offs.",
                      },
                    },
                    required: ["label", "description"],
                  },
                },
              },
              required: ["question", "header", "options"],
            },
          },
        },
        required: ["questions"],
      },
    },
  },
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
          timeout: {
            type: "number",
            description: `Optional timeout in milliseconds (max 600000). Defaults to 120000 (2 min).`,
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
      name: "skill",
      description:
        "Load and execute a DeepDive skill by name. Use this before answering when a listed skill matches the user's task; the skill's full instructions will be added to the conversation.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: {
            type: "string",
            description: "The skill name, for example \"commit\".",
          },
          args: {
            type: "string",
            description: "Optional arguments to pass to the skill.",
            default: "",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "Fetch a URL and return its page content as readable text. Use after web_search to read the full content of a result, or to read any known URL. http URLs are upgraded to https.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: {
            type: "string",
            description: "The absolute http(s) URL to fetch.",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web and return result titles, URLs, and snippets. Use for current events or information beyond the training cutoff. When searching for recent information, documentation, or current events, put the current year in the query — take it from \"Today's date\" in the Environment section, not from training data (e.g. for \"latest React docs\" search \"React documentation <current year>\"). Follow up with a fetch of a result URL if you need the full page, and cite the URLs you relied on at the end of your answer.",
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
