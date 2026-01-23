# Plan: Add `do` Command to agent-browser

## Goal

Add an AI-powered `do` command to agent-browser that executes natural language instructions with context isolation. The AI agent's perception of the page (snapshots, screenshots) stays within its own context—callers receive only a summary.

```bash
# Current: caller must orchestrate each step
agent-browser open https://example.com
agent-browser snapshot -i          # Returns full tree to caller
agent-browser click @e2            # Caller decides what to click
agent-browser fill @e3 "test"      # Caller decides what to fill

# New: AI agent handles orchestration internally
agent-browser do "log in with test@example.com and password 'secret'"
# Returns: { "success": true, "summary": "Logged in successfully. Dashboard now visible." }
```

## Repository

Fork from: https://github.com/vercel-labs/agent-browser

License: Apache-2.0 (allows modification and redistribution)

## Prerequisites

- Node.js 20+
- pnpm
- Rust toolchain (for native CLI builds, optional for MVP)
- Anthropic API key

## Implementation Steps

### Step 1: Fork and Setup

```bash
git clone https://github.com/vercel-labs/agent-browser.git
cd agent-browser
pnpm install
pnpm build

# Verify it works
pnpm dev &  # Start daemon
npx agent-browser open https://example.com
npx agent-browser snapshot -i
npx agent-browser close
```

### Step 2: Add Anthropic SDK Dependency

```bash
pnpm add @anthropic-ai/sdk
```

Update `package.json` to include the new dependency.

### Step 3: Create BrowserAgent Class

Create `src/browser-agent.ts`:

```typescript
import Anthropic from '@anthropic-ai/sdk';
import type { BrowserManager } from './browser-manager';

interface AgentResult {
  success: boolean;
  summary: string;
  turns: number;
}

interface AgentConfig {
  model?: string;
  maxTurns?: number;
  timeout?: number;
}

const DEFAULT_CONFIG: Required<AgentConfig> = {
  model: 'claude-sonnet-4-20250514',
  maxTurns: 15,
  timeout: 120000,
};

const SYSTEM_PROMPT = `You are a browser automation agent. You control a web browser to complete tasks.

