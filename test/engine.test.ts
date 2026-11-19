import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULTS, type Paths } from "../src/config.ts";
import { Job } from "../src/engine.ts";
import { containment, domainOf, Library, provenance, retiredReason } from "../src/library.ts";
import { Limiter } from "../src/proxy.ts";
import { loadFolderTasks } from "../src/tasks.ts";
import { ablateLibrary } from "../src/verify.ts";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fake-pi.mjs");
const tmp = () => mkdtempSync(join(tmpdir(), "pi-autotune-eng-"));

function task(root: string, name: string, text: string): string {
	const d = join(root, name);
	mkdirSync(join(d, "workspace"), { recursive: true });
	writeFileSync(join(d, "task.md"), text);
	writeFileSync(join(d, "workspace", "README.txt"), "a tiny project\n");
	// Retrospective grader: passes only when the agent checked its work.
	writeFileSync(join(d, "check"), '#!/bin/sh\nif [ -f "$1/checked.txt" ]; then echo \'{"passed": 1, "total": 1}\'; else echo \'{"passed": 0, "total": 1}\'; fi\n', { mode: 0o755 });
	return d;
}

async function newJob(id: string, state?: Paths) {
	const agent = state?.agentDir ?? tmp();
	writeFileSync(join(agent, "settings.json"), "{}");
	const paths: Paths = state ?? { agentDir: agent, state: join(agent, "pi-autotune"), work: tmp() };
	const limiter = new Limiter(() => 1);
	await limiter.start();
	const log: string[] = [];
	const stages: string[] = [];
	const job = new Job(id, {
		paths,
		config: { ...DEFAULTS, concurrency: { fake: 1 }, piCommand: [process.execPath, FAKE] },
		worker: "fake/worker",
		improver: "fake/improver",
		limiter,
		routes: [],
		owned: {},
		log: (l) => log.push(l),
		stage: (s) => stages.push(s),
		signal: new AbortController().signal,
	});
	await job.init();
	return { job, limiter, paths, log, stages };
}

test("library units: containment, provenance, domain, retirement", () => {
	assert.equal(containment("keep\nRun the program before saying done.\n", "keep\n", "Run the program before saying done.\n"), 1);
	assert.equal(containment("A brand new and different line here.\n", "", "Run the program before saying done.\n"), 0);
	assert.equal(domainOf("## Domain\nPython CLI tools\n"), "python-cli-tools");
	assert.equal(domainOf("no domain"), "general");
	assert.equal(retiredReason("## Status\nretired: contradicted by t9\n"), "contradicted by t9");
	assert.equal(retiredReason("## Status\nactive\n"), null);
	const lib = new Library(tmp());
	lib.add("e1", { "skills/a/SKILL.md": "---\nname: a\n---\nRun the program on a real input first.\n" }, "## Domain\nx\n\n## Situation\ns\n\n## Lessons\n1. l\n", [], "j", "t");
	// Same skill copied under a new name still counts as taken from the entry.
	const p = provenance({ "skills/b/SKILL.md": "---\nname: b\n---\nRun the program on a real input first.\n" }, {}, lib);
	assert.equal(p.e1, 1);
	assert.deepEqual(lib.cited("reused e1 -> skill"), ["e1"]);
	assert.deepEqual(lib.cited("reused e10 -> skill"), []);
	lib.retire("e1", "superseded");
	assert.deepEqual(lib.entries(), []);
	assert.ok(existsSync(join(lib.dir, "_archive", "e1", "EXPERIENCE.md")), "retired entries are archived, not deleted");
});

