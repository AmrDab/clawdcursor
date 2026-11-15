/**
 * clawdcursor-doctor: the optional developer add-on behind `clawdcursor doctor --setup` (and the offer at the end of
 * `clawdcursor doctor`). clawdcursor core loads it, with clawdcursor-agent, once the owner agreed to download them.
 */
export { runSetup, TEST_TASK, type SetupContext, type AgentApi } from './setup';
export { writePrivateJson, restrictToOwner, icaclsArgs } from './store';