Available tools:
- snapshot: Get the current page's interactive elements with refs (@e1, @e2, etc.)
- click: Click an element by ref (e.g., @e3)
- fill: Fill an input field by ref with a value
- type: Type text into an element (appends, doesn't clear)
- press: Press a key (Enter, Tab, etc.)
- scroll: Scroll the page (up, down, left, right)
- wait: Wait for a condition or time
- done: Signal task completion with a summary

Workflow:
1. Use snapshot to see what's on the page
2. Identify the relevant elements by their refs
3. Use click, fill, type, press to interact
4. Use snapshot again if the page changes
5. Call done with a brief summary when finished

Be efficient:
- Don't snapshot more than necessary
- Combine related actions when possible
- If something fails, try an alternative approach
- If stuck after 3 attempts, call done with success=false

Keep summaries concise - the caller only sees your final summary, not your reasoning.`;

export class BrowserAgent {
  private client: Anthropic;
  private browser: BrowserManager;
  private config: Required<AgentConfig>;

  constructor(browser: BrowserManager, config?: AgentConfig) {
    this.client = new Anthropic();
    this.browser = browser;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async execute(instruction: string): Promise<AgentResult> {
    const tools: Anthropic.Tool[] = [
      {
        name: 'snapshot',
        description: 'Get interactive elements on the current page with refs (@e1, @e2, etc.)',
        input_schema: {
          type: 'object' as const,
          properties: {
            fullPage: {
              type: 'boolean',
              description: 'Include non-interactive elements (default: false)',
            },
          },
          required: [],
        },
      },
      {
        name: 'click',
        description: 'Click an element by ref or selector',
        input_schema: {
          type: 'object' as const,
          properties: {
            target: {
              type: 'string',
              description: 'Element ref (@e1) or CSS selector',
            },
          },
          required: ['target'],
        },
      },
      {
        name: 'fill',
        description: 'Clear an input and fill with new value',
        input_schema: {
          type: 'object' as const,
          properties: {
            target: {
              type: 'string',
              description: 'Element ref (@e1) or CSS selector',
            },
            value: {
              type: 'string',
              description: 'Value to fill',
            },
          },
          required: ['target', 'value'],
        },
      },
      {
        name: 'type',
        description: 'Type text into an element (appends to existing)',
        input_schema: {
          type: 'object' as const,
          properties: {
            target: {
              type: 'string',
              description: 'Element ref (@e1) or CSS selector',
            },
            text: {
              type: 'string',
              description: 'Text to type',
            },
          },
          required: ['target', 'text'],
        },
      },
      {
        name: 'press',
        description: 'Press a key (Enter, Tab, Escape, etc.)',
        input_schema: {
          type: 'object' as const,
          properties: {
            key: {
              type: 'string',
              description: 'Key to press (e.g., Enter, Tab, Control+a)',
            },
          },
          required: ['key'],
        },
      },
      {
        name: 'scroll',
        description: 'Scroll the page',
        input_schema: {
          type: 'object' as const,
          properties: {
            direction: {
              type: 'string',
              enum: ['up', 'down', 'left', 'right'],
              description: 'Scroll direction',
            },
            amount: {
              type: 'number',
              description: 'Pixels to scroll (default: 500)',
            },
          },
          required: ['direction'],
        },
      },
      {
        name: 'wait',
        description: 'Wait for a condition or time',
        input_schema: {
          type: 'object' as const,
          properties: {
            ms: {
              type: 'number',
              description: 'Milliseconds to wait',
            },
            selector: {
              type: 'string',
              description: 'Wait for selector to appear',
            },
          },
          required: [],
        },
      },
      {
        name: 'done',
        description: 'Signal task completion',
        input_schema: {
          type: 'object' as const,
          properties: {
            success: {
              type: 'boolean',
              description: 'Whether the task succeeded',
            },
            summary: {
              type: 'string',
              description: 'Brief summary of what was accomplished',
            },
          },
          required: ['success', 'summary'],
        },
      },
    ];

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: instruction },
    ];

    let turns = 0;

    while (turns < this.config.maxTurns) {
      turns++;

      const response = await this.client.messages.create({
        model: this.config.model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });

      // Process tool uses
      const toolUses = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
      );

      if (toolUses.length === 0) {
        // No tool calls, model finished
        const textBlock = response.content.find(
          (block): block is Anthropic.TextBlock => block.type === 'text'
        );
        return {
          success: true,
          summary: textBlock?.text || 'Completed',
          turns,
        };
      }

      // Execute tools and collect results
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolUse of toolUses) {
        // Check for done signal
        if (toolUse.name === 'done') {
          const input = toolUse.input as { success: boolean; summary: string };
          return {
            success: input.success,
            summary: input.summary,
            turns,
          };
        }

        // Execute tool
        const result = await this.executeTool(toolUse.name, toolUse.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result,
        });
      }

      // Add assistant message and tool results to history
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    }

    // Max turns exceeded
    return {
      success: false,
      summary: `Task incomplete after ${this.config.maxTurns} turns`,
      turns,
    };
  }

  private async executeTool(name: string, input: unknown): Promise<string> {
    const args = input as Record<string, unknown>;

    try {
      switch (name) {
        case 'snapshot': {
          const result = await this.browser.snapshot({
            interactive: !args.fullPage,
          });
          return result.text;
        }

        case 'click': {
          await this.browser.click(args.target as string);
          return `Clicked ${args.target}`;
        }

        case 'fill': {
          await this.browser.fill(args.target as string, args.value as string);
          return `Filled ${args.target} with "${args.value}"`;
        }

        case 'type': {
          await this.browser.type(args.target as string, args.text as string);
          return `Typed "${args.text}" into ${args.target}`;
        }

        case 'press': {
          await this.browser.press(args.key as string);
          return `Pressed ${args.key}`;
        }

        case 'scroll': {
          const amount = (args.amount as number) || 500;
          await this.browser.scroll(args.direction as string, amount);
          return `Scrolled ${args.direction} ${amount}px`;
        }

        case 'wait': {
          if (args.ms) {
            await new Promise((resolve) => setTimeout(resolve, args.ms as number));
            return `Waited ${args.ms}ms`;
          }
          if (args.selector) {
            await this.browser.waitForSelector(args.selector as string);
            return `Element ${args.selector} appeared`;
          }
          return 'No wait condition specified';
        }

        default:
          return `Unknown tool: ${name}`;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error: ${message}`;
    }
  }
}
```

### Step 4: Add Command Handler to Daemon

Locate the command handler in `src/daemon.ts` (or wherever commands are routed).

Add the `do` command case:

```typescript
import { BrowserAgent } from './browser-agent';

