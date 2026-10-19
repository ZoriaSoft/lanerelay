# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/ZoriaSoft/lanerelay/security/advisories/new)
rather than a public issue. Include the version or commit, the lane config
(redact anything private) and steps to reproduce. We aim to acknowledge
reports within a few days.

## Threat model in short

- `lanerelay.yaml` is trusted: lane and hook commands run through the shell
  exactly as you wrote them.
- Task text, queue files and the output of earlier lanes (which feeds the
  handoff prompt) are **not** trusted. They must never be executed as shell
  code: `{{prompt}}` is quoted for its context on POSIX and hook variables
  are passed as environment variables. A way to break either is a
  vulnerability.
- lanerelay does not read, store or forward credentials. Webhook hooks send
  the task text to the URL you configure.
- Agent CLIs you run as lanes can modify the working tree; that is their
  job, and sandboxing them is up to their own settings.

Known limit: on Windows, `cmd.exe` expands `%LR_PROMPT%` before parsing, so
prefer wrapper scripts that read `LR_PROMPT` from the environment (see the
README limits).
