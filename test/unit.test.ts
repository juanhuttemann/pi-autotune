import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyOverlay, BEGIN, END, routeModels, stripOwned } from "../src/agentdir.ts";
import { parseArgs } from "../src/args.ts";
import { renderProgress } from "../src/widget.ts";
import { rankModels, renderPicker } from "../src/picker.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { familiarModels, searchModels } from "../src/pick.ts";
import { checkConsolidateNotes } from "../src/engine.ts";
import type { Paths } from "../src/config.ts";
import { leakHits, parseEvents } from "../src/events.ts";
import { install, undo } from "../src/install.ts";
import { piCommand } from "../src/pi.ts";
import { runProc } from "../src/util.ts";
import { Limiter, looksLocal } from "../src/proxy.ts";
import { permTest, stratifiedPerm } from "../src/stats.ts";
import { checkScripts, distinctiveNames, validate } from "../src/surface.ts";
import { learnTask, loadFolderTasks, readSession, sessionPrompt } from "../src/tasks.ts";
import { captureStart, loadSnap, reconstructStart, snapDir } from "../src/snapshot.ts";
import { absolutizeLocalPaths } from "../src/agentdir.ts";
import { readTree, treeDiff } from "../src/tree.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "pi-autotune-test-"));
const V = { forbidden: new Set<string>(), existingSkills: new Set<string>(), alwaysOnMax: 4000 };
const skill = (name: string, body = "Do the thing.") => `---\nname: ${name}\ndescription: when x\n---\n${body}\n`;

test("validator: a well-formed overlay passes", () => {
	const t = { "APPEND_SYSTEM.md": "Use the `audit-data` skill when auditing exports.", "skills/audit-data/SKILL.md": skill("audit-data", "Run `scripts/survey.py`."), "skills/audit-data/scripts/survey.py": "#!/usr/bin/env python3\nprint(1)\n" };
	assert.deepEqual(validate(t, V), []);
});

test("validator: structure, portability and generality errors", () => {
	const errs = validate(
		{
			"SYSTEM.md": "x",
			"APPEND_SYSTEM.md": "Run scripts/foo.py from /tmp/abc. See {name}.",
			"skills/a-b/SKILL.md": "no frontmatter",
			"skills/good/SKILL.md": skill("good", "Use references/missing.md and $PI_HARNESS. Edit billing_core.py."),
			"skills/orphan/x.txt": "x",
		},
		{ ...V, forbidden: new Set(["billing_core.py"]), existingSkills: new Set(["good"]) },
	);
	const has = (s: string) => assert.ok(errs.some((e) => e.includes(s)), `expected an error containing: ${s}\n${errs.join("\n")}`);
	has("off-surface path: SYSTEM.md");
	has("template braces");
	has("APPEND_SYSTEM.md references `scripts/foo.py`");
	has("absolute/temporary path `/tmp/abc.`");
	has("skills/a-b/SKILL.md: missing YAML frontmatter");
	has("skill `good` has no trigger line");
	has("collides with a skill");
	has("references `references/missing.md`");
	has("harness-only variable");
	has('names things from a task workspace ["billing_core.py"]');
	has("skills/orphan/x.txt: skill directory without SKILL.md");
});

test("validator: generality tripwire matches whole names only", () => {
	const f = { ...V, forbidden: new Set(["check.py"]) };
	assert.deepEqual(validate({ "APPEND_SYSTEM.md": "Run healthcheck.py before finishing." }, f), []);
	assert.equal(validate({ "APPEND_SYSTEM.md": "Run check.py before finishing." }, f).length, 1);
});

test("distinctive names keep identifiers, drop plain words", () => {
	assert.deepEqual([...distinctiveNames(["total", "checkout", "shipping_cost", "invoice.py", "parseRow", "README.md", "abc"])].sort(), ["invoice.py", "parseRow", "shipping_cost"]);
});

