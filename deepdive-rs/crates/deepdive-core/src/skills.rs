//! Skills subsystem. Faithful port of `src/skills.ts`.
//!
//! Loads `.deepdive/skills/<name>/SKILL.md` from user + project dirs, builds the
//! hidden listing system-reminder, and resolves a skill's body (with
//! `$ARGUMENTS` / `{{args}}` / `${DEEPDIVE_SKILL_DIR}` substitution) into a meta
//! message injected on `/skill`.

use crate::types::Message;
use crate::workspace::original_cwd;
use regex::Regex;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::LazyLock;

pub const SKILL_LISTING_MARKER: &str = "<deepdive-skill-listing>";
const SKILL_CONTENT_MARKER: &str = "<deepdive-skill>";
const SKILL_COMMAND_MARKER: &str = "<deepdive-skill-command>";
const MAX_LISTING_DESC_CHARS: usize = 250;
const DEFAULT_LISTING_CHAR_BUDGET: usize = 8_000;

static FRONTMATTER_LINE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([A-Za-z0-9_-]+):\s*(.*)$").unwrap());
static ARGS_BRACE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{\{\s*args\s*\}\}").unwrap());
static LIST_BULLET_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[-*]\s+").unwrap());

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub when_to_use: Option<String>,
    pub content: String,
    pub dir: String,
    pub file_path: String,
    pub source: AssetSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetSource {
    User,
    Project,
}

impl AssetSource {
    pub fn as_str(self) -> &'static str {
        match self {
            AssetSource::User => "user",
            AssetSource::Project => "project",
        }
    }
}

fn unquote(value: &str) -> String {
    let v = value.trim();
    if (v.starts_with('"') && v.ends_with('"') && v.len() >= 2)
        || (v.starts_with('\'') && v.ends_with('\'') && v.len() >= 2)
    {
        v[1..v.len() - 1].to_string()
    } else {
        v.to_string()
    }
}

/// Parse `---`-delimited frontmatter; returns (frontmatter map, content body).
pub fn parse_frontmatter(raw: &str) -> (HashMap<String, String>, String) {
    if !raw.starts_with("---") {
        return (HashMap::new(), raw.to_string());
    }
    let Some(rel) = raw[3..].find("\n---") else {
        return (HashMap::new(), raw.to_string());
    };
    let end = 3 + rel;
    let body = raw[3..end].trim();
    let content = strip_leading_fence(&raw[end..]);

    let mut frontmatter = HashMap::new();
    for line in body.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(caps) = FRONTMATTER_LINE_RE.captures(line) {
            let key = caps[1].to_string();
            let value = unquote(&caps[2]);
            frontmatter.insert(key, value);
        }
    }
    (frontmatter, content)
}

/// Strip a leading `\n---\r?\n?` (the regex `^\n---\r?\n?`).
fn strip_leading_fence(s: &str) -> String {
    let Some(t) = s.strip_prefix("\n---") else {
        return s.to_string();
    };
    let t = t.strip_prefix('\r').unwrap_or(t);
    let t = t.strip_prefix('\n').unwrap_or(t);
    t.to_string()
}

fn first_markdown_description(content: &str, fallback: &str) -> String {
    for line in content.split('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with("```") {
            continue;
        }
        return LIST_BULLET_RE.replace(trimmed, "").to_string();
    }
    fallback.to_string()
}

fn asset_dirs() -> Vec<(PathBuf, AssetSource)> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default();
    vec![
        (home.join(".deepdive").join("skills"), AssetSource::User),
        (
            original_cwd().join(".deepdive").join("skills"),
            AssetSource::Project,
        ),
    ]
}

fn read_skills_dir(dir: &std::path::Path, source: AssetSource) -> Vec<Skill> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut skills = Vec::new();
    for entry in entries.flatten() {
        let skill_dir = entry.path();
        let skill_file = skill_dir.join("SKILL.md");
        if !skill_dir.is_dir() || !skill_file.exists() {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&skill_file) else {
            continue;
        };
        let (frontmatter, content) = parse_frontmatter(&raw);
        let name = skill_dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let description = frontmatter
            .get("description")
            .filter(|s| !s.is_empty())
            .cloned()
            .unwrap_or_else(|| first_markdown_description(&content, &name));
        skills.push(Skill {
            name,
            description,
            when_to_use: frontmatter.get("when_to_use").cloned(),
            content,
            dir: skill_dir.to_string_lossy().into_owned(),
            file_path: skill_file.to_string_lossy().into_owned(),
            source,
        });
    }
    skills
}

pub fn load_skills() -> Vec<Skill> {
    let mut seen = std::collections::HashSet::new();
    let mut skills = Vec::new();
    for (dir, source) in asset_dirs() {
        for skill in read_skills_dir(&dir, source) {
            let file_id = std::fs::canonicalize(&skill.file_path)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| skill.file_path.clone());
            if seen.insert(file_id) {
                skills.push(skill);
            }
        }
    }
    skills
}

fn listing_description(skill: &Skill) -> String {
    let desc = match &skill.when_to_use {
        Some(w) => format!("{} - {w}", skill.description),
        None => skill.description.clone(),
    };
    if desc.chars().count() > MAX_LISTING_DESC_CHARS {
        let head: String = desc.chars().take(MAX_LISTING_DESC_CHARS - 1).collect();
        format!("{head}...")
    } else {
        desc
    }
}

