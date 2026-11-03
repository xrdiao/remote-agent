# This rcfile belongs to the RA PTY; the user's startup configuration stays intact.
[[ -f ~/.bashrc ]] && source ~/.bashrc

_ra_emit() { printf '\033]777;RA;%s;%s\007' "$1" "$2"; }
_ra_prompt() { _ra_emit prompt "$(printf %s "$PWD" | base64 -w0)"; }
_ra_input() { _ra_emit input "$(printf '%s\0%s' "$READLINE_POINT" "$READLINE_LINE" | base64 -w0)"; }
_ra_clear() { READLINE_LINE=; READLINE_POINT=0; }
_ra_history() {
    _ra_emit history "$(HISTTIMEFORMAT=$'\036' history | base64 -w0)"
}
PROMPT_COMMAND+=(_ra_prompt)
# Readline prints PS1 after entering its terminal input mode.
PS1+='\[\e]777;RA;ready;\a\]'
PS0+='$(printf "\033]777;RA;run;\007")'
bind -x '"\e[97~":_ra_clear'
bind -x '"\e[98~":_ra_history'
bind -x '"\e[99~":_ra_input'
