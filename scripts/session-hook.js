// Claude Code hook, added only to sessions started by VibeCMD (via --settings).
// Tells VibeCMD two things about the pane it runs in:
//  - which chat it's on (SessionStart fires on startup, /resume and /clear),
//    so a restart reopens the right one;
//  - whether Claude is busy (UserPromptSubmit) or done (Stop), so closing an
//    idle pane doesn't need a confirmation;
//  - which file Claude just edited (PostToolUse), for a linked editor pane.
// Must print nothing: SessionStart hook output is added to Claude's context.
const fs = require('fs');

const target = process.env.VIBECMD_SESSION_FILE;
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  if (!target) return;
  try {
    const { session_id: sessionId, hook_event_name: event, tool_input: tool } = JSON.parse(input);
    if (!sessionId) return;
    // Tools only run while Claude is working.
    const busy = event === 'UserPromptSubmit' || event === 'PostToolUse';
    const edited = event === 'PostToolUse' ? tool?.file_path || tool?.notebook_path || null : null;
    // Write-then-rename so VibeCMD never reads a half-written file.
    fs.writeFileSync(`${target}.tmp`, JSON.stringify({ sessionId, event, busy, edited, at: Date.now() }));
    fs.renameSync(`${target}.tmp`, target);
  } catch {
    // Never break the Claude session over this.
  }
});
