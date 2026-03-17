/**
 * HTTP Tool Server — REST API for any AI model to discover and execute tools.
 *
 * Endpoints:
 *   GET  /tools           — Tool schemas (OpenAI function-calling format by default)
 *   GET  /tools?format=raw — Raw tool definitions with categories
 *   POST /execute/:name   — Execute a tool by name
 *   GET  /docs            — Human-readable tool documentation
 *   GET  /health          — Server health check
 *
 * This is the model-agnostic interface. Any AI that can do function calling
 * (OpenAI, Anthropic, Google, Meta, Mistral, local models) can use this.
 */

import express from 'express';
import { getAllTools, toOpenAiFunctions, getTool, toJsonSchema } from './tools';
import type { ToolContext } from './tools';
import type { ToolDefinition } from './tools/types';
import { VERSION } from './version';

/** Validate request body against a tool's parameter schema. Returns error string or null. */
function validateParams(body: Record<string, unknown>, tool: ToolDefinition): string | null {
  const params = tool.parameters;
  for (const [name, def] of Object.entries(params)) {
    const value = body[name];
    if (def.required !== false && value === undefined) {
      return `Missing required parameter: "${name}"`;
    }
    if (value !== undefined) {
      const expected = def.type;
      const actual = typeof value;
      if (expected === 'number' && actual !== 'number') return `Parameter "${name}" must be a number, got ${actual}`;
      if (expected === 'string' && actual !== 'string') return `Parameter "${name}" must be a string, got ${actual}`;
      if (expected === 'boolean' && actual !== 'boolean') return `Parameter "${name}" must be a boolean, got ${actual}`;
    }
  }
  // Reject unknown parameters to catch typos
  for (const key of Object.keys(body)) {
    if (!(key in params)) {
      return `Unknown parameter: "${key}". Valid: ${Object.keys(params).join(', ') || '(none)'}`;
    }
  }
  return null;
}

export function createToolServer(ctx: ToolContext): express.Router {
  const router = express.Router();

  // ── Tool Discovery ──

  router.get('/tools', (_req, res) => {
    const tools = getAllTools();
    const format = _req.query.format as string;

    if (format === 'raw') {
      // Raw format with categories and full metadata
      res.json(tools.map(t => ({
        name: t.name,
        description: t.description,
        category: t.category,
        parameters: toJsonSchema(t.parameters),
      })));
    } else {
      // Default: OpenAI function-calling format (universal standard)
      res.json(toOpenAiFunctions(tools));
    }
  });

  // ── Tool Execution ──

  router.post('/execute/:name', async (req, res) => {
    const { name } = req.params;
    const tool = getTool(name);

    if (!tool) {
      return res.status(404).json({
        error: `Tool "${name}" not found`,
        available: getAllTools().map(t => t.name),
      });
    }

    try {
      const body = req.body || {};
      const validationError = validateParams(body, tool);
      if (validationError) {
        return res.status(400).json({ tool: name, text: validationError, isError: true });
      }
      const result = await tool.handler(body, ctx);

      // Build response
      const response: any = {
        tool: name,
        text: result.text,
      };
      if (result.image) {
        response.image = result.image;
      }
      if (result.isError) {
        response.isError = true;
        return res.status(400).json(response);
      }
      res.json(response);
    } catch (err: any) {
      res.status(500).json({
        tool: name,
        text: `Internal error: ${err.message}`,
        isError: true,
      });
    }
  });

  // ── Documentation ──

  router.get('/docs', (_req, res) => {
    const tools = getAllTools();
    const categories = new Map<string, typeof tools>();

    for (const t of tools) {
      const cat = categories.get(t.category) || [];
      cat.push(t);
      categories.set(t.category, cat);
    }

    let md = `# clawdcursor Tool API\n\n`;
    md += `**${tools.length} tools** for OS-level desktop automation.\n\n`;
    md += `## Endpoints\n\n`;
    md += `- \`GET /tools\` — Tool schemas (OpenAI function format)\n`;
    md += `- \`POST /execute/{name}\` — Execute a tool\n`;
    md += `- \`GET /docs\` — This page\n\n`;

    const categoryLabels: Record<string, string> = {
      perception: 'Perception (Screen Reading)',
      mouse: 'Mouse Actions',
      keyboard: 'Keyboard Actions',
      window: 'Window & App Management',
      clipboard: 'Clipboard',
      browser: 'Browser (CDP)',
      orchestration: 'Orchestration',
    };

    for (const [cat, catTools] of categories) {
      md += `## ${categoryLabels[cat] || cat}\n\n`;
      for (const t of catTools) {
        md += `### \`${t.name}\`\n`;
        md += `${t.description}\n\n`;
        const params = Object.entries(t.parameters);
        if (params.length > 0) {
          md += `| Parameter | Type | Required | Description |\n`;
          md += `|-----------|------|----------|-------------|\n`;
          for (const [pname, pdef] of params) {
            md += `| ${pname} | ${pdef.type} | ${pdef.required !== false ? 'yes' : 'no'} | ${pdef.description} |\n`;
          }
          md += `\n`;
        }
      }
    }

    res.type('text/markdown').send(md);
  });

  // ── Health ──

  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      version: VERSION,
      tools: getAllTools().length,
      platform: process.platform,
    });
  });

  return router;
}