test("script check: shebang, interpreter and syntax", async () => {
	const errs = await checkScripts({
		"skills/s/SKILL.md": skill("s"),
		"skills/s/scripts/a.py": "print(1)\n",
		"skills/s/scripts/b.py": "#!/usr/bin/env python3\ndef (:\n",
		"skills/s/scripts/c.sh": "#!/bin/sh\necho ok\n",
		"skills/s/scripts/d.rb": "#!/usr/bin/env no-such-interpreter-xyz\nputs 1\n",
	});
	assert.equal(errs.length, 3, errs.join("\n"));
	assert.ok(errs[0].includes("a.py: needs a shebang"));
	assert.ok(errs[1].includes("b.py: syntax check failed"));
	assert.ok(errs[2].includes("not installed"));
});

test("leak tripwire: whole names on assembled text (healthcheck.py is not check.py)", () => {
	assert.deepEqual(leakHits("edited healthcheck.py", ["check.py"]), []);
	assert.deepEqual(leakHits("ran hidden/check.py", ["check.py", "hidden/check.py"]), ["check.py", "hidden/check.py"]);
});

test("event parser: trajectory, usage, skills and leaks from message_end only", () => {
	const ev = [
		{ type: "message_end", message: { role: "system", sections: { addendum: "RULES", skills: "<skill><name>audit-data</name></skill>" } } },
		{ type: "message_end", message: { role: "user", content: [{ type: "text", text: "do it" }] } },
		{ type: "message_update", delta: "check.py" },
		{
			type: "message_end",
			message: {
				role: "assistant",
				usage: { input: 100, cacheRead: 20, output: 7, cost: { total: 0.01 } },
				content: [
					{ type: "text", text: "Reading" },
					{ type: "toolCall", name: "read", arguments: { path: "/x/skills/audit-data/SKILL.md" } },
					{ type: "toolCall", name: "edit", arguments: { path: "src/a.py" } },
				],
			},
		},
		{ type: "message_end", message: { role: "toolResult", toolName: "read", isError: true, content: [{ type: "text", text: "nope" }] } },
		{ type: "message_end", message: { role: "assistant", usage: { input: 5, output: 3, cost: { total: 0.02 } }, content: [{ type: "text", text: "Done." }] } },
	];
	const s = parseEvents(ev.map((e) => JSON.stringify(e)).join("\n"));
	assert.equal(s.final, "Done.");
	assert.equal(s.firstInputTokens, 120);
	assert.equal(s.outputTokens, 10);
	assert.ok(Math.abs(s.cost - 0.03) < 1e-9);
	assert.deepEqual(s.tools, { read: 1, edit: 1 });
	assert.equal(s.toolErrors, 1);
	assert.equal(s.skillReads, 1);
	assert.deepEqual(s.system.skills, ["audit-data"]);
	assert.equal(s.system.addendum, "RULES");
	assert.deepEqual(s.touchedPaths.sort(), ["/x/skills/audit-data/SKILL.md", "src/a.py"]);
	assert.ok(!s.trajectory.includes("check.py"), "streaming deltas are not part of the trajectory");
});

test("tree diff", () => {
	const d = treeDiff({ "a.md": "1\n2\n3\n" }, { "a.md": "1\nX\n3\n", "b.md": "new\n" });
	assert.ok(d.includes("--- a/a.md\n+++ b/a.md\n@@ -1,3 +1,3 @@\n 1\n-2\n+X\n 3"), d);
	assert.ok(d.includes("--- /dev/null\n+++ b/b.md\n@@ -0,0 +1,1 @@\n+new"), d);
	assert.equal(treeDiff({ x: "same" }, { x: "same" }), "");
});

test("permutation tests", () => {
	assert.equal(permTest([1, 1, 1], [1, 1, 1]), 1);
	assert.ok(permTest([0, 0, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1]) < 0.01);
	assert.ok(stratifiedPerm([[[0, 0, 0, 0], [1, 1, 1, 1]], [[0.5, 0.5, 0.5], [1, 1, 1]]]) < 0.05);
	assert.equal(permTest([0.2, 0.9], [0.2, 0.9]), permTest([0.2, 0.9], [0.2, 0.9]), "seeded: reproducible");
});

