import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { existsSync } from "node:fs";
import { type Tree, writeTree } from "./tree.ts";
import { escapeRe, rmrf, runProc } from "./util.ts";

/*
 * The editable surface: an overlay on the user's pi agent dir. Each part uses a mechanism
 * pi already has:
 *   APPEND_SYSTEM.md          appended to the system prompt, sent with EVERY request
 *   skills/<n>/SKILL.md       name + description listed in the prompt; body read on demand
 *   skills/<n>/<files>        files bundled with that skill, referenced relative to it
 *   extensions/<n>.ts         a pi extension (hooks)
 */
const SURFACE = [
	/^APPEND_SYSTEM\.md$/,
	/^skills\/[a-z0-9][a-z0-9-]*\/SKILL\.md$/,
	/^skills\/[a-z0-9][a-z0-9-]*\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/,
	/^extensions\/[a-z0-9][a-z0-9-]*\.ts$/,
];

const PATH_REF = /(?<![\w/$.])((?:scripts|references|assets|templates)\/[A-Za-z0-9_.\-/]*[A-Za-z0-9_-])/g;
const ABS_PATH = /(\/tmp\/\S*|\/home\/\S*|\/Users\/\S*|[A-Za-z]:\\\S*|pi-autotune-work\S*)/g;

export interface ValidateOpts {
	/** Distinctive names from task workspaces; an installed overlay must not mention them. */
	forbidden: Set<string>;
	/** Skills the user's pi already has (outside the overlay this tool owns). */
	existingSkills: Set<string>;
	alwaysOnMax: number;
}

export function skillNames(tree: Tree): string[] {
	return Object.keys(tree)
		.map((r) => /^skills\/([^/]+)\/SKILL\.md$/.exec(r)?.[1])
		.filter((x): x is string => !!x);
}

