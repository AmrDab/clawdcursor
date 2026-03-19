/**
 * Post-build script — runs after tsc.
 * Prints available commands.
 */

// Print available commands
console.log(`
🐾 Clawd Cursor built successfully! Available commands:

  clawdcursor consent   Accept desktop control permissions (required once)
  clawdcursor doctor    Auto-detect and configure your AI providers
  clawdcursor install   Set up API key + run doctor in one step
  clawdcursor start     Start the agent (consent + auto-setup on first run)
  clawdcursor serve     Start tools-only server (no built-in LLM)
  clawdcursor mcp       Run as MCP tool server (for Claude Code, Cursor, etc.)
  clawdcursor task      Send a task to the running agent
  clawdcursor stop      Stop the agent
  clawdcursor dashboard Open the web dashboard
  clawdcursor report    Send an error report to help improve the agent
  clawdcursor uninstall Remove all config and data

  Quick start:  clawdcursor start
  MCP mode:     clawdcursor mcp
`);