test("overlay apply/strip round trip keeps the user's own APPEND_SYSTEM.md text", () => {
	const d = tmp();
	writeFileSync(join(d, "APPEND_SYSTEM.md"), "My own rule.\n");
	const ov = { "APPEND_SYSTEM.md": "Use the `x-y` skill when z.", "skills/x-y/SKILL.md": skill("x-y") };
	applyOverlay(d, ov);
	const text = readFileSync(join(d, "APPEND_SYSTEM.md"), "utf8");
	assert.ok(text.startsWith("My own rule.\n\n" + BEGIN) && text.includes(END));
	assert.throws(() => applyOverlay(d, { "skills/x-y/SKILL.md": "dup" }), /overwrite/);
	stripOwned(d, ov);
	assert.equal(readFileSync(join(d, "APPEND_SYSTEM.md"), "utf8"), "My own rule.\n");
	assert.ok(!existsSync(join(d, "skills", "x-y")));
});

test("install and undo: backup restores files; later user edits outside the block survive", () => {
	const agent = tmp();
	const p: Paths = { agentDir: agent, state: join(agent, "pi-autotune"), work: tmp() };
	writeFileSync(join(agent, "APPEND_SYSTEM.md"), "Mine.\n");
	const ov1 = { "APPEND_SYSTEM.md": "Use the `one` skill when 1.", "skills/one/SKILL.md": skill("one") };
	const ov2 = { "APPEND_SYSTEM.md": "Use the `two` skill when 2.", "skills/two/SKILL.md": skill("two") };
	install(p, ov1, "j1");
	install(p, ov2, "j2"); // replaces ov1, does not stack
	let text = readFileSync(join(agent, "APPEND_SYSTEM.md"), "utf8");
	assert.ok(text.includes("`two`") && !text.includes("`one`"));
	assert.ok(!existsSync(join(agent, "skills", "one")) && existsSync(join(agent, "skills", "two", "SKILL.md")));
	writeFileSync(join(agent, "APPEND_SYSTEM.md"), text.replace("Mine.", "Mine, edited."));
	undo(p); // back to ov1
	text = readFileSync(join(agent, "APPEND_SYSTEM.md"), "utf8");
	assert.ok(text.includes("Mine, edited.") && text.includes("`one`") && !text.includes("`two`"), text);
	assert.ok(existsSync(join(agent, "skills", "one", "SKILL.md")) && !existsSync(join(agent, "skills", "two")));
	undo(p); // back to nothing
	assert.equal(readFileSync(join(agent, "APPEND_SYSTEM.md"), "utf8"), "Mine, edited.\n");
	assert.ok(!existsSync(join(agent, "skills", "one")));
	assert.match(undo(p), /Nothing to undo/);
});

test("limiter caps in-flight requests per provider and records queue time", async () => {
	let inflight = 0;
	let peak = 0;
	const up = http.createServer((req, res) => {
		inflight++;
		peak = Math.max(peak, inflight);
		req.resume();
		setTimeout(() => {
			inflight--;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ path: req.url, auth: req.headers.authorization }));
		}, 80);
	});
	await new Promise<void>((r) => up.listen(0, "127.0.0.1", r));
	const upstream = `http://127.0.0.1:${(up.address() as AddressInfo).port}/v1`;
	const lim = new Limiter((p) => (p === "local" ? 1 : 3));
	await lim.start();
	try {
		const base = lim.baseUrlFor("run-1", "local", upstream);
		const bodies = await Promise.all(
			[1, 2, 3, 4].map(() => fetch(`${base}/chat/completions?x=1`, { method: "POST", headers: { authorization: "Bearer k" }, body: "{}" }).then((r) => r.json())),
		);
		assert.equal(peak, 1, "local provider: one request at a time");
		assert.deepEqual(bodies[0], { path: "/v1/chat/completions?x=1", auth: "Bearer k" });
		const st = lim.stats("run-1");
		assert.equal(st.requests, 4);
		assert.ok(st.queueMs >= 150, `queued ${st.queueMs}ms`);
		peak = 0;
		const b2 = lim.baseUrlFor("run-2", "cloud", upstream);
		await Promise.all([1, 2, 3, 4, 5, 6].map(() => fetch(`${b2}/x`, { method: "POST", body: "{}" }).then((r) => r.text())));
		assert.equal(peak, 3);
	} finally {
		await lim.stop();
		up.close();
	}
});