/** Structure + portability + generality. Every message is fed back to the editor verbatim. */
export function validate(tree: Tree, o: ValidateOpts): string[] {
	const errs: string[] = [];
	for (const rel of Object.keys(tree)) {
		if (!SURFACE.some((r) => r.test(rel)))
			errs.push(`off-surface path: ${rel} (allowed: APPEND_SYSTEM.md, skills/<name>/..., extensions/<name>.ts)`);
	}
	const always = tree["APPEND_SYSTEM.md"] ?? "";
	if (always.length > o.alwaysOnMax)
		errs.push(`APPEND_SYSTEM.md is ${always.length} chars; cap ${o.alwaysOnMax} (it is sent with every request)`);
	if (/\{\{|\{[A-Za-z_][A-Za-z0-9_]*\}/.test(always)) errs.push("APPEND_SYSTEM.md contains template braces");
	if (/pi-autotune:(begin|end)/.test(always)) errs.push("APPEND_SYSTEM.md must not contain pi-autotune markers");
	for (const m of always.matchAll(PATH_REF))
		errs.push(`APPEND_SYSTEM.md references \`${m[1]}\`: bundle files inside a skill and reference them from its SKILL.md`);
	const skills = skillNames(tree);
	for (const name of skills) {
		const text = tree[`skills/${name}/SKILL.md`];
		const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
		if (!fm) {
			errs.push(`skills/${name}/SKILL.md: missing YAML frontmatter`);
			continue;
		}
		if (!new RegExp(`^name:\\s*['"]?${escapeRe(name)}['"]?\\s*$`, "m").test(fm[1]))
			errs.push(`skills/${name}/SKILL.md: frontmatter \`name:\` must be \`${name}\``);
		if (!/^description:\s*\S/m.test(fm[1])) errs.push(`skills/${name}/SKILL.md: frontmatter needs \`description:\``);
		if (!always.includes(name)) errs.push(`skill \`${name}\` has no trigger line in APPEND_SYSTEM.md, so it would rarely be used`);
		if (o.existingSkills.has(name)) errs.push(`skill \`${name}\` collides with a skill the user's pi already has`);
		for (const m of new Set([...text.matchAll(PATH_REF)].map((x) => x[1])))
			if (!(`skills/${name}/${m}` in tree)) errs.push(`skills/${name}/SKILL.md references \`${m}\`, which is not in skills/${name}/`);
	}
	for (const rel of Object.keys(tree)) {
		if (rel.startsWith("skills/") && !skills.includes(rel.split("/")[1])) errs.push(`${rel}: skill directory without SKILL.md`);
	}
	for (const [rel, text] of Object.entries(tree)) {
		if (/\$PI_HARNESS\b|\$\{?PI_AUTOTUNE/.test(text)) errs.push(`${rel}: uses a harness-only variable that does not exist in the user's pi`);
		for (const bad of new Set([...text.matchAll(ABS_PATH)].map((m) => m[1])))
			errs.push(`${rel}: absolute/temporary path \`${bad}\` will not exist in the user's pi`);
		const hits = [...o.forbidden].filter((n) => new RegExp(`(?<![\\w.-])${escapeRe(n)}(?![\\w-])`).test(text)).sort();
		if (hits.length)
			errs.push(
				`${rel}: names things from a task workspace ${JSON.stringify(hits)}. This overlay is installed for ALL future tasks: state the general rule, not this repo's files/functions`,
			);
	}
	return errs;
}

function onPath(bin: string): boolean {
	if (bin.includes("/")) return existsSync(bin);
	return (process.env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, bin)));
}

/**
 * Bundled scripts must run on this machine: a shebang whose interpreter is on PATH, and a
 * clean syntax check for the languages we can check without executing anything.
 */
export async function checkScripts(tree: Tree): Promise<string[]> {
	const errs: string[] = [];
	const scripts = Object.keys(tree).filter((r) => /^skills\/[^/]+\/scripts\/[^/]+$/.test(r));
	if (!scripts.length) return errs;
	const dir = mkdtempSync(join(tmpdir(), "pi-autotune-scripts-"));
	try {
		writeTree(tree, dir);
		for (const rel of scripts) {
			const text = tree[rel];
			const she = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(text);
			if (!she) {
				errs.push(`${rel}: needs a shebang line (e.g. #!/usr/bin/env python3) so the agent can run it directly`);
				continue;
			}
			const interp = she[1].endsWith("/env") ? she[2] : she[1];
			if (!interp || !onPath(interp)) {
				errs.push(`${rel}: interpreter \`${interp}\` is not installed on this machine; use python3 or sh`);
				continue;
			}
			const base = interp.split("/").pop() ?? "";
			const p = join(dir, rel);
			const check: [string, string[]] | null = /^python/.test(base)
				? [interp, ["-c", "import ast,sys; ast.parse(open(sys.argv[1]).read(), sys.argv[1])", p]]
				: /^(sh|bash|dash|zsh)$/.test(base)
					? [interp, ["-n", p]]
					: /^node$/.test(base)
						? [interp, ["--check", p]]
						: null;
			if (check) {
				const r = await runProc(check[0], check[1], { timeoutMs: 20_000 });
				if (r.code !== 0) errs.push(`${rel}: syntax check failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
			}
		}
	} finally {
		rmrf(dir);
	}
	return errs;
}

/** Distinctive identifiers (file names, snake_case, camelCase); plain words stay usable. */
export function distinctiveNames(names: Iterable<string>): Set<string> {
	const generic = new Set(["README.md", "README", "tests", "docs", "data", "test", "main", "utils", "index.ts", "index.js",
		"__init__.py", "conftest.py", "setup.py", "package.json", "tsconfig.json", "Makefile", "LICENSE", "SKILL.md",
		"APPEND_SYSTEM.md", "AGENTS.md", "CLAUDE.md", "pyproject.toml", "Cargo.toml", "go.mod", ".gitignore"]);
	const out = new Set<string>();
	for (const n of names) {
		if (generic.has(n) || n.length <= 3) continue;
		if (n.includes(".") || n.replace(/^_+|_+$/g, "").includes("_") || /[a-z][A-Z]/.test(n)) out.add(n);
	}
	return out;
}

const DEF_RE = /^\s*(?:export\s+)?(?:async\s+)?(?:def|class|function|func|fn|interface|type|struct)\s+([A-Za-z_]\w{3,})/gm;

export function definedNames(text: string): string[] {
	return [...text.matchAll(DEF_RE)].map((m) => m[1]);
}
