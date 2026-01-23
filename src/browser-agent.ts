import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { BrowserManager } from './browser.js';

export interface AgentResult {
  success: boolean;
  summary: string;
  turns: number;
}

export interface AgentConfig {
  model?: string;
  maxTurns?: number;
  timeout?: number;
}

const DEFAULT_CONFIG: Required<AgentConfig> = {
  model: process.env.AGENT_BROWSER_MODEL || 'sonnet',
  maxTurns: parseInt(process.env.AGENT_BROWSER_MAX_TURNS || '15', 10),
  timeout: parseInt(process.env.AGENT_BROWSER_TIMEOUT || '120000', 10),
};

const SYSTEM_PROMPT = `You are a browser automation agent. You control a web browser to complete tasks.

Available tools:
- browser_snapshot: Get the current page's interactive elements with refs (@e1, @e2, etc.)
- browser_click: Click an element by ref (e.g., @e3)
- browser_fill: Fill an input field by ref with a value
- browser_type: Type text into an element (appends, doesn't clear)
- browser_press: Press a key (Enter, Tab, etc.)
- browser_scroll: Scroll the page (up, down, left, right)
- browser_wait: Wait for a condition or time

Workflow:
1. Use browser_snapshot to see what's on the page
2. Identify the relevant elements by their refs
3. Use browser_click, browser_fill, browser_type, browser_press to interact
4. Use browser_snapshot again if the page changes
5. When finished, respond with a brief summary of what was accomplished

Be efficient:
- Don't snapshot more than necessary
- Combine related actions when possible
- If something fails, try an alternative approach
- If stuck after 3 attempts, explain what went wrong

Keep summaries concise - the caller only sees your final summary, not your reasoning.`;

export class BrowserAgent {
  private browser: BrowserManager;
  private config: Required<AgentConfig>;

  constructor(browser: BrowserManager, config?: AgentConfig) {
    this.browser = browser;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async execute(instruction: string): Promise<AgentResult> {
    // Create browser tools
    const browserTools = this.createBrowserTools();

    // Create an in-process MCP server with browser tools
    const browserServer = createSdkMcpServer({
      name: 'browser-tools',
      version: '1.0.0',
      tools: browserTools,
    });

    let turns = 0;
    let lastAssistantMessage = '';

    try {
      const result = query({
        prompt: instruction,
        options: {
          systemPrompt: SYSTEM_PROMPT,
          model: this.config.model,
          maxTurns: this.config.maxTurns,
          mcpServers: {
            'browser-tools': browserServer,
          },
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
        },
      });

      // Process the message stream
      for await (const message of result) {
        if (message.type === 'assistant') {
          turns++;
          // Extract text content from the assistant message
          const content = message.message.content as Array<{ type: string; text?: string }>;
          const textBlocks = content.filter(
            (block): block is { type: 'text'; text: string } => block.type === 'text'
          );
          if (textBlocks.length > 0) {
            lastAssistantMessage = textBlocks.map((b) => b.text).join('\n');
          }
        } else if (message.type === 'result') {
          if (message.subtype === 'success') {
            return {
              success: true,
              summary: message.result || lastAssistantMessage || 'Completed',
              turns: message.num_turns,
            };
          } else {
            const errorMsg = 'errors' in message ? message.errors.join(', ') : 'Unknown error';
            return {
              success: false,
              summary: errorMsg,
              turns: message.num_turns,
            };
          }
        }
      }

      // If we exit the loop without a result message
      return {
        success: true,
        summary: lastAssistantMessage || 'Completed',
        turns,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        summary: `Error: ${message}`,
        turns,
      };
    }
  }

  private createBrowserTools() {
    const browser = this.browser;

    return [
      tool(
        'browser_snapshot',
        'Get interactive elements on the current page with refs (@e1, @e2, etc.)',
        {
          fullPage: z
            .boolean()
            .optional()
            .describe('Include non-interactive elements (default: false)'),
        },
        async (args) => {
          const result = await browser.getSnapshot({
            interactive: !args.fullPage,
          });
          return { content: [{ type: 'text' as const, text: result.tree }] };
        }
      ),

      tool(
        'browser_click',
        'Click an element by ref or selector',
        {
          target: z.string().describe('Element ref (@e1) or CSS selector'),
        },
        async (args) => {
          const locator = browser.getLocator(args.target);
          await locator.click();
          return { content: [{ type: 'text' as const, text: `Clicked ${args.target}` }] };
        }
      ),

      tool(
        'browser_fill',
        'Clear an input and fill with new value',
        {
          target: z.string().describe('Element ref (@e1) or CSS selector'),
          value: z.string().describe('Value to fill'),
        },
        async (args) => {
          const locator = browser.getLocator(args.target);
          await locator.fill(args.value);
          return {
            content: [
              { type: 'text' as const, text: `Filled ${args.target} with "${args.value}"` },
            ],
          };
        }
      ),

      tool(
        'browser_type',
        'Type text into an element (appends to existing)',
        {
          target: z.string().describe('Element ref (@e1) or CSS selector'),
          text: z.string().describe('Text to type'),
        },
        async (args) => {
          const locator = browser.getLocator(args.target);
          await locator.pressSequentially(args.text);
          return {
            content: [{ type: 'text' as const, text: `Typed "${args.text}" into ${args.target}` }],
          };
        }
      ),

      tool(
        'browser_press',
        'Press a key (Enter, Tab, Escape, etc.)',
        {
          key: z.string().describe('Key to press (e.g., Enter, Tab, Control+a)'),
        },
        async (args) => {
          const page = browser.getPage();
          await page.keyboard.press(args.key);
          return { content: [{ type: 'text' as const, text: `Pressed ${args.key}` }] };
        }
      ),

      tool(
        'browser_scroll',
        'Scroll the page',
        {
          direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction'),
          amount: z.number().optional().describe('Pixels to scroll (default: 500)'),
        },
        async (args) => {
          const page = browser.getPage();
          const amount = args.amount || 500;

          let deltaX = 0;
          let deltaY = 0;
          switch (args.direction) {
            case 'up':
              deltaY = -amount;
              break;
            case 'down':
              deltaY = amount;
              break;
            case 'left':
              deltaX = -amount;
              break;
            case 'right':
              deltaX = amount;
              break;
          }

          await page.evaluate(`window.scrollBy(${deltaX}, ${deltaY})`);
          return {
            content: [{ type: 'text' as const, text: `Scrolled ${args.direction} ${amount}px` }],
          };
        }
      ),

      tool(
        'browser_wait',
        'Wait for a condition or time',
        {
          ms: z.number().optional().describe('Milliseconds to wait'),
          selector: z.string().optional().describe('Wait for selector to appear'),
        },
        async (args) => {
          const page = browser.getPage();
          if (args.ms) {
            await page.waitForTimeout(args.ms);
            return { content: [{ type: 'text' as const, text: `Waited ${args.ms}ms` }] };
          }
          if (args.selector) {
            await page.waitForSelector(args.selector);
            return {
              content: [{ type: 'text' as const, text: `Element ${args.selector} appeared` }],
            };
          }
          return { content: [{ type: 'text' as const, text: 'No wait condition specified' }] };
        }
      ),
    ];
  }
}