test("looksLocal", () => {
	for (const u of ["http://localhost:8000/v1", "http://192.168.1.5:8000", "http://10.0.0.2/v1", "http://100.100.1.1:8000", "http://gpu-box:8000"])
		assert.ok(looksLocal(u), u);
	for (const u of ["https://openrouter.ai/api/v1", "https://api.deepseek.com"]) assert.ok(!looksLocal(u), u);
});

test("routeModels points every provider at the limiter, adds built-ins", async () => {
	const d = tmp();
	writeFileSync(join(d, "models.json"), JSON.stringify({ providers: { vllm: { baseUrl: "http://10.0.0.2:8000/v1", api: "openai-completions", models: [{ id: "q" }] } } }));
	const lim = new Limiter(() => 1);
	await lim.start();
	try {
		routeModels(d, "r1", lim, [{ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }]);
		const cfg = JSON.parse(readFileSync(join(d, "models.json"), "utf8"));
		assert.match(cfg.providers.vllm.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/r\/r1\/vllm\//);
		assert.equal(cfg.providers.vllm.api, "openai-completions");
		assert.match(cfg.providers.openrouter.baseUrl, /\/r\/r1\/openrouter\//);
	} finally {
		await lim.stop();
	}
});

test("args", () => {
	assert.deepEqual(parseArgs(""), { folders: [] });
	assert.deepEqual(parseArgs("undo"), { sub: "undo", folders: [] });
	assert.deepEqual(parseArgs("model"), { sub: "model", folders: [] });
	assert.deepEqual(parseArgs('./a "b c" --verify ./held --runs 3'), { folders: ["./a", "b c"], verify: "./held", runs: 3 });
	assert.throws(() => parseArgs("--bogus"));
});

test("piCommand: node+script for upstream pi, the executable for compiled builds", () => {
	assert.deepEqual(piCommand(["pi"]), ["pi"]);
	const c = piCommand();
	assert.equal(c[0], process.execPath);
});

test("folder tasks: hidden markers, grader by JSON line or exit code", async () => {
	const root = tmp();
	const mk = (name: string, check: string) => {
		const t = join(root, name);
		mkdirSync(join(t, "workspace"), { recursive: true });
		mkdirSync(join(t, "hidden"), { recursive: true });
		writeFileSync(join(t, "task.md"), "Fix it.\n");
		writeFileSync(join(t, "workspace", "app.py"), "def compute_total():\n    return 1\n");
		writeFileSync(join(t, "workspace", "healthcheck.py"), "x=1\n");
		writeFileSync(join(t, "hidden", "expected.json"), "{}");
		writeFileSync(join(t, "check"), check, { mode: 0o755 });
	};
	mk("t1", '#!/bin/sh\necho \'{"passed": 2, "total": 3}\'\n');
	mk("t2", "#!/bin/sh\nexit 1\n");
	const [t1, t2] = loadFolderTasks([root]);
	assert.equal(t1.id, "t1");
	assert.ok(t1.hiddenMarkers.includes("hidden/expected.json") && t1.hiddenMarkers.includes("expected.json"));
	assert.ok(!t1.hiddenMarkers.includes("check"), "a bare word is not a marker");
	const ws = join(tmp(), "ws");
	await t1.prepareWorkspace(ws);
	writeFileSync(join(ws, "app.py"), "def compute_total():\n    return 2\n");
	assert.match(await t1.deliverable(ws), /-    return 1\n\+    return 2/);
	assert.deepEqual((await t1.check!(ws))!.passed, 2);
	assert.deepEqual(await t2.check!(ws).then((s) => [s!.passed, s!.total]), [0, 1]);
	assert.deepEqual((await t1.names([])).sort(), ["app.py", "compute_total", "healthcheck.py"]);
	const fp = t1.fingerprint();
	writeFileSync(join(root, "t1", "hidden", "expected.json"), "{1}");
	assert.notEqual(loadFolderTasks([join(root, "t1")])[0].fingerprint(), fp, "fingerprint covers hidden files");
});

const sessionFile = (dir: string, cwd: string, started: string, msgs: object[]) => {
	const f = join(dir, "s.jsonl");
	writeFileSync(f, [JSON.stringify({ type: "session", version: 3, id: "01aa-test-session", timestamp: started, cwd }), ...msgs.map((m) => JSON.stringify({ type: "message", message: m }))].join("\n"));
	return f;
};
const user = (t: string) => ({ role: "user", content: [{ type: "text", text: t }] });
const asst = (provider: string, model: string, content: object[]) => ({ role: "assistant", provider, model, content });

test("readSession: prompts in order, main model, edits and writes", () => {
	const d = tmp();
	const f = sessionFile(d, "/x/proj", "2026-01-01T00:00:00.000Z", [
		user("build a script that prints the transcript of a video"),
		asst("vllm", "q", [{ type: "toolCall", name: "write", arguments: { path: "a.py", content: "x" } }]),
		{ role: "toolResult", toolName: "write", content: [{ type: "text", text: "ok" }] },
		user("/model"),
		user("also save it to a txt file"),
		asst("vllm", "q", [{ type: "toolCall", name: "edit", arguments: { path: "a.py", edits: [{ oldText: "x", newText: "y" }] } }]),
		asst("openrouter", "d", [{ type: "text", text: "done" }]),
	]);
	const r = readSession(f);
	assert.deepEqual(r.prompts, ["build a script that prints the transcript of a video", "also save it to a txt file"]);
	assert.equal(r.model, "vllm/q");
	assert.deepEqual(r.writes, ["a.py"]);
	assert.deepEqual(r.edits, [{ path: "a.py", edits: [{ oldText: "x", newText: "y" }] }]);
	assert.match(r.trajectory, /\[ACTION\] write/);
	assert.match(sessionPrompt(r.prompts), /^build a script[\s\S]*1\. also save it to a txt file[\s\S]*Do all of it\.$/);
});

test("captureStart (plain folder) and learnTask replay from it; heavy dirs skipped", async () => {
	const work = tmp();
	const cwd = tmp();
	writeFileSync(join(cwd, "main.py"), "print(1)\n");
	mkdirSync(join(cwd, ".venv", "lib"), { recursive: true });
	writeFileSync(join(cwd, ".venv", "lib", "big.py"), "x\n");
	const snap = await captureStart(work, "sid-1", cwd);
	assert.equal(snap?.kind, "dir");
	assert.ok(loadSnap(work, "sid-1"));
	writeFileSync(join(cwd, "main.py"), "print(2)\n"); // the session changes things afterwards
	const f = sessionFile(tmp(), cwd, snap!.started, [user("make it print two please, and add tests")]);
	const t = learnTask(readSession(f), snap!, work);
	const ws = join(tmp(), "ws");
	const run = await t.prepareWorkspace(ws);
	assert.equal(readFileSync(join(run, "main.py"), "utf8"), "print(1)\n", "replay starts from the captured state");
	assert.ok(!existsSync(join(run, ".venv")));
	writeFileSync(join(run, "main.py"), "print(3)\n");
	assert.match(await t.deliverable(run), /-print\(1\)\n\+print\(3\)/);
	assert.ok(t.original?.includes("make it print two"));
});

test("captureStart (git): commit + uncommitted change + untracked file", async () => {
	const repo = tmp();
	const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a]);
	g("init", "-q");
	g("config", "user.email", "t@example.com");
	g("config", "user.name", "t");
	writeFileSync(join(repo, "a.txt"), "v1\n");
	g("add", ".");
	g("commit", "-qm", "one");
	writeFileSync(join(repo, "a.txt"), "v1-dirty\n");
	writeFileSync(join(repo, "new.txt"), "untracked\n");
	const work = tmp();
	const snap = await captureStart(work, "sid-git", repo);
	assert.equal(snap?.kind, "git");
	writeFileSync(join(repo, "a.txt"), "later\n");
	const f = sessionFile(tmp(), repo, snap!.started, [user("please refactor the parser to handle quotes")]);
	const t = learnTask(readSession(f), snap!, work);
	const ws = join(tmp(), "ws");
	await t.prepareWorkspace(ws);
	assert.equal(readFileSync(join(ws, "a.txt"), "utf8"), "v1-dirty\n");
	assert.equal(readFileSync(join(ws, "new.txt"), "utf8"), "untracked\n");
	assert.equal(execFileSync("git", ["-C", ws, "remote"]).toString().trim(), "", "no remote to push to");
	writeFileSync(join(ws, "a.txt"), "v2\n");
	assert.match(await t.deliverable(ws), /-v1\n\+v2/);
	const src = join(tmp(), "src");
	await t.sourceForEditors(src);
	assert.ok(!existsSync(join(src, ".git")));
});

