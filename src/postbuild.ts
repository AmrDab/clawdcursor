/**
 * Post-build script — runs after tsc.
 * Prints available commands.
 */

// Print available commands
console.log(`
🐾 Clawd Cursor installed! Available commands:

  clawdcursor install   Set up API key and configure pipeline
  clawdcursor doctor    Auto-detect and configure your AI
  clawdcursor start     Start the agent
  clawdcursor serve     Start tools-only server (no built-in LLM)
  clawdcursor mcp       Run as MCP tool server (for Claude Code, Cursor, etc.)
  clawdcursor task      Send a task
  clawdcursor stop      Stop the agent
  clawdcursor dashboard Open the web dashboard
  clawdcursor report    Send an error report to help improve the agent
  clawdcursor uninstall Remove all config and data
`);
