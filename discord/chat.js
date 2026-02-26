const axios = require('axios');
const { TOOL_DEFINITIONS, executeTool } = require('./tools');

const SYSTEM_PROMPT = `You are Cortana, a powerful AI coding assistant available through Discord. You can build websites, write code, run shell commands, manage files, search the web, and help with anything technical.

Capabilities (via tools):
- **shell**: Run any terminal command — npm, git, python, curl, docker, etc.
- **write_file**: Create or update files — code, configs, HTML, CSS, JS, etc.
- **read_file**: Read existing files to understand code
- **list_files**: Explore project structure
- **web_fetch**: Fetch URLs, APIs, documentation
- **web_search**: Search the web for info, docs, solutions

Personality:
- Confident and direct — get things done, explain what you did
- Use tools proactively. Don't just describe what to do — actually do it
- When building something, create all the files needed and verify it works
- Keep Discord messages concise but informative
- Use markdown formatting that works in Discord

Workspace: You operate in a project workspace. Files you create persist there.

When asked to build something:
1. Plan briefly
2. Create the files using write_file
3. Install dependencies with shell if needed
4. Verify it works
5. Tell the user what you built and how to use it`;

const MAX_TOOL_ROUNDS = 10;

class ChatEngine {
  constructor(config = {}) {
    this.providers = this.buildProviderChain(config);
    this.conversationHistory = new Map();
    this.maxHistoryPerUser = config.maxHistory || 30;
  }

  buildProviderChain(config) {
    const providers = [];

    if (config.moonshotApiKey || process.env.MOONSHOT_API_KEY) {
      providers.push({
        name: 'moonshot',
        baseUrl: config.moonshotBaseUrl || process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.ai/v1',
        apiKey: config.moonshotApiKey || process.env.MOONSHOT_API_KEY,
        model: config.moonshotModel || process.env.MOONSHOT_MODEL || 'kimi-k2.5'
      });
    }

    if (config.openaiApiKey || process.env.OPENAI_API_KEY) {
      providers.push({
        name: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: config.openaiApiKey || process.env.OPENAI_API_KEY,
        model: config.openaiModel || process.env.OPENAI_MODEL || 'gpt-4-turbo'
      });
    }

    if (config.ollamaBaseUrl || process.env.OLLAMA_BASE_URL) {
      providers.push({
        name: 'ollama',
        baseUrl: config.ollamaBaseUrl || process.env.OLLAMA_BASE_URL,
        apiKey: 'ollama',
        model: config.ollamaModel || process.env.OLLAMA_MODEL || 'qwen3:14b'
      });
    }

    return providers;
  }

  getHistory(userId) {
    if (!this.conversationHistory.has(userId)) {
      this.conversationHistory.set(userId, []);
    }
    return this.conversationHistory.get(userId);
  }

  addToHistory(userId, message) {
    const history = this.getHistory(userId);
    history.push(message);
    if (history.length > this.maxHistoryPerUser) {
      history.splice(0, history.length - this.maxHistoryPerUser);
    }
  }

  clearHistory(userId) {
    this.conversationHistory.delete(userId);
  }

  async callProvider(provider, messages, useTools = true) {
    const body = {
      model: provider.model,
      messages,
      max_tokens: 4096,
      temperature: 0.7
    };

    if (useTools) {
      body.tools = TOOL_DEFINITIONS;
    }

    const response = await axios.post(
      `${provider.baseUrl}/chat/completions`,
      body,
      {
        headers: {
          'Authorization': `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 60000
      }
    );

    return response.data;
  }

  async chat(userId, message, { onToolUse, onProgress } = {}) {
    this.addToHistory(userId, { role: 'user', content: message });

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...this.getHistory(userId)
    ];

    let lastError = null;

    for (const provider of this.providers) {
      try {
        const result = await this.agentLoop(provider, messages, {
          userId,
          onToolUse,
          onProgress
        });
        return result;
      } catch (error) {
        lastError = error;
        console.warn(`[Chat] ${provider.name} failed: ${error.message}, trying next...`);
      }
    }

    throw new Error(
      this.providers.length === 0
        ? 'No AI providers configured. Set MOONSHOT_API_KEY, OPENAI_API_KEY, or OLLAMA_BASE_URL in .env'
        : `All providers failed. Last error: ${lastError?.message}`
    );
  }

  async agentLoop(provider, messages, { userId, onToolUse, onProgress }) {
    let round = 0;
    const localMessages = [...messages];

    while (round < MAX_TOOL_ROUNDS) {
      round++;

      const data = await this.callProvider(provider, localMessages);
      const choice = data.choices?.[0];
      if (!choice) throw new Error('Empty response from model');

      const assistantMessage = choice.message;

      // If there are tool calls, execute them
      if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        localMessages.push(assistantMessage);

        for (const toolCall of assistantMessage.tool_calls) {
          const toolName = toolCall.function.name;
          let toolArgs;
          try {
            toolArgs = JSON.parse(toolCall.function.arguments);
          } catch {
            toolArgs = {};
          }

          if (onToolUse) {
            onToolUse(toolName, toolArgs);
          }

          console.log(`[Tool] ${toolName}: ${JSON.stringify(toolArgs).slice(0, 100)}`);
          const toolResult = await executeTool(toolName, toolArgs);

          localMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: toolResult
          });
        }

        if (onProgress) {
          onProgress(round, MAX_TOOL_ROUNDS);
        }

        continue;
      }

      // No tool calls — we have a final text response
      const reply = assistantMessage.content || assistantMessage.reasoning_content;
      if (!reply) throw new Error('Empty response from model');

      this.addToHistory(userId, { role: 'assistant', content: reply });
      return { reply, provider: provider.name, model: provider.model, toolRounds: round - 1 };
    }

    throw new Error(`Agent exceeded max tool rounds (${MAX_TOOL_ROUNDS})`);
  }
}

module.exports = ChatEngine;