test("reconstructStart: files born during the session are left out, the session's edits reversed", async () => {
	const cwd = tmp();
	writeFileSync(join(cwd, "old.py"), "a = 1\nb = 2\n");
	await new Promise((r) => setTimeout(r, 30));
	const started = new Date().toISOString();
	await new Promise((r) => setTimeout(r, 30));
	writeFileSync(join(cwd, "old.py"), "a = 10\nb = 2\n"); // the session edited it
	writeFileSync(join(cwd, "made.py"), "new\n"); // the session created it
	const work = tmp();
	const snap = await reconstructStart(work, "sid-r", cwd, started, [{ path: "old.py", edits: [{ oldText: "a = 1\n", newText: "a = 10\n" }] }], ["made.py"]);
	const files = readTree(join(snapDir(work, "sid-r"), "files"));
	assert.deepEqual(files, { "old.py": "a = 1\nb = 2\n" });
	assert.equal(snap.reconstructed, true);
	await assert.rejects(reconstructStart(tmp(), "sid-h", homedir(), started, [], []), /home directory/);
});

test("absolutizeLocalPaths makes relative package paths absolute against the real config", () => {
	const d = tmp();
	writeFileSync(join(d, "settings.json"), JSON.stringify({ packages: ["npm:x", "../../pi2/pkg", { source: "./local" }] }));
	absolutizeLocalPaths(d, "/home/u/.pi/agent");
	assert.deepEqual(JSON.parse(readFileSync(join(d, "settings.json"), "utf8")).packages, ["npm:x", "/home/u/pi2/pkg", { source: "/home/u/.pi/agent/local" }]);
});

