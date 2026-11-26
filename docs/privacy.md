# Privacy: what leaves your computer

TheFlashMaster has **no telemetry, analytics, crash reporting or usage pings**. It ships no tracking SDK, never
starts Electron's crash reporter, and `tests/invariants.test.ts` ("no telemetry, nothing sent in the background")
fails the build if one is added.

## What the app does to stay quiet

- **Nothing checks the network in the background by default.** Update checks (`updates.autoCheck`), downloads
  (`updates.autoDownload`), plugin update checks and Flash server submission polling (`marketplace.autoCheckUpdates`)
  and the Copilot credits timer (`usage.refreshMinutes`) are off until you turn them on.
- **Programs the app starts are told not to send telemetry.** Agent CLIs, MCP servers, npm/pip installs, checks,
  hooks and the terminal get the opt-out variables in `src/main/privacy.ts` (`DO_NOT_TRACK`, Claude Code's
  `DISABLE_TELEMETRY` / `DISABLE_ERROR_REPORTING` / `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, PowerShell, .NET, npm,
  pip, Next.js and more). A value you set yourself always wins.
- **OpenCode session sharing is disabled** in the clean config the app gives OpenCode (`share: "disabled"`).
- **The spell checker never downloads dictionaries** from Google (Linux); it reads `.bdic` files from
  `<data folder>/dictionaries` if you put any there.
- **Context7** (a cloud documentation service that receives the agents' library questions) is off by default.
- **HTML reports** render offline in a sandbox and cannot reach the network.

## What still goes out, and only when you use the feature

| Feature | Goes to | What is sent | When |
| --- | --- | --- | --- |
| Agent harnesses (Copilot, OpenCode, Cursor, Claude Code, Pi) | The AI provider you signed in to in that CLI | Your prompts, the files and tool output the agent reads | When an agent works. The model list is also refreshed once a day at start. |
| GitLab Duo | Your GitLab instance | Prompts and repository context | When a Duo agent works |
| Copilot credits meter | `api.github.com` (or `FLASH_GITHUB_API`) | Copilot's own sign-in token | After a Copilot turn in the app, and when you press refresh |
| IBM Jazz (EWM, DOORS Next, ETM) | Your Jazz servers | Your sign-in, the queries and changes agents make | When you or an agent uses the Jazz tools |
| Vector CANoe MCP, winIDEA, EXAM | Local programs (EXAM: the REST URL you configure) | Tool calls | When an agent uses those tools |
| Recommended MCP servers | npm registry / PyPI (or your mirror) | Package downloads | First start (`mcp.autoInstall`) or when enabled |
| Fetch / Playwright / Context7 MCP servers (off by default) | The pages or service they reach | What the agent asks for | When you enable them and an agent uses them |
| graphify | PyPI | Package download | First **Scan code** |
| App updates | Your Flash server, then the GitHub repository in `package.json` | The server/GitHub token, the app's version in the request | When you press **Check for updates** (or turn automatic checks on) |
| Flash server marketplace | Your Flash server | Your server token; plugins you submit | When you open/refresh the Marketplace or submit |
| Other marketplaces | The marketplace URLs you add | A plain GET of their index | When you refresh the Marketplace |
| Local embeddings | Ollama at `127.0.0.1:11434` by default | Memory text to embed | When you turn embeddings on |
| Links | Your browser | The link you clicked | When you click one |