test("harnessing-level recursion end to end: discover, store, reuse, revise, retire, ablate", async () => {
	const root = tmp();
	const { job, limiter, paths, stages } = await newJob("job-a");
	try {
		const [t1] = loadFolderTasks([task(root, "t1", "Write a script. DISCOVER\n")]);
		const s1 = await job.trainTask(t1);
		assert.ok(s1.adoptedChanged && s1.library, "task 1 adopted a change and wrote an entry");
		assert.deepEqual(s1.used, [], "nothing to reuse yet");
		assert.deepEqual(job.lib.entries(), ["t1"]);
		assert.equal(job.lib.stats("t1").domain, "script-delivery");
		// The adopted harness equals the probed candidate, so its probe is reused: no "final" run.
		assert.deepEqual([...new Set(stages)], ["reference", "propose", "probe", "compose", "reflect"]);

		// Task 2 has no hint: only the library can bring the fix.
		const [t2] = loadFolderTasks([task(root, "t2", "Write another script.\n")]);
		const s2 = await job.trainTask(t2);
		assert.equal(s2.used.length, 1);
		assert.deepEqual(s2.used[0], { entry: "t1", cited: true, containment: 1, kept: true });
		assert.equal(s2.provenance.t1, 1, "the adopted harness came from the library entry");
		assert.deepEqual(s2.revised, ["t1"], "the reflector revised the reused entry");
		const st = job.lib.stats("t1");
		assert.equal(st.uses.length, 1);
		assert.equal(st.uses[0].task, "t2");
		assert.equal(st.revisions.length, 1);
		assert.match(job.lib.experience("t1"), /## History\n- this task: confirmed/);
		assert.ok(existsSync(join(job.lib.dir, "t1", "EXPERIENCE.v1.md")), "the previous version is kept");
		const index = readFileSync(join(job.lib.dir, "INDEX.md"), "utf8");
		assert.match(index, /## script-delivery/);
		assert.match(index, /`t1\/`.*reused 1×, kept after probing 1×; revised 1×/);

		// Held-out ablation: with the frozen library vs an empty one.
		const [h] = loadFolderTasks([task(root, "held", "Write a third script.\n")]);
		const before = JSON.stringify(job.lib.stats("t1"));
		const abl = await ablateLibrary(job, [h], 2, job.lib, { held: h.fingerprint() }, () => {});
		assert.equal(abl.rows[0].withLib.meanPct, 100);
		assert.equal(abl.rows[0].withoutLib.meanPct, 0);
		assert.ok(abl.rows[0].usedEntries.includes("t1") || abl.rows[0].usedEntries.includes("t2"));
		assert.equal(JSON.stringify(job.lib.stats("t1")), before, "the ablation never writes to the library");
		assert.ok(!job.lib.entries().includes("held"), "held-out tasks never enter the library");

		// Consolidation reads the evolved library; the evidence gate accepts the cited entry.
		const cons = await job.consolidate();
		assert.ok(cons.tree["skills/verify-run/SKILL.md"]);
		assert.equal(cons.fellBack, false);
	} finally {
		await limiter.stop();
	}

	// Re-learning the same task: it never sees its own entry, and the entry keeps its history.
	const again = await newJob("job-a2", paths);
	try {
		const [t2again] = loadFolderTasks([join(root, "t2")]);
		const usesBefore = again.job.lib.stats("t1").uses.length;
		const r = await again.job.trainTask(t2again);
		assert.ok(!r.used.some((u) => u.entry === "t2"), "own entry is never offered");
		assert.equal(again.job.lib.stats("t1").uses.length, usesBefore + 1);
		assert.ok(again.job.lib.stats("t2").revisions.some((x) => x.summary === "re-learned from the same task"));
	} finally {
		await again.limiter.stop();
	}

	// A later /learn (new job, same state) can retire an entry the evidence supersedes.
	const second = await newJob("job-b", paths);
	try {
		const [t3] = loadFolderTasks([task(root, "t3", "Write a script again. RETIRE\n")]);
		const s3 = await second.job.trainTask(t3);
		assert.ok(s3.retired.length >= 1);
		for (const e of s3.retired) assert.ok(!second.job.lib.entries().includes(e));
	} finally {
		await second.limiter.stop();
	}
});
