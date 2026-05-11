// Quick test script for the classifier.
// Usage: node test-classifier.mjs

// Simulate the heuristic logic without full app boot.
const patterns = {
  block: [
    "rm -rf /",
    "mkfs.ext4 /dev/sda",
    "dd if=/dev/zero of=/dev/sda",
    "git push --force origin main",
  ],
  allow: [
    "npm test",
    "git status",
    "rm -rf node_modules",
    "ls -la",
    "echo hello",
  ],
  ask: [
    "docker rm -f $(docker ps -aq)",
    "terraform apply",
    "kubectl delete pod prod-*",
  ],
};

function heuristicClassify(cmd) {
  cmd = cmd.trim();
  if (/\brm\s+-rf\s+\//.test(cmd) || /\brm\s+-rf\s+~/.test(cmd)) return "block";
  if (/\b(mkfs|dd\s+if=|mkswap|fdisk)/.test(cmd)) return "block";
  if (/\bchmod\s+777\s+\//.test(cmd)) return "block";
  if (/\bgit\s+push\s+(-f|--force)\s+(origin\s+)?(main|master)\b/.test(cmd)) return "block";
  if (/^rm\s+-rf\s+(node_modules|\.\/build|build|dist|\.next|\.cache|__pycache__)/.test(cmd)) return "allow";
  if (/^(npm|yarn|pnpm|pip|poetry|cargo|go)\s+(install|test|build|lint|run|add)\b/.test(cmd)) return "allow";
  if (/^(git\s+(status|log|diff|branch|add|commit|checkout|stash|restore|push\s+(origin\s+)?[a-z]))/.test(cmd)) return "allow";
  if (/^(ls|cat|head|tail|grep|find|echo|mkdir|cp|mv|node|python)/.test(cmd)) return "allow";
  return "ask";
}

console.log("=== Block ===\n");
for (const c of patterns.block) {
  console.log(`  ${c.padEnd(45)} → ${heuristicClassify(c)}`);
}

console.log("\n=== Allow ===\n");
for (const c of patterns.allow) {
  console.log(`  ${c.padEnd(45)} → ${heuristicClassify(c)}`);
}

console.log("\n=== Ask ===\n");
for (const c of patterns.ask) {
  console.log(`  ${c.padEnd(45)} → ${heuristicClassify(c)}`);
}
