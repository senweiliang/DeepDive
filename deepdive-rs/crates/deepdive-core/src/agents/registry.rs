//! Agent registry. Port of `src/agents/registry.ts`.
//!
//! Built-ins + custom agents, deduped by `agent_type` with last-wins precedence
//! (built-in < user < project) while preserving first-seen order (matching JS
//! `Map` semantics). Memoized; `reload_agents` invalidates.

use super::builtin::built_in_agents;
use super::load::load_custom_agents;
use super::types::AgentDefinition;
use crate::skills::AssetSource;
use crate::tools::schema::{tool_name, ALL_TOOLS};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, RwLock};

/// Tools never exposed to ANY subagent (recursion / headless guards).
const SUBAGENT_EXCLUDED: &[&str] = &[
    "agent",
    "ask_user_question",
    "skill",
    "task_output",
    "task_stop",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentSource {
    BuiltIn,
    User,
    Project,
}

#[derive(Debug, Clone)]
pub struct RegisteredAgent {
    pub def: AgentDefinition,
    pub source: AgentSource,
}

struct Registry {
    /// agent_type in first-seen order.
    order: Vec<String>,
    map: HashMap<String, RegisteredAgent>,
}

static REGISTRY: LazyLock<RwLock<Option<Registry>>> = LazyLock::new(|| RwLock::new(None));

fn build_registry() -> Registry {
    let mut order = Vec::new();
    let mut map: HashMap<String, RegisteredAgent> = HashMap::new();

    let mut insert = |key: String, ra: RegisteredAgent| {
        if !map.contains_key(&key) {
            order.push(key.clone());
        }
        map.insert(key, ra);
    };

    for def in built_in_agents() {
        insert(
            def.agent_type.clone(),
            RegisteredAgent {
                def,
                source: AgentSource::BuiltIn,
            },
        );
    }
    for loaded in load_custom_agents() {
        let source = match loaded.source {
            AssetSource::User => AgentSource::User,
            AssetSource::Project => AgentSource::Project,
        };
        insert(
            loaded.def.agent_type.clone(),
            RegisteredAgent {
                def: loaded.def,
                source,
            },
        );
    }
    Registry { order, map }
}

fn with_registry<R>(f: impl FnOnce(&Registry) -> R) -> R {
    {
        let guard = REGISTRY.read().unwrap();
        if let Some(reg) = guard.as_ref() {
            return f(reg);
        }
    }
    let built = build_registry();
    let mut guard = REGISTRY.write().unwrap();
    let reg = guard.get_or_insert(built);
    f(reg)
}

/// Re-scan agent directories on next access.
pub fn reload_agents() {
    *REGISTRY.write().unwrap() = None;
}

pub fn get_built_in_agents() -> Vec<AgentDefinition> {
    built_in_agents()
}

/// Every available agent, in registration order.
pub fn get_all_agents() -> Vec<AgentDefinition> {
    with_registry(|reg| {
        reg.order
            .iter()
            .filter_map(|k| reg.map.get(k))
            .map(|e| e.def.clone())
            .collect()
    })
}

/// Every available agent with provenance, in registration order.
pub fn get_registered_agents() -> Vec<RegisteredAgent> {
    with_registry(|reg| {
        reg.order
            .iter()
            .filter_map(|k| reg.map.get(k))
            .cloned()
            .collect()
    })
}

pub fn get_agent(agent_type: &str) -> Option<AgentDefinition> {
    with_registry(|reg| reg.map.get(agent_type).map(|e| e.def.clone()))
}

/// The concrete tool set a subagent may use: ALL_TOOLS minus the always-excluded
/// set, then filtered by the agent's allow/deny lists.
pub fn resolve_agent_tools(def: &AgentDefinition) -> Vec<Value> {
    // explicit empty allowlist ("tools: none") → no tools at all.
    if def.tools.as_ref().map(|t| t.is_empty()).unwrap_or(false) {
        return Vec::new();
    }
    let allow: Option<HashSet<&str>> = def
        .tools
        .as_ref()
        .filter(|t| !t.is_empty())
        .map(|t| t.iter().map(String::as_str).collect());
    let deny: HashSet<&str> = def.disallowed_tools.iter().map(String::as_str).collect();

    ALL_TOOLS
        .iter()
        .filter(|t| {
            let name = tool_name(t).unwrap_or("");
            if SUBAGENT_EXCLUDED.contains(&name) {
                return false;
            }
            if let Some(a) = &allow {
                if !a.contains(name) {
                    return false;
                }
            }
            !deny.contains(name)
        })
        .cloned()
        .collect()
}

/// `- type: when-to-use` line for the task tool listing.
pub fn format_agent_line(def: &AgentDefinition) -> String {
    format!("- {}: {}", def.agent_type, def.when_to_use)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtins_present_and_ordered() {
        let agents = get_all_agents();
        // built-ins always present; general-purpose first
        assert!(agents.iter().any(|a| a.agent_type == "general-purpose"));
        assert!(agents.iter().any(|a| a.agent_type == "Explore"));
        assert_eq!(agents[0].agent_type, "general-purpose");
    }

    #[test]
    fn resolve_tools_excludes_recursion_and_respects_allowlist() {
        let general = super::super::builtin::general_purpose_agent();
        let tools = resolve_agent_tools(&general);
        let names: Vec<&str> = tools.iter().filter_map(|t| tool_name(t)).collect();
        // excluded set never present
        for ex in SUBAGENT_EXCLUDED {
            assert!(!names.contains(ex), "{ex} must be excluded");
        }
        // general-purpose (no allowlist) keeps file/search/bash/web tools
        assert!(names.contains(&"read_file"));
        assert!(names.contains(&"bash"));

        let explore = super::super::builtin::explore_agent();
        let etools = resolve_agent_tools(&explore);
        let enames: Vec<&str> = etools.iter().filter_map(|t| tool_name(t)).collect();
        assert!(enames.contains(&"read_file"));
        assert!(enames.contains(&"grep"));
        assert!(!enames.contains(&"bash")); // not in Explore's allowlist
        assert!(!enames.contains(&"write_file"));
    }

    #[test]
    fn no_tools_agent_gets_empty() {
        let mut def = super::super::builtin::general_purpose_agent();
        def.tools = Some(Vec::new()); // "tools: none"
        assert!(resolve_agent_tools(&def).is_empty());
    }

    #[test]
    fn denylist_removes_a_tool() {
        let mut def = super::super::builtin::general_purpose_agent();
        def.disallowed_tools = vec!["bash".into()];
        let names: Vec<String> = resolve_agent_tools(&def)
            .iter()
            .filter_map(|t| tool_name(t).map(String::from))
            .collect();
        assert!(!names.iter().any(|n| n == "bash"));
        assert!(names.iter().any(|n| n == "read_file"));
    }

    #[test]
    fn format_line() {
        let def = super::super::builtin::explore_agent();
        let line = format_agent_line(&def);
        assert!(line.starts_with("- Explore: "));
    }
}
