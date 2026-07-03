//! Load user/project agents from `.deepdive/agents/*.md`. Port of
//! `src/agents/load.ts`.

use super::types::AgentDefinition;
use crate::skills::{parse_frontmatter, AssetSource};
use crate::workspace::original_cwd;
use regex::Regex;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

static BLOCK_ITEM_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*-\s+(.*)$").unwrap());
static INDENTED_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s+\S").unwrap());
static LIST_BULLET_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[-*]\s+").unwrap());

#[derive(Debug, Clone)]
pub struct LoadedAgent {
    pub def: AgentDefinition,
    pub source: AssetSource,
    pub file_path: String,
}

fn unquote(value: &str) -> String {
    let v = value.trim();
    if v.len() >= 2
        && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')))
    {
        v[1..v.len() - 1].trim().to_string()
    } else {
        v.to_string()
    }
}

fn agent_dirs() -> Vec<(PathBuf, AssetSource)> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default();
    vec![
        (home.join(".deepdive").join("agents"), AssetSource::User),
        (
            original_cwd().join(".deepdive").join("agents"),
            AssetSource::Project,
        ),
    ]
}

fn frontmatter_block(raw: &str) -> String {
    if !raw.starts_with("---") {
        return String::new();
    }
    match raw[3..].find("\n---") {
        Some(rel) => raw[3..3 + rel].to_string(),
        None => String::new(),
    }
}

/// Parse a frontmatter tool-list field (comma / inline-array / block-list /
/// `*`/`all`/`none`) into an allowlist. `None` = inherit all.
pub fn parse_tool_list(block: &str, key: &str) -> Option<Vec<String>> {
    let key_re = Regex::new(&format!(r"^{}:\s*(.*)$", regex::escape(key))).unwrap();
    let lines: Vec<&str> = block
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect();

    for (i, line) in lines.iter().enumerate() {
        let Some(caps) = key_re.captures(line) else {
            continue;
        };
        let inline = unquote(&caps[1]);
        if !inline.is_empty() {
            let lower = inline.to_lowercase();
            if lower == "*" || lower == "all" {
                return None;
            }
            if lower == "none" {
                return Some(Vec::new());
            }
            // strip one leading `[` then one trailing `]` (each optional).
            let s1 = inline.strip_prefix('[').unwrap_or(&inline);
            let stripped = s1.strip_suffix(']').unwrap_or(s1);
            let items: Vec<String> = stripped
                .split(',')
                .map(unquote)
                .filter(|t| !t.is_empty())
                .collect();
            return if items.is_empty() { None } else { Some(items) };
        }

        // empty value → collect a following YAML block list (`  - item`).
        let mut items = Vec::new();
        for line2 in &lines[i + 1..] {
            if let Some(item) = BLOCK_ITEM_RE.captures(line2) {
                let value = unquote(&item[1]);
                if !value.is_empty() {
                    items.push(value);
                }
            } else if line2.trim().is_empty() || INDENTED_RE.is_match(line2) {
                continue;
            } else {
                break;
            }
        }
        return if items.is_empty() { None } else { Some(items) };
    }
    None
}

fn first_content_line(content: &str, fallback: &str) -> String {
    for line in content.split('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with("```") {
            continue;
        }
        return LIST_BULLET_RE.replace(trimmed, "").to_string();
    }
    fallback.to_string()
}

fn read_agents_dir(dir: &Path, source: AssetSource) -> Vec<LoadedAgent> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut agents = Vec::new();
    for entry in entries.flatten() {
        let file_path = entry.path();
        if file_path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        if !file_path.is_file() {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&file_path) else {
            continue;
        };
        let (frontmatter, content) = parse_frontmatter(&raw);
        let block = frontmatter_block(&raw);
        let file_stem = file_path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let agent_type = frontmatter
            .get("name")
            .filter(|s| !s.is_empty())
            .cloned()
            .unwrap_or(file_stem)
            .trim()
            .to_string();
        if agent_type.is_empty() {
            continue;
        }
        let persona = content.trim().to_string();
        let when_to_use = frontmatter
            .get("description")
            .filter(|s| !s.is_empty())
            .cloned()
            .unwrap_or_else(|| first_content_line(&content, &agent_type));
        agents.push(LoadedAgent {
            def: AgentDefinition {
                agent_type,
                when_to_use,
                tools: parse_tool_list(&block, "tools"),
                disallowed_tools: parse_tool_list(&block, "disallowedTools").unwrap_or_default(),
                model: frontmatter.get("model").filter(|s| !s.is_empty()).cloned(),
                system_prompt: persona,
            },
            source,
            file_path: file_path.to_string_lossy().into_owned(),
        });
    }
    agents
}

/// Load every user + project agent. Project after user so project wins on a
/// type clash (registry dedup is last-wins). Realpath dedup handles symlinks.
pub fn load_custom_agents() -> Vec<LoadedAgent> {
    let mut seen = std::collections::HashSet::new();
    let mut agents = Vec::new();
    for (dir, source) in agent_dirs() {
        for agent in read_agents_dir(&dir, source) {
            let file_id = std::fs::canonicalize(&agent.file_path)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| agent.file_path.clone());
            if seen.insert(file_id) {
                agents.push(agent);
            }
        }
    }
    agents
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_list_forms() {
        assert_eq!(
            parse_tool_list("tools: read_file, grep", "tools"),
            Some(vec!["read_file".to_string(), "grep".to_string()])
        );
        assert_eq!(
            parse_tool_list("tools: [read_file, grep]", "tools"),
            Some(vec!["read_file".to_string(), "grep".to_string()])
        );
        assert_eq!(
            parse_tool_list("tools:\n  - read_file\n  - grep", "tools"),
            Some(vec!["read_file".to_string(), "grep".to_string()])
        );
        assert_eq!(parse_tool_list("tools: *", "tools"), None);
        assert_eq!(parse_tool_list("tools: all", "tools"), None);
        assert_eq!(parse_tool_list("tools: none", "tools"), Some(vec![]));
        assert_eq!(parse_tool_list("tools:", "tools"), None); // empty → inherit all
        assert_eq!(parse_tool_list("other: x", "tools"), None); // key absent
    }

    #[test]
    fn block_list_stops_at_next_key() {
        let block = "tools:\n  - read_file\n  - grep\nmodel: fast";
        assert_eq!(
            parse_tool_list(block, "tools"),
            Some(vec!["read_file".to_string(), "grep".to_string()])
        );
    }
}