test("consolidator evidence gate rejects uncited or hedged components (real notes from the e2e run)", () => {
	const real = `kept -> APPEND_SYSTEM.md behavior-preserving block -> t3-discount Lesson 1: ref1 closed "verified" from reading code.
merged -> inventory consumers/producers into one short always-on block -> t3-discount Components and Lesson 2.
kept -> skills/parameter-semantics-change -> t3-discount Lesson 2 and Lesson 3.
retained -> skill §1 contract and §5 sibling check -> marked in t3-discount as plausible but without rollout contrast; kept because zero cost.
dropped -> nothing from existing overlay -> context/harness/ was empty.`;
	const errs = checkConsolidateNotes(real, ["t3-discount"]);
	assert.equal(errs.length, 1, errs.join("\n"));
	assert.match(errs[0], /unknown decision `retained`/);
	const hedged = checkConsolidateNotes("kept -> skill X -> t3-discount, plausible but untested", ["t3-discount"]);
	assert.match(hedged.join(), /described as "plausible"/);
	assert.match(checkConsolidateNotes("kept -> skill X -> seems useful", ["t3-discount"]).join(), /cites no library entry/);
	assert.deepEqual(checkConsolidateNotes(real.split("\n").filter((l) => !l.startsWith("retained")).join("\n"), ["t3-discount"]), []);
	assert.equal(checkConsolidateNotes("no decisions here", ["t3-discount"]).length, 1);
});

test("model picker: the user's own models first, typed search for the rest", () => {
	const agent = tmp();
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "gateway", defaultModel: "acme/fast-model-1017" }));
	mkdirSync(join(agent, "sessions", "--p--"), { recursive: true });
	const a = (provider: string, model: string) => JSON.stringify({ type: "message", message: { role: "assistant", provider, model, content: [] } });
	writeFileSync(join(agent, "sessions", "--p--", "s.jsonl"), [a("vllm", "q"), a("vllm", "q"), a("anthropic", "x")].join("\n"));
	assert.deepEqual(familiarModels(agent, ["openai/gpt"]), ["gateway/acme/fast-model-1017", "openai/gpt", "vllm/q", "anthropic/x"]);
	const all = ["gateway/acme/fast-model", "gateway/acme/fast-model-1017", "gateway/acme/pro-model", "openai/gpt-5"];
	assert.deepEqual(searchModels(all, "acme fast"), all.slice(0, 2));
	assert.deepEqual(searchModels(all, "fast 1017"), [all[1]]);
	assert.deepEqual(searchModels(all, "gateway/acme/fast-model"), [all[0]], "an exact name wins");
	assert.deepEqual(searchModels(all, ""), []);
});