// In the command handler switch statement, add:
case 'do': {
  const { instruction, config } = cmd;

  if (!instruction || typeof instruction !== 'string') {
    return { success: false, error: 'Missing instruction' };
  }

  const agent = new BrowserAgent(session.browser, config);

  try {
    const result = await agent.execute(instruction);
    return {
      success: result.success,
      data: {
        summary: result.summary,
        turns: result.turns,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}
```

### Step 5: Add CLI Command (Node.js Fallback)

Locate the CLI entry point for the Node.js fallback (likely `bin/agent-browser` or a script that handles commands when native binaries aren't available).

Add the `do` command:

```typescript
// Add to command definitions
program
  .command('do <instruction>')
  .description('Execute a natural language instruction using AI')
  .option('--model <model>', 'Model to use', 'claude-sonnet-4-20250514')
  .option('--max-turns <n>', 'Maximum agent turns', '15')
  .option('--json', 'Output as JSON')
  .action(async (instruction, options) => {
    const result = await sendCommand({
      type: 'do',
      instruction,
      config: {
        model: options.model,
        maxTurns: parseInt(options.maxTurns, 10),
      },
    });

    if (options.json) {
      console.log(JSON.stringify(result));
    } else if (result.success) {
      console.log(result.data.summary);
    } else {
      console.error('Error:', result.error);
      process.exit(1);
    }
  });
```

### Step 6: Update Rust CLI (Optional for MVP)

If you want native binary support, add to `cli/src/main.rs`:

```rust
// Add to command enum
Do {
    #[arg(help = "Natural language instruction")]
    instruction: String,
    #[arg(long, help = "Model to use")]
    model: Option<String>,
    #[arg(long, help = "Maximum turns")]
    max_turns: Option<u32>,
},

// Add to match handler
Command::Do { instruction, model, max_turns } => {
    let mut cmd = json!({
        "type": "do",
        "instruction": instruction
    });

    if model.is_some() || max_turns.is_some() {
        let mut config = json!({});
        if let Some(m) = model {
            config["model"] = json!(m);
        }
        if let Some(n) = max_turns {
            config["maxTurns"] = json!(n);
        }
        cmd["config"] = config;
    }

    send_command(&cmd.to_string())
}
```

### Step 7: Test

```bash
# Start daemon in dev mode
pnpm dev

# In another terminal:
export ANTHROPIC_API_KEY=sk-...

# Basic test
npx agent-browser open https://example.com
npx agent-browser do "click the 'More information' link"

# Form test
npx agent-browser open https://the-internet.herokuapp.com/login
npx agent-browser do "log in with username 'tomsmith' and password 'SuperSecretPassword!'"

# Search test
npx agent-browser open https://google.com
npx agent-browser do "search for 'playwright browser automation'"

# JSON output
npx agent-browser do "get the page title" --json
```

### Step 8: Add Environment Variable Support

Update the agent to respect environment variables:

```typescript
// In browser-agent.ts constructor
const DEFAULT_CONFIG: Required<AgentConfig> = {
  model: process.env.AGENT_BROWSER_MODEL || 'claude-sonnet-4-20250514',
  maxTurns: parseInt(process.env.AGENT_BROWSER_MAX_TURNS || '15', 10),
  timeout: parseInt(process.env.AGENT_BROWSER_TIMEOUT || '120000', 10),
};
```

## File Summary

| File | Action | Description |
|------|--------|-------------|
| `package.json` | Modify | Add `@anthropic-ai/sdk` dependency |
| `src/browser-agent.ts` | Create | New BrowserAgent class (~200 lines) |
| `src/daemon.ts` | Modify | Add `do` command handler (~20 lines) |
| `bin/agent-browser` or equivalent | Modify | Add `do` CLI command (~20 lines) |
| `cli/src/main.rs` | Modify (optional) | Add `do` command for native binary |

## Testing Checklist

- [ ] `do` command executes simple instructions
- [ ] Agent can navigate and click
- [ ] Agent can fill forms
- [ ] Agent handles errors gracefully
- [ ] Agent respects maxTurns limit
- [ ] `--json` output works
- [ ] Environment variables work
- [ ] Sessions are respected (agent operates in current session)

## Future Enhancements (Not MVP)

- Screenshot/vision support for the agent
- Streaming output during execution
- Evidence capture (screenshots at each step)
- Custom tool injection
- Retry strategies
- Cost tracking

## Notes for Claude Code

1. Start by reading the existing codebase structure, especially:
   - `src/daemon.ts` - how commands are routed
   - `src/browser-manager.ts` - available browser methods
   - `src/commands/` - how other commands are implemented

2. The BrowserManager class already has methods like:
   - `snapshot(options)` - returns accessibility tree
   - `click(selector)` - click element
   - `fill(selector, value)` - fill input
   - `type(selector, text)` - type text
   - `press(key)` - press key
   - `scroll(direction, amount)` - scroll page

   Use these directly rather than implementing new Playwright calls.

3. The snapshot method returns refs in format `@e1`, `@e2`, etc. These refs work as selectors in subsequent commands.

4. Keep the agent simple for MVP. The goal is to prove context isolation works, not to build a sophisticated agent.
