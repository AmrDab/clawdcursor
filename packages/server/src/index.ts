/**
 * @clawd-cursor/server
 * 
 * Backend server — WebSocket IPC to overlay, REST API for
 * external integrations, orchestrates all modules.
 * 
 * TODO:
 * - [ ] Express REST API
 * - [ ] WebSocket server for overlay communication
 * - [ ] LLM bridge (OpenClaw integration / direct API)
 * - [ ] Task queue management
 * - [ ] Config system
 * - [ ] Process lifecycle management
 */

import { DEFAULT_CONFIG } from '@clawd-cursor/shared';

const config = DEFAULT_CONFIG;

console.log(`🐾 Clawd Cursor Server starting on ${config.server.host}:${config.server.port}`);

// TODO: Initialize modules and start server
