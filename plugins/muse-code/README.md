# Wind Tunnel in Muse Code

Muse Code finds skills in `.agents/skills/` (and `.claude/skills/`) and reads MCP servers
from `~/.config/muse/settings.json`. The skills are the same files as the Claude Code and
Codex plugin in [`../windtunnel`](../windtunnel).

1. Install the skills into your project, prefixed so they don't clash with other skills:

   ```sh
   windtunnel skills --out .agents/skills --prefix windtunnel-
   ```

   (or `muse skills install <path> --scope user` for each folder that command writes).

2. Add the MCP server to `~/.config/muse/settings.json` (merge with what is there; the file
   must keep `"schema_version": 1`):

   ```json
   {
     "schema_version": 1,
     "mcp_servers": {
       "windtunnel": { "transport": "stdio", "command": "windtunnel", "args": ["mcp"] }
     }
   }
   ```

3. In your app's folder: `muse`, then ask for the `windtunnel-init` skill, then
   `windtunnel-hunt checkout`.

Models: Muse Wonder for the main loop. Keep the Meta key in a shell of its own so it never
reaches other tools.
