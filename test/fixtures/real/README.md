# Real CLI output samples

Captured from real agent CLI runs (tiny "reply OK" prompts and deliberately
broken invocations), then sanitized: session ids, request ids, Cloudflare ray
ids and local paths were replaced with placeholders. Nothing else was edited.

| file | CLI | version | how it was produced | expected verdict |
|---|---|---|---|---|
| `claude-weekly-limit.txt` | Claude Code | 2.1.302 | `claude -p … --model haiku` on a capped account (exit 1) | limited, reset 03:00 UTC |
| `claude-not-logged-in.txt` | Claude Code | 2.1.302 | `claude -p …` with an empty `HOME` (exit 1) | not limited, auth error |
| `claude-bad-model.txt` | Claude Code | 2.1.302 | `claude -p … --model bogus-model-zzz` (exit 1) | not limited, generic error |
| `codex-usage-limit.txt` | Codex CLI | 0.163.0 | `codex exec …` on a capped ChatGPT plan (exit 1) | limited, reset 6:41 AM local |
| `codex-bad-model.txt` | Codex CLI | 0.163.0 | `codex exec -m bogus-model-zzz …` (exit 1) | not limited, generic error |
| `codex-no-auth.txt` | Codex CLI | 0.163.0 | `codex exec …` with an empty `CODEX_HOME` (exit 1) | not limited, auth error |
| `opencode-bad-config.txt` | opencode | 1.18.14 | `opencode run …` with an invalid config file (exit 1) | not limited, generic error |
| `opencode-ok.txt` | opencode | 1.18.14 | `opencode run -m opencode/big-pickle …` (exit 0) | done |

Lane output is stdout and stderr interleaved, as lanerelay sees it.
