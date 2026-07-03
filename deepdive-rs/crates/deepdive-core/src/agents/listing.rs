//! Available-agents listing as a hidden system-reminder (meta message), kept
//! OUT of the tool schema so the tools array stays prefix-cache-stable. Port of
//! `src/agents/listing.ts`.

use super::registry::{format_agent_line, get_all_agents};
use crate::types::{Message, Role};

pub const AGENT_LISTING_MARKER: &str = "<deepdive-agent-listing>";

pub fn make_agent_listing_message() -> Option<Message> {
    let agents = get_all_agents();
    if agents.is_empty() {
        return None;
    }
    let lines = agents
        .iter()
        .map(format_agent_line)
        .collect::<Vec<_>>()
        .join("\n");
    let mut m = Message::user(format!(
        "<system-reminder>\n{AGENT_LISTING_MARKER}\nAvailable subagent_type values for the agent tool — pass one as subagent_type (omit for general-purpose):\n\n{lines}\n\nCustom agents are loaded from .deepdive/agents/*.md (project and ~). Pass run_in_background:true to the agent tool to launch one in the background; you'll be notified when it finishes, so don't poll.\n</system-reminder>"
    ));
    m.meta = true;
    Some(m)
}

pub fn is_agent_listing_message(msg: &Message) -> bool {
    msg.role == Role::User && msg.meta && msg.content.contains(AGENT_LISTING_MARKER)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listing_includes_builtins_and_marker() {
        let msg = make_agent_listing_message().unwrap();
        assert!(msg.meta);
        assert!(msg.content.contains(AGENT_LISTING_MARKER));
        assert!(msg.content.contains("- general-purpose:"));
        assert!(msg.content.contains("- Explore:"));
        assert!(is_agent_listing_message(&msg));
        assert!(!is_agent_listing_message(&Message::user("plain")));
    }
}
