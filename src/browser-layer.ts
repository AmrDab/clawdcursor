/**
 * Browser Layer — Layer 0 in the pipeline.
 *
 * Uses Playwright to control the browser directly via CDP.
 * No screenshots, no coordinate guessing, no 4K scaling issues.
 *
 * Two modes:
 * 1. Connect to existing Chrome (via CDP) — uses user's profiles, cookies, sessions
 * 2. Launch Playwright Chromium — clean browser, no profile picker
 *
 * Falls through to Layer 1+ when:
 * - Task is not browser-related
 * - Browser connection fails
 * - Task requires non-browser desktop interaction
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { ClawdConfig, StepResult } from './types';
import type { PipelineConfig } from './providers';

const CDP_PORT = 9222;

interface BrowserAction {
  action: string;
  url?: string;
  selector?: string;
  text?: string;
  key?: string;
  description: string;
}

interface BrowserResult {
  handled: boolean;
  success?: boolean;
  steps?: StepResult[];
  description?: string;
}

export class BrowserLayer {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private config: ClawdConfig;
  private pipelineConfig: PipelineConfig;
  private connected = false;

  constructor(config: ClawdConfig, pipelineConfig: PipelineConfig) {
    this.config = config;
    this.pipelineConfig = pipelineConfig;
  }

  /**
   * Detect if a task is browser-related.
   */
  static isBrowserTask(task: string): boolean {
    const browserPatterns = [
      /\b(chrome|firefox|browser|edge|safari)\b/i,
      /\b(navigate|browse|go to|open|visit)\b.*\b(url|http|www\.|\.com|\.org|\.net|\.io|\.dev|\.ai)\b/i,
      /\b(url|http|www\.|\.com|\.org|\.net|\.io|\.dev|\.ai)\b.*\b(navigate|browse|go to|open|visit)\b/i,
      /\bhttps?:\/\//i,
      /\b(google|github|youtube|twitter|reddit|hackernews|hacker news|ycombinator|stackoverflow)\b/i,
      /\b(search the web|web search|look up online|search online)\b/i,
      /\b(new tab|address bar|bookmark|download page)\b/i,
    ];
    return browserPatterns.some(p => p.test(task));
  }

  /**
   * Detect if a URL/title indicates a login/sign-in page.
   * Used to fall through to CDPDriver which uses the real browser with cookies.
   */
  static isLoginPage(url: string, title: string): boolean {
    const lowerUrl = url.toLowerCase();
    const lowerTitle = title.toLowerCase();

    // URL-based detection
    const loginUrlPatterns = [
      /accounts\.google\.com/,
      /login\.microsoftonline\.com/,
      /login\.live\.com/,
      /signin/i,
      /sign-in/i,
      /\/login(\?|\/|$)/i,
      /\/auth(\?|\/|$)/i,
      /\/oauth/i,
      /sso\./i,
      /cas\..*\/login/i,
      /id\.apple\.com/,
      /facebook\.com\/login/,
      /github\.com\/login/,
      /gitlab\.com\/(users\/sign_in|oauth)/,
    ];

    for (const pattern of loginUrlPatterns) {
      if (pattern.test(lowerUrl)) return true;
    }

    // Title-based detection
    const loginTitlePatterns = [
      /sign\s*in/i,
      /log\s*in/i,
      /authenticate/i,
      /create.*account/i,
      /enter your (password|email|credentials)/i,
      /verify your identity/i,
      /two.factor/i,
      /2fa/i,
    ];

    for (const pattern of loginTitlePatterns) {
      if (pattern.test(lowerTitle)) return true;
    }

    return false;
  }

  /**
   * Try to connect to an existing Chrome instance via CDP.
   * User must launch Chrome with: chrome.exe --remote-debugging-port=9222
   */
  async connectToExistingChrome(): Promise<boolean> {
    try {
      this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`, {
        timeout: 3000,
      });
      const contexts = this.browser.contexts();
      if (contexts.length > 0) {
        this.context = contexts[0];
        const pages = this.context.pages();
        this.page = pages.length > 0 ? pages[pages.length - 1] : await this.context.newPage();
      } else {
        this.context = await this.browser.newContext();
        this.page = await this.context.newPage();
      }
      this.connected = true;
      console.log(`   🌐 Connected to existing Chrome via CDP (port ${CDP_PORT})`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Launch a new Playwright-managed Chromium instance.
   */
  async launchBrowser(): Promise<boolean> {
    try {
      this.browser = await chromium.launch({
        headless: false,
        args: [
          '--start-maximized',
          '--disable-blink-features=AutomationControlled',
        ],
      });
      this.context = await this.browser.newContext({
        viewport: null, // Use full window size
      });
      this.page = await this.context.newPage();
      this.connected = true;
      console.log(`   🌐 Launched Playwright Chromium`);
      return true;
    } catch (e) {
      console.log(`   ❌ Failed to launch browser: ${e}`);
      return false;
    }
  }

  /**
   * Ensure we have a browser connection. Try CDP first, then launch.
   */
  async ensureConnected(): Promise<boolean> {
    if (this.connected && this.page) {
      try {
        await this.page.title(); // Quick health check
        return true;
      } catch {
        this.connected = false;
      }
    }
    // Try CDP first (uses user's Chrome with all profiles/cookies)
    if (await this.connectToExistingChrome()) return true;
    // Fall back to launching Playwright's Chromium
    if (await this.launchBrowser()) return true;
    return false;
  }

  /**
   * Execute a browser task using Playwright.
   * Uses the LLM to plan actions, then executes them natively.
   */
  async executeTask(task: string): Promise<BrowserResult> {
    if (!BrowserLayer.isBrowserTask(task)) {
      return { handled: false };
    }

    console.log(`   🌐 Browser Layer: attempting "${task}"`);

    if (!await this.ensureConnected()) {
      console.log(`   ⚠️ Browser Layer: no browser available, falling through`);
      return { handled: false };
    }

    const steps: StepResult[] = [];
    const startTime = Date.now();

    try {
      // Extract URL from task
      const url = this.extractUrl(task);
      
      if (url) {
        // Direct navigation
        console.log(`   🌐 Navigating to: ${url}`);
        await this.page!.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        steps.push({
          action: 'navigate',
          description: `Navigated to ${url}`,
          success: true,
          timestamp: Date.now(),
        });

        // Wait for page to settle
        await this.page!.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        
        const title = await this.page!.title();
        const currentUrl = this.page!.url();
        console.log(`   ✅ Page loaded: "${title}"`);
        steps.push({
          action: 'verify',
          description: `Page loaded: "${title}" at ${currentUrl}`,
          success: true,
          timestamp: Date.now(),
        });

        // Login detection — if we landed on a sign-in page, fall through
        // so CDPDriver (which uses the real browser with cookies) can handle it
        if (BrowserLayer.isLoginPage(currentUrl, title)) {
          console.log(`   🔐 Login page detected — falling through to SmartInteraction/CDPDriver`);
          steps.push({
            action: 'login_detected',
            description: `Login page detected: "${title}" at ${currentUrl}`,
            success: false,
            timestamp: Date.now(),
          });
          return {
            handled: false,
            success: false,
            steps,
            description: `Login page detected at ${currentUrl}`,
          };
        }

        // Multi-step task detection — if the task involves more than navigation
        // (compose, send, type, click, fill, write, etc.), browser layer only did
        // the navigation part. Fall through to SmartInteraction for the rest.
        const actionWords = /\b(compose|send|type|click|fill|write|enter|submit|reply|forward|delete|create|add|edit|search for|upload|download|select|check|uncheck|toggle|drag|drop|scroll|copy|paste|save|print|attach)\b/i;
        if (actionWords.test(task)) {
          console.log(`   🧩 Multi-step task detected — navigation done, falling through to SmartInteraction`);
          return {
            handled: false,
            success: false,
            steps,
            description: `Navigated to ${url} but task requires more actions — handing off`,
          };
        }

        return {
          handled: true,
          success: true,
          steps,
          description: `Navigated to ${url} — page title: "${title}"`,
        };
      }

      // Search task — go to Google and search
      const searchQuery = this.extractSearchQuery(task);
      if (searchQuery) {
        console.log(`   🔍 Searching: "${searchQuery}"`);
        await this.page!.goto(`https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`, {
          waitUntil: 'domcontentloaded',
          timeout: 15000,
        });
        steps.push({
          action: 'search',
          description: `Searched Google for "${searchQuery}"`,
          success: true,
          timestamp: Date.now(),
        });

        return {
          handled: true,
          success: true,
          steps,
          description: `Searched Google for "${searchQuery}"`,
        };
      }

      // Generic browser task — open a new tab
      if (/\b(new tab|open (chrome|browser|edge))\b/i.test(task)) {
        this.page = await this.context!.newPage();
        steps.push({
          action: 'new_tab',
          description: 'Opened new browser tab',
          success: true,
          timestamp: Date.now(),
        });
        return {
          handled: true,
          success: true,
          steps,
          description: 'Opened new browser tab',
        };
      }

      // Can't handle this specific browser task natively — fall through
      console.log(`   ⚠️ Browser Layer: task too complex for direct handling, falling through`);
      return { handled: false };

    } catch (e: any) {
      console.log(`   ❌ Browser Layer error: ${e.message}`);
      steps.push({
        action: 'error',
        description: `Browser error: ${e.message}`,
        success: false,
        timestamp: Date.now(),
      });
      // Fall through to screenshot pipeline on error
      return { handled: false };
    }
  }

  /**
   * Extract a URL from a task description.
   */
  private extractUrl(task: string): string | null {
    // Explicit URL
    const urlMatch = task.match(/https?:\/\/[^\s"'<>]+/i);
    if (urlMatch) return urlMatch[0];

    // Domain patterns
    const domainMatch = task.match(/\b([\w-]+\.(com|org|net|io|dev|ai|co|app|xyz|gg|tv|me)(\/[\w\-./]*)?)\b/i);
    if (domainMatch) return `https://${domainMatch[1]}`;

    // Known site names — check AFTER domain extraction so explicit domains win
    const siteMap: Record<string, string> = {
      'google': 'https://www.google.com',
      'github': 'https://github.com',
      'youtube': 'https://www.youtube.com',
      'twitter': 'https://twitter.com',
      'x': 'https://x.com',
      'reddit': 'https://www.reddit.com',
      'hackernews': 'https://news.ycombinator.com',
      'hacker news': 'https://news.ycombinator.com',
      'stackoverflow': 'https://stackoverflow.com',
      'stack overflow': 'https://stackoverflow.com',
      'wikipedia': 'https://en.wikipedia.org',
      'linkedin': 'https://www.linkedin.com',
      'facebook': 'https://www.facebook.com',
      'instagram': 'https://www.instagram.com',
      'twitch': 'https://www.twitch.tv',
      'discord': 'https://discord.com',
      'npm': 'https://www.npmjs.com',
    };

    for (const [name, url] of Object.entries(siteMap)) {
      if (task.toLowerCase().includes(name)) return url;
    }

    return null;
  }

  /**
   * Extract a search query from a task.
   */
  private extractSearchQuery(task: string): string | null {
    const searchMatch = task.match(/\b(?:search|look up|find|google)\s+(?:for\s+)?["']?([^"']+?)["']?$/i);
    if (searchMatch) return searchMatch[1];
    
    const webSearchMatch = task.match(/\b(?:search the web|web search|search online)\s+(?:for\s+)?["']?([^"']+?)["']?$/i);
    if (webSearchMatch) return webSearchMatch[1];

    return null;
  }

  /**
   * Get current page info for context.
   */
  async getPageInfo(): Promise<{ url: string; title: string } | null> {
    if (!this.page || !this.connected) return null;
    try {
      return {
        url: this.page.url(),
        title: await this.page.title(),
      };
    } catch {
      return null;
    }
  }

  /**
   * Clean up browser resources.
   */
  async close(): Promise<void> {
    try {
      // Don't close CDP-connected browsers — they belong to the user
      if (this.browser && !this.browser.isConnected()) return;
      // Only close if we launched it ourselves
      if (this.browser && !(this.browser as any)._initializer?.wsEndpoint?.includes('127.0.0.1')) {
        await this.browser.close();
      }
    } catch {}
    this.browser = null;
    this.context = null;
    this.page = null;
    this.connected = false;
  }
}