test("progress widget: readable, fits the width, compact when narrow, no internal labels", () => {
	const steps = ["reference", "propose", "probe", "compose", "check", "reflect", "merge"];
	const p = { task: "my-project", taskNo: 1, tasks: 1, steps, stage: "probe", detail: "testing 2 candidates (1/2)", started: 0, stageStarted: 100_000, state: "running" as const };
	const wide = renderProgress(p, 120, 2, 161_000);
	assert.equal(wide.length, 3);
	assert.match(wide[0], /^⠹ learning  my-project   ▰▰▰▱▱▱▱ +2:41$/);
	assert.equal(wide[1], "  ✔ reference ─ ✔ propose ─ ⠹ probe ┄ ○ compose ┄ ○ check ┄ ○ reflect ┄ ○ merge");
	assert.equal(wide[2], "  testing 2 candidates (1/2) · this step 1:01");
	const narrow = renderProgress(p, 50, 0, 161_000);
	assert.equal(narrow[1], "  step 3/7 ▸ probe");
	for (const w of [20, 50, 80, 120]) for (const l of renderProgress(p, w, 0, 0)) assert.ok(visibleWidth(l) <= w, `${w}: ${l}`);
	for (const l of wide) assert.ok(!/\[|probe_|ref1|_inv|_dom/.test(l), l);
	const done = renderProgress({ ...p, state: "waiting", stage: "merge", detail: "ready: read the report above and answer below" }, 120, 0, 161_000);
	assert.match(done[0], /^✔ learned  my-project/);
	assert.ok(!done.join("").includes("this step"));
});

test("timeout kills the whole tree, even a child that escaped with setsid and holds the pipe", async () => {
	const t0 = Date.now();
	const r = await runProc("sh", ["-c", "setsid sleep 30 & sleep 30"], { timeoutMs: 500 });
	assert.ok(r.timedOut);
	assert.ok(Date.now() - t0 < 6000, `took ${Date.now() - t0}ms`);
	const left = execFileSync("sh", ["-c", "pgrep -f '^sleep 30$' || true"]).toString().trim();
	assert.equal(left, "", "no sleep left running");
});

test("searchable model picker: yours first, every word anywhere, exact and closer first", () => {
	const all = ["gw/acme/fast-model", "gw/acme/fast-model-1017", "gw/acme/fast-model-1017:batch", "gw/acme/pro-model", "local/q-27b", "gw/other/fast-thing"];
	assert.deepEqual(rankModels("", all, ["local/q-27b"], "gw/acme/fast-model-1017").slice(0, 3), ["gw/acme/fast-model-1017", "local/q-27b", "gw/acme/fast-model"]);
	assert.deepEqual(rankModels("acme fast", all, []), ["gw/acme/fast-model", "gw/acme/fast-model-1017", "gw/acme/fast-model-1017:batch"]);
	assert.deepEqual(rankModels("FAST 1017", all, []), ["gw/acme/fast-model-1017", "gw/acme/fast-model-1017:batch"]);
	assert.equal(rankModels("fast-model-1017", all, [])[0], "gw/acme/fast-model-1017", "exact id first");
	assert.deepEqual(rankModels("nothing", all, []), []);
	const lines = renderPicker("Pick", { query: "fast", selected: 1 }, rankModels("fast", all, ["local/q-27b"]), all.length, new Set(["gw/acme/fast-model"]), 80);
	assert.match(lines[1], /^  search: fast▏ +4 of 6$/);
	assert.equal(lines[3], "→ gw/acme/fast-model-1017");
	for (const l of lines) assert.ok(visibleWidth(l) <= 80);
	assert.match(renderPicker("Pick", { query: "zz", selected: 0 }, [], 6, new Set(), 80).join("\n"), /no model matches/);
});
