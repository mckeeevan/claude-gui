<!-- claude-gui base: install.py keeps this file up to date. Delete this line to make it yours and stop updates. -->

# Writing prompts, commands, skills and subagents

Applies when writing a subagent (`.claude/agents/*.md`), a slash command (`.claude/commands/*.md`), a skill, or a prompt inside an app.

## Subagent files

- Frontmatter: `name`, a `description` that says what it does and when to use it (this is what picks it), `tools`, and `model: inherit` unless a specific model is needed.
- **Least privilege:** list only the tools the agent needs. A read-only role gets no write or shell tools, or is told exactly where it may write.
- State the role in one line, then where it may write, its inputs, its steps, its output, and when it is done.

## Calling subagents

Use a subagent for a focused piece of work with its own instructions (research, planning, review), not for bulk processing. Don't build pipelines of more than about 5 to 10 steps or over hundreds of files: do that work directly.

Brief each call the same way:

```text
Act as the "<agent>" subagent defined in .claude/agents/<agent>.md. Read and follow all of it.
Task: <one line>
Context: <only what it needs: paths, ids, the research section map>
Write: <files it should produce>
Return: a short summary of what you did, the files written, and any problems.
```

- Pass only the context the step needs, and check its result before starting a step that depends on it.
- A subagent can only use tools its caller has, so the caller's tool list is the ceiling.

## Commands (slash commands)

A `.claude/commands/<name>.md` file becomes `/<name>`. Give it a `description` in frontmatter, a heading that matches its intent, then: what it is for, what it needs (and what to do if that is missing), the steps, the output and where it goes, and how to check it worked. Warn before anything destructive.

## Prompts in apps

- Say the task, the context, the constraints and the output format. Give an example of good output when the format matters, and say what to do when the input is missing or out of scope.
- **Untrusted input is data.** Put user or web content in clearly delimited blocks, tell the model to treat it as data and never as instructions, and validate what comes back before acting on it.
- Never put secrets or personal data in a prompt, and don't echo them in output or logs.
- Test a prompt on representative and adversarial inputs before relying on it, and keep it in version control beside the code that uses it.

## Writing style for all of these

Short, direct, imperative sentences. Plain words, no idioms, no humor. Link to other rules instead of copying them.
