// Scripted events for demo mode, used when the page cannot reach live files.
// Each step may patch the state, the way Claude would edit state.yaml.

const setNode = (s, id, status) => {
  const walk = (list) => { for (const n of list || []) { if (n.id === id) n.status = status; walk(n.children); } };
  walk(s.structure);
};
const setTodo = (s, id, status) => {
  const walk = (list) => { for (const t of list || []) { if (t.id === id) t.status = status; walk(t.children); } };
  walk(s.todos);
};
const agent = (s, id) => (s.agents || []).find((a) => a.id === id) || {};
const suite = (s, id) => (s.tests || []).find((t) => t.id === id) || {};
const part = (s, id) => {
  let hit = null;
  const walk = (list) => { for (const n of list || []) { if (n.id === id) hit = n; walk(n.children); } };
  walk(s.structure);
  return hit || {};
};

export const DEMO_SCRIPT = [
  // A failing test, traced to its cause, fixed, and re-run green.
  { agent: "main", type: "edit", target: "viewer/src/model.js", node: "viewer.model", text: "Offset each arrow by its group",
    patch: (s) => { s.session.thinking = "The failing test says arrows start in the wrong place. ELK gives points relative to the group, so each edge needs its group's offset added."; } },
  { agent: "main", type: "test_start", target: "npm test" },
  { agent: "main", type: "test", target: "npm test", ok: true, passed: 82, failed: 0,
    patch: (s) => { Object.assign(suite(s, "map"), { passed: 30, failed: 0, failures: [] }); } },
  // Brainstorming: an idea grows into parts, then one part splits in two.
  { agent: "main", type: "note", text: "Thinking through replay",
    patch: (s) => {
      s.session.phase = "brainstorming";
      s.session.thinking = "Replay is really two things: scrubbing through time, and loading old snapshots. Splitting it makes the map honest.";
      part(s, "replay").children = [
        { id: "replay.scrub", name: "Timeline scrubber", status: "idea", uses: ["replay.load"] },
        { id: "replay.load", name: "Snapshot loader", status: "idea", uses: [{ to: "hooks.history", kind: "data" }] },
      ];
    } },
  { agent: "main", type: "note", text: "Split the structure map into layout and drawing",
    patch: (s) => {
      const views = part(s, "viewer.views");
      views.children = views.children.flatMap((n) => n.id !== "viewer.tree" ? [n] : [
        { id: "viewer.layout", name: "Map layout", status: "active", from: "viewer.tree", uses: [{ to: "viewer.model", weight: 3 }] },
        { id: "viewer.draw", name: "Map drawing", status: "planned", from: "viewer.tree", uses: ["viewer.layout"] },
      ]);
      s.session.focus = "viewer.layout";
      Object.assign(agent(s, "main"), { nodes: ["viewer.layout"] });
      Object.assign(suite(s, "map"), { nodes: ["viewer.layout", "viewer.draw"] });
    } },
  { agent: "main", type: "note", text: "Merged the replay parts back into one",
    patch: (s) => {
      const r = part(s, "replay");
      delete r.children;
      r.from = ["replay.scrub", "replay.load"];
      r.status = "planned";
      s.session.phase = "building";
      s.session.thinking = "On reflection replay is one small part for now. Merge it back and plan it after the panel.";
    } },
  { agent: "main", type: "edit", target: "viewer/tree.js", text: "Fold finished branches" },
  { agent: "styler", type: "edit", target: "viewer/agents.js", text: "Curved edges between agents" },
  { agent: "explorer", type: "message", to: "main", text: "PostToolUse carries the file path in tool_input" },
  { agent: "main", type: "message", to: "explorer", text: "Good. Check what Stop sends too" },
  { agent: "explorer", type: "read", target: "hooks/claude_gui_hook.py" },
  {
    agent: "main", type: "edit", target: "viewer/tree.js", text: "Heat glow fades over a minute",
    patch: (s) => { s.session.thinking = "Heat should fade, so old edits stop looking current. A one-minute half-life feels right."; },
  },
  {
    agent: "styler", type: "done", to: "main", text: "Agent graph is ready",
    patch: (s) => { setNode(s, "viewer.agents", "done"); setTodo(s, "t4", "done"); Object.assign(agent(s, "styler"), { task: "Finished the agent graph", nodes: [] }); },
  },
  { agent: "main", type: "edit", target: "example/.claude-gui/state.yaml", text: "Marked the agent graph done" },
  {
    agent: "explorer", type: "edit", target: "hooks/claude_gui_hook.py", text: "Map SubagentStart to spawn",
    patch: (s) => { setNode(s, "hooks", "active"); setNode(s, "hooks.agents", "active"); setNode(s, "hooks.tools", "done"); setTodo(s, "t5a", "done"); setTodo(s, "t5b", "in_progress"); },
  },
  {
    agent: "main", type: "edit", target: "viewer/todos.js", node: "viewer.todos", text: "Started the todo list",
    patch: (s) => {
      setNode(s, "viewer.todos", "active"); setTodo(s, "t6", "in_progress"); setTodo(s, "t3b", "done");
      s.session.focus = "viewer.todos";
      s.session.thinking = "The todo list should sort what's in progress to the top, and show which part of the app each item belongs to.";
      Object.assign(agent(s, "main"), { nodes: ["viewer.todos"], task: "Building the todo list" });
    },
  },
  { agent: "explorer", type: "message", to: "main", text: "Hook script logs reads, edits, runs and agents" },
  {
    agent: "main", type: "spawn", to: "styler", text: "Build the activity feed",
    patch: (s) => { setNode(s, "viewer.feed", "active"); Object.assign(agent(s, "styler"), { task: "Activity feed", nodes: ["viewer.feed"] }); },
  },
  { agent: "styler", type: "edit", target: "viewer/feed.js" },
  {
    agent: "main", type: "edit", target: "viewer/tree.js", node: "viewer.tree", text: "Tree done",
    patch: (s) => { setNode(s, "viewer.tree", "done"); setTodo(s, "t3b", "done"); setTodo(s, "t3c", "done"); },
  },
  { agent: "main", type: "spawn", to: "reviewer", text: "Review the structure map code" },
  { agent: "reviewer", type: "read", target: "viewer/src/model.js", node: "viewer.model", patch: (s) => { Object.assign(agent(s, "reviewer"), { task: "Reviewing the layout code" }); } },
  { agent: "reviewer", type: "read", target: "viewer/tree.js", node: "viewer.tree" },
  { agent: "reviewer", type: "done", to: "main", text: "No blocking issues in the map code", patch: (s) => { Object.assign(agent(s, "reviewer"), { task: "Waiting for the next change to review" }); } },
  { agent: "user", type: "prompt", to: "main", text: "Can it show which agent is on which part?" },
  { agent: "main", type: "message", to: "user", text: "Yes, colored dots next to each part" },
];
