// Claude Code hook, added only to sessions started by VibeCMD (via --settings).
// Tells VibeCMD two things about the pane it runs in:
//  - which chat it's on (SessionStart fires on startup, /resume and /clear),
//    so a restart reopens the right one;
//  - whether Claude is busy (UserPromptSubmit) or done (Stop), so closing an
//    idle pane doesn't need a confirmation.
// Must print nothing: SessionStart hook output is added to Claude's context.
const fs = require('fs');

const target = process.env.VIBECMD_SESSION_FILE;
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  if (!target) return;
  try {
    const { session_id: sessionId, hook_event_name: event } = JSON.parse(input);
    if (!sessionId) return;
    const busy = event === 'UserPromptSubmit';
    // Write-then-rename so VibeCMD never reads a half-written file.
    fs.writeFileSync(`${target}.tmp`, JSON.stringify({ sessionId, event, busy, at: Date.now() }));
    fs.renameSync(`${target}.tmp`, target);
  } catch {
    // Never break the Claude session over this.
  }
});
