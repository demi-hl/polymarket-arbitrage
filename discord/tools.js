const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const WORKSPACE = process.env.CORTANA_WORKSPACE || path.resolve(__dirname, '..');

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'shell',
      description: 'Execute a shell command. Use for installing packages, running builds, git operations, starting servers, or any terminal command. Commands run in the workspace directory.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute' },
          working_directory: { type: 'string', description: 'Subdirectory within workspace to run in (optional)' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file with the given content. Use for creating new files, writing code, configs, HTML pages, etc.',
      parameters: {
        type: 'object',
        properties: {
          filepath: { type: 'string', description: 'Path relative to workspace (e.g. "src/index.html", "package.json")' },
          content: { type: 'string', description: 'The full file content to write' }
        },
        required: ['filepath', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file. Use to inspect existing code, configs, or data files.',
      parameters: {
        type: 'object',
        properties: {
          filepath: { type: 'string', description: 'Path relative to workspace' }
        },
        required: ['filepath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and directories. Use to explore the project structure.',
      parameters: {
        type: 'object',
        properties: {
          directory: { type: 'string', description: 'Directory relative to workspace (default: root)' },
          recursive: { type: 'boolean', description: 'List recursively (default: false)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch content from a URL. Use for downloading resources, checking APIs, or reading documentation.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for information. Use to look up documentation, find solutions, or research topics.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' }
        },
        required: ['query']
      }
    }
  }
];

function resolvePath(filepath) {
  const resolved = path.resolve(WORKSPACE, filepath);
  if (!resolved.startsWith(WORKSPACE)) {
    throw new Error('Path escapes workspace boundary');
  }
  return resolved;
}

async function executeShell(args) {
  const cwd = args.working_directory
    ? resolvePath(args.working_directory)
    : WORKSPACE;

  try {
    const output = execSync(args.command, {
      cwd,
      timeout: 60000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      env: { ...process.env, PATH: process.env.PATH }
    });
    const trimmed = output.trim();
    return trimmed.length > 3000
      ? trimmed.slice(0, 1500) + '\n\n... (truncated) ...\n\n' + trimmed.slice(-1500)
      : trimmed || '(command completed with no output)';
  } catch (error) {
    const stderr = error.stderr?.trim() || '';
    const stdout = error.stdout?.trim() || '';
    return `Exit code ${error.status || 1}\n${stderr || stdout || error.message}`.slice(0, 3000);
  }
}

async function executeWriteFile(args) {
  const fullPath = resolvePath(args.filepath);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(fullPath, args.content, 'utf8');
  return `Wrote ${args.filepath} (${args.content.length} bytes)`;
}

async function executeReadFile(args) {
  const fullPath = resolvePath(args.filepath);
  if (!fs.existsSync(fullPath)) {
    return `File not found: ${args.filepath}`;
  }
  const content = fs.readFileSync(fullPath, 'utf8');
  return content.length > 4000
    ? content.slice(0, 2000) + '\n\n... (truncated) ...\n\n' + content.slice(-2000)
    : content;
}

async function executeListFiles(args) {
  const dir = args.directory ? resolvePath(args.directory) : WORKSPACE;
  if (!fs.existsSync(dir)) return `Directory not found: ${args.directory || '.'}`;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const lines = entries
    .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
    .map(e => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`)
    .slice(0, 100);

  if (args.recursive) {
    const result = execSync(`find . -maxdepth 3 -not -path '*/node_modules/*' -not -path '*/.git/*' -not -name '.*' | head -100`, {
      cwd: dir, encoding: 'utf8', timeout: 5000
    });
    return result.trim();
  }

  return lines.join('\n') || '(empty directory)';
}

async function executeWebFetch(args) {
  try {
    const response = await axios.get(args.url, {
      timeout: 10000,
      maxRedirects: 5,
      headers: { 'User-Agent': 'Cortana-Bot/1.0' },
      responseType: 'text'
    });
    const text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2);
    return text.length > 4000
      ? text.slice(0, 2000) + '\n\n... (truncated) ...\n\n' + text.slice(-2000)
      : text;
  } catch (error) {
    return `Fetch failed: ${error.message}`;
  }
}

async function executeWebSearch(args) {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) return 'Web search unavailable (BRAVE_API_KEY not set)';

  try {
    const response = await axios.get('https://api.search.brave.com/res/v1/web/search', {
      params: { q: args.query, count: 5 },
      headers: { 'X-Subscription-Token': apiKey, 'Accept': 'application/json' },
      timeout: 10000
    });

    const results = (response.data.web?.results || []).slice(0, 5);
    if (results.length === 0) return 'No results found.';

    return results.map((r, i) =>
      `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description || ''}`
    ).join('\n\n');
  } catch (error) {
    return `Search failed: ${error.message}`;
  }
}

const EXECUTORS = {
  shell: executeShell,
  write_file: executeWriteFile,
  read_file: executeReadFile,
  list_files: executeListFiles,
  web_fetch: executeWebFetch,
  web_search: executeWebSearch
};

async function executeTool(name, args) {
  const executor = EXECUTORS[name];
  if (!executor) return `Unknown tool: ${name}`;

  try {
    return await executor(typeof args === 'string' ? JSON.parse(args) : args);
  } catch (error) {
    return `Tool error: ${error.message}`;
  }
}

module.exports = { TOOL_DEFINITIONS, executeTool };
