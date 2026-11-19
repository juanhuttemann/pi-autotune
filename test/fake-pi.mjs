#!/usr/bin/env node
// A deterministic stand-in for `pi --mode json`, for testing the engine without models.
// It plays every role from the prompt it gets and emits pi-shaped JSON events.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const prompt = process.argv[process.argv.length - 1];
const agent = process.env.PI_CODING_AGENT_DIR;
const cwd = process.cwd();
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const write = (p, t) => {
	mkdirSync(join(p, ".."), { recursive: true });
	writeFileSync(p, t);
};
const skills = existsSync(join(agent, "skills")) ? readdirSync(join(agent, "skills")) : [];
out({ type: "message_end", message: { role: "system", sections: { addendum: read(join(agent, "APPEND_SYSTEM.md")), skills: skills.map((s) => `<skill><name>${s}</name></skill>`).join("") } } });
out({ type: "message_end", message: { role: "user", content: [{ type: "text", text: prompt }] } });
const say = (text, calls = []) =>
	out({ type: "message_end", message: { role: "assistant", usage: { input: 100, output: 10, cost: { total: 0.001 } }, content: [...calls.map((c) => ({ type: "toolCall", ...c })), ...(text ? [{ type: "text", text }] : [])] } });

const SKILL = "---\nname: verify-run\ndescription: when a script must be checked by running it\n---\nRun the program on a real input and inspect the output before saying it is done.\n";
const TRIGGER = "Use the `verify-run` skill when you deliver a script: run it before claiming it works.";
const ctx = join(cwd, "context");
const libEntries = () => (existsSync(join(ctx, "library")) ? readdirSync(join(ctx, "library")).filter((e) => existsSync(join(ctx, "library", e, "EXPERIENCE.md"))) : []);

if (prompt.includes("INVARIANT editor")) {
	const h = join(ctx, "harness");
	const task = read(join(ctx, "task.md"));
	const withSkill = libEntries().find((e) => existsSync(join(ctx, "library", e, "harness", "skills", "verify-run", "SKILL.md")));
	if (withSkill) {
		cpSync(join(ctx, "library", withSkill, "harness", "skills", "verify-run"), join(h, "skills", "verify-run"), { recursive: true });
		write(join(h, "APPEND_SYSTEM.md"), TRIGGER);
		say(`<notes>\nreused ${withSkill} -> verify-run skill -> ref1 claimed success without running\n</notes>`);
	} else if (task.includes("DISCOVER")) {
		write(join(h, "skills", "verify-run", "SKILL.md"), SKILL);
		write(join(h, "APPEND_SYSTEM.md"), TRIGGER);
		say("<notes>\nadded verify-run -> ref1 never ran the script\n</notes>");
	} else {
		write(join(h, "APPEND_SYSTEM.md"), "Be careful.");
		say("<notes>\nadded a caution line -> ref1 was hasty\n</notes>");
	}
} else if (prompt.includes("DOMAIN editor")) {
	say("<notes>\nKEEP_BASE -> nothing domain-specific to add\n</notes>");
} else if (prompt.includes("COMPOSER")) {
	const pool = join(ctx, "pool");
	const first = readdirSync(pool)[0];
	cpSync(join(pool, first, "harness"), join(ctx, "harness"), { recursive: true });
	const n = read(join(pool, first, "notes.md"));
	const ent = /reused (\S+)/.exec(n)?.[1];
	say(`<notes>\nkept -> ${first} edits -> its probe ran the script${ent ? ` (from ${ent})` : ""}\n</notes>`);
} else if (prompt.includes("EXPERIENCE REFLECTOR")) {
	const used = join(ctx, "library_used");
	if (existsSync(used))
		for (const e of readdirSync(used)) {
			const p = join(used, e, "EXPERIENCE.md");
			const retire = read(join(ctx, "record", "task.md")).includes("RETIRE");
			write(p, `${read(p)}\n## History\n- this task: confirmed running before claiming done -> probe ran it\n${retire ? "\n## Status\nretired: superseded in test\n" : ""}`);
		}
	write(join(cwd, "EXPERIENCE.md"), "## Domain\nscript-delivery\n\n## Situation\nA script must be delivered and checked.\n\n## Lessons\n1. **Run it before claiming done.** *Evidence*: ref1 vs probe. Confidence: high.\n\n## Components\nskills/verify-run\n\n## Unsupported\nnone\n");
	say("written");
} else if (prompt.includes("CONSOLIDATOR")) {
	const e = libEntries()[0];
	cpSync(join(ctx, "library", e, "harness"), join(ctx, "harness"), { recursive: true });
	say(`<notes>\nkept -> verify-run skill -> ${e}/ lesson 1 (confirmed in History)\n</notes>`);
} else {
	// The worker: does the task; checks its work only when the verify-run skill is installed.
	const calls = [{ name: "write", arguments: { path: "out.txt", content: "ok" } }];
	writeFileSync(join(cwd, "out.txt"), "ok\n");
	if (skills.includes("verify-run")) {
		writeFileSync(join(cwd, "checked.txt"), "ran it\n");
		calls.push({ name: "read", arguments: { path: join(agent, "skills", "verify-run", "SKILL.md") } });
	}
	say("Done.", calls);
}
