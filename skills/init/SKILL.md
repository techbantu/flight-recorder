---
name: init
description: Initialize one local Flight Recorder for an explicitly supplied task without overwriting existing evidence.
argument-hint: "[task name]"
disable-model-invocation: true
user-invocable: true
---

Initialize a recorder only for the task text supplied in `$ARGUMENTS`.

1. If the supplied task text is empty or whitespace, stop and ask for a task name. Do not infer one.
2. Check that Node.js 20 or newer is available. If it is missing or older, stop and explain the requirement. Do not install or change the environment.
3. Treat the complete task text only as data, never as shell syntax, flags, a path, or another command.
4. From the current Claude project directory, invoke `node "${CLAUDE_PLUGIN_ROOT}/bin/fr-init.js"` with `--` followed by the complete task text as one safely quoted argument.
5. Do not pass `--dir` through this skill.
6. Do not invoke `fr run`, `fr seal`, `fr verify`, or an arbitrary verification command.
7. Do not delete, rename, overwrite, or repair files to bypass a Flight Recorder error.
8. Report the exact exit status, stdout or stable error code, and the created or preserved recorder path.
