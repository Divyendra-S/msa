# The Muse shell. Source it in a terminal of its own, never in the one you use with your own
# Claude Code or Codex login:
#
#   source scripts/muse-env.sh            Muse Code and Wind Tunnel on the Meta key
#   source scripts/muse-env.sh --claude   also Claude Code pointed at Muse (the backup host)
#
# The key: $MODEL_API_KEY if it is set, else the file ~/.config/windtunnel/meta-key (one line;
# chmod 600 it), else it asks. Nothing is written anywhere.
#
# In this shell Wind Tunnel's small decisions go to Muse Spark, the viewer's Run hunt starts
# Muse Code, and `pnpm bench` runs Muse Code, all billed to the Meta key. Kept apart, the key
# never reaches Anthropic or OpenAI, and your Claude or Codex requests never reach Meta.

# Sourced? zsh lets a script `return` at its top level, so it needs its own test.
if [ -n "${ZSH_VERSION:-}" ]; then
  case "${ZSH_EVAL_CONTEXT:-}" in *:file*) _wt_sourced=1 ;; *) _wt_sourced=0 ;; esac
elif (return 0 2>/dev/null); then
  _wt_sourced=1
else
  _wt_sourced=0
fi
if [ "$_wt_sourced" = 0 ]; then
  echo "muse-env.sh: source it (source scripts/muse-env.sh), don't run it" >&2
  exit 1
fi
unset _wt_sourced

_wt_claude=0
[ "${1:-}" = "--claude" ] && _wt_claude=1
_wt_key="${MODEL_API_KEY:-}"
_wt_file="${XDG_CONFIG_HOME:-$HOME/.config}/windtunnel/meta-key"
if [ -z "$_wt_key" ] && [ -f "$_wt_file" ]; then
  _wt_key="$(tr -d '[:space:]' < "$_wt_file")"
fi
if [ -z "$_wt_key" ]; then
  printf 'Meta API key (dev.meta.ai): '
  stty -echo 2>/dev/null
  read -r _wt_key
  stty echo 2>/dev/null
  echo
fi

if [ -z "$_wt_key" ]; then
  echo "muse-env.sh: no key, nothing changed" >&2
  unset _wt_claude _wt_key _wt_file
  return 1
fi

export MODEL_API_KEY="$_wt_key"   # Wind Tunnel: Muse Spark decisions, Run hunt, the benchmark
export META_API_KEY="$_wt_key"    # Muse Code's headless runs (muse exec)
export WINDTUNNEL_MUSE_SHELL=1

if [ "$_wt_claude" = 1 ]; then
  # Meta's documented settings. Every model variable names a Meta model, or background tasks
  # and subagents ask Meta for Claude models it doesn't serve.
  unset ANTHROPIC_API_KEY                            # an Anthropic key must not go to Meta
  export ANTHROPIC_BASE_URL="https://api.meta.ai"    # no /v1
  export ANTHROPIC_AUTH_TOKEN="$_wt_key"             # AUTH_TOKEN, not API_KEY
  export ANTHROPIC_MODEL="muse-wonder-1.0"
  export ANTHROPIC_DEFAULT_OPUS_MODEL="muse-wonder-1.0"
  export ANTHROPIC_DEFAULT_SONNET_MODEL="muse-spark-1.3"
  export ANTHROPIC_DEFAULT_HAIKU_MODEL="muse-spark-1.3"
  export CLAUDE_CODE_SUBAGENT_MODEL="muse-spark-1.3"
  export ENABLE_TOOL_SEARCH="true"
fi

case "$PS1" in
  "(muse) "*) ;;
  *) PS1="(muse) $PS1" ;;
esac
if [ "$_wt_claude" = 1 ]; then
  echo "Muse shell: Muse Code, Wind Tunnel and Claude Code use the Meta key here. Use another terminal for your own logins."
else
  echo "Muse shell: Muse Code and Wind Tunnel use the Meta key here. Use another terminal for your own Claude or Codex."
fi
unset _wt_claude _wt_key _wt_file
