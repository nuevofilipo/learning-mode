# learning-mode

A Claude Code mod that forces you to understand what you are building.

Whenever a larger implementation / change is about to be performed, Claude Code creates a quiz in a side panel that you need to answer correctly before it is allowed to continue. Answers are graded against the plan Claude explained.

## Install

In Claude Code:

```
/plugin install learning-mode --marketplace nuevofilipo/learning-mode
```

Answer `y` to add the marketplace, then pick a scope (user scope = all sessions).

## Commands

| Command                     | What it does                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| `/learning-mode`            | Toggle on/off (remembered across sessions)                                                  |
| `/learning-mode on` / `off` | Turn on / off                                                                               |
| `/learning-mode status`     | Show whether it's on and if a quiz is pending                                               |
| `/learning-mode show`       | Reopen the quiz panel if you closed it |
| `/learning-mode skip`       | Skip the pending quiz and let Claude continue                                               |

## Customize

Edit `hooks/register.tsx`:

- **System prompt**: the `INSTRUCTIONS` constant (when to quiz, what kind of questions).
- **Number of questions**: "3-5" in `INSTRUCTIONS` and `maxItems` in the `quiz` tool's `inputSchema`.
- **Files editable without a quiz**: `FREE_FILES` (default `1`).

Note: only the Edit/Write/NotebookEdit tools are blocked; file changes made via Bash are not.
