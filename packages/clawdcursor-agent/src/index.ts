/**
 * clawdcursor-agent: the optional developer add-on behind `clawdcursor task` and `clawdcursor logs`. clawdcursor core
 * loads it (same version as core) from ~/.clawdcursor/addons once the owner agreed to download it.
 */
export { runTask, resolveRunner, type CoreContext, type TaskOptions, type TaskResult } from './task';
export { runLogs, type LogsOptions } from './logs';
export { detectClaude, detectCodex, type CliStatus } from './detect';
export { readConfig, configPath, RUNNERS, type AgentConfig, type Runner } from './config';
export { ANTHROPIC_DEFAULT_MODEL } from './api';