pub fn format_skill_listing(skills: &[Skill], char_budget: usize) -> String {
    if skills.is_empty() {
        return String::new();
    }
    let mut used = 0usize;
    let mut kept: Vec<String> = Vec::new();
    for skill in skills {
        let line = format!("- {}: {}", skill.name, listing_description(skill));
        let next = used + line.len() + if kept.is_empty() { 0 } else { 1 };
        if next > char_budget {
            break;
        }
        used = next;
        kept.push(line);
    }
    kept.join("\n")
}

fn meta_user(content: String) -> Message {
    let mut m = Message::user(content);
    m.meta = true;
    m
}

pub fn make_skill_listing_message() -> Option<Message> {
    let listing = format_skill_listing(&load_skills(), DEFAULT_LISTING_CHAR_BUDGET);
    if listing.is_empty() {
        return None;
    }
    Some(meta_user(format!(
        "<system-reminder>\n{SKILL_LISTING_MARKER}\nThe following skills are available through the skill tool. Call the skill tool before answering when a listed skill matches the task.\n\n{listing}\n</system-reminder>"
    )))
}

pub fn is_skill_listing_message(msg: &Message) -> bool {
    msg.role == crate::types::Role::User && msg.meta && msg.content.contains(SKILL_LISTING_MARKER)
}

pub fn make_skill_command_message(skill: &Skill, args: &str) -> Message {
    let args_part = if args.is_empty() {
        String::new()
    } else {
        format!("\n<command-args>{args}</command-args>")
    };
    meta_user(format!(
        "{SKILL_COMMAND_MARKER}\n<command-name>/{}</command-name>{args_part}\n</deepdive-skill-command>",
        skill.name
    ))
}

/// Apply skill substitutions: `$ARGUMENTS`, `{{ args }}`, `${DEEPDIVE_SKILL_DIR}`.
fn apply_substitutions(content: &str, args: &str, skill_dir: &str) -> String {
    let s = content.replace("$ARGUMENTS", args);
    let s = ARGS_BRACE_RE.replace_all(&s, args).into_owned();
    s.replace("${DEEPDIVE_SKILL_DIR}", skill_dir)
}

// One-off return value (never stored in bulk), so the size skew is irrelevant.
#[allow(clippy::large_enum_variant)]
pub enum ResolveSkill {
    Ok { message: Message, skill: Skill },
    Err(String),
}

pub fn resolve_skill(name: &str, args: &str) -> ResolveSkill {
    let normalized = name.trim().trim_start_matches('/');
    if normalized.is_empty() {
        return ResolveSkill::Err("Error: skill is required.".to_string());
    }
    let Some(skill) = load_skills().into_iter().find(|s| s.name == normalized) else {
        return ResolveSkill::Err(format!("Error: unknown skill \"{normalized}\"."));
    };
    let skill_dir = skill.dir.replace('\\', "/");
    let final_content = apply_substitutions(&skill.content, args, &skill_dir);
    let message = meta_user(format!(
        "{SKILL_CONTENT_MARKER} name=\"{}\" source=\"{}\">\nBase directory for this skill: {}\n\n{final_content}\n</deepdive-skill>",
        skill.name,
        skill.source.as_str(),
        skill.dir
    ));
    ResolveSkill::Ok { message, skill }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(name: &str, desc: &str, when: Option<&str>) -> Skill {
        Skill {
            name: name.into(),
            description: desc.into(),
            when_to_use: when.map(String::from),
            content: String::new(),
            dir: "/d".into(),
            file_path: "/d/SKILL.md".into(),
            source: AssetSource::User,
        }
    }

    #[test]
    fn parse_frontmatter_basic() {
        let raw = "---\nname: commit\ndescription: \"make a commit\"\n---\nBody here\nmore";
        let (fm, content) = parse_frontmatter(raw);
        assert_eq!(fm.get("name").map(String::as_str), Some("commit"));
        assert_eq!(
            fm.get("description").map(String::as_str),
            Some("make a commit")
        );
        assert_eq!(content, "Body here\nmore");
    }

    #[test]
    fn parse_frontmatter_no_frontmatter() {
        let (fm, content) = parse_frontmatter("just content\nno fm");
        assert!(fm.is_empty());
        assert_eq!(content, "just content\nno fm");
    }

    #[test]
    fn format_listing_and_truncation() {
        let s = vec![
            skill("a", "does A", Some("when A")),
            skill("b", "does B", None),
        ];
        let out = format_skill_listing(&s, 8000);
        assert_eq!(out, "- a: does A - when A\n- b: does B");
        // budget smaller than the first line (len 20) → nothing fits
        assert_eq!(format_skill_listing(&s, 12), "");
    }

    #[test]
    fn substitutions_apply() {
        let c = "Run with $ARGUMENTS and {{ args }} in ${DEEPDIVE_SKILL_DIR}";
        assert_eq!(
            apply_substitutions(c, "X", "/skills/foo"),
            "Run with X and X in /skills/foo"
        );
    }

    #[test]
    fn listing_message_marker_roundtrip() {
        let msg = meta_user(format!(
            "<system-reminder>\n{SKILL_LISTING_MARKER}\n...\n</system-reminder>"
        ));
        assert!(is_skill_listing_message(&msg));
        assert!(!is_skill_listing_message(&Message::user("plain")));
    }

    #[test]
    fn command_message_format() {
        let s = skill("commit", "d", None);
        let m = make_skill_command_message(&s, "-m hi");
        assert!(m.meta);
        assert!(m.content.contains("<command-name>/commit</command-name>"));
        assert!(m.content.contains("<command-args>-m hi</command-args>"));
        let m2 = make_skill_command_message(&s, "");
        assert!(!m2.content.contains("command-args"));
    }
}
