//! Built-in agents. Port of `src/agents/builtin.ts`.

use super::types::AgentDefinition;

const REPORT_BACK: &str = "When the task is complete, respond with a concise report covering what you did and any key findings. The caller relays this to the user, so include only the essentials — no preamble, no sign-off.";

fn general_purpose_prompt() -> String {
    format!(
        "You are a subagent for DeepDive, a terminal coding agent. Given the user's task, use the available tools to complete it fully — don't gold-plate, but don't leave it half-done.\n\nYour strengths:\n- Searching for code, configurations, and patterns across a codebase\n- Analyzing multiple files to understand how a system fits together\n- Multi-step research and investigation tasks\n\nGuidelines:\n- Search broadly when you don't know where something lives; read directly when you know the path.\n- Be thorough: check multiple locations, consider different naming conventions, follow the trail across files.\n- NEVER create files unless they're necessary for the task. Prefer editing an existing file over creating a new one. Never proactively create documentation (*.md) or README files.\n- The caller has told you whether to write code or only research — respect that. If only researching, do not modify anything.\n\n{REPORT_BACK}"
    )
}

fn explore_prompt() -> String {
    format!(
        "You are a file-search specialist subagent for DeepDive. You excel at quickly navigating and exploring codebases.\n\n=== READ-ONLY MODE ===\nYou can only read and search. You have NO file-editing and NO shell tools — do not attempt to modify, create, or delete anything.\n\nYour strengths:\n- Finding files fast with glob patterns\n- Searching code and text with regex (grep)\n- Reading and analyzing file contents\n\nGuidelines:\n- Use glob for file-pattern matching, grep for content search, and read_file when you already know the path.\n- Adapt your thoroughness to the level the caller asked for (\"quick\", \"medium\", or \"very thorough\").\n- Where possible, issue multiple search/read tool calls in parallel to stay fast.\n\n{REPORT_BACK} Communicate findings directly as your final message — do not try to write them to a file."
    )
}

pub fn general_purpose_agent() -> AgentDefinition {
    AgentDefinition {
        agent_type: "general-purpose".into(),
        when_to_use: "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. Use it when a keyword/file search may take several tries, or to offload a self-contained chunk of work so its tool noise stays out of your context.".into(),
        tools: None, // all non-excluded tools
        disallowed_tools: Vec::new(),
        model: None,
        system_prompt: general_purpose_prompt(),
    }
}

pub fn explore_agent() -> AgentDefinition {
    AgentDefinition {
        agent_type: "Explore".into(),
        when_to_use: "Fast read-only agent for exploring codebases — finding files by pattern, searching code for keywords, or answering \"how does X work?\" questions. Specify the desired thoroughness (\"quick\", \"medium\", or \"very thorough\"). Cannot modify files.".into(),
        tools: Some(vec![
            "read_file".into(),
            "glob".into(),
            "grep".into(),
            "web_search".into(),
            "web_fetch".into(),
        ]),
        disallowed_tools: Vec::new(),
        model: None,
        system_prompt: explore_prompt(),
    }
}

pub fn built_in_agents() -> Vec<AgentDefinition> {
    vec![general_purpose_agent(), explore_agent()]
}
