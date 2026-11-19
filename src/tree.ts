import { chmodSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { writeText } from "./util.ts";

/** A harness overlay: path relative to the pi agent dir -> file content. */
export type Tree = Record<string, string>;

const IGNORE = /(^|\/)(__pycache__|\.pytest_cache|node_modules|\.git)(\/|$)|\.pyc$|(^|\/)\.DS_Store$/;

export function readTree(dir: string): Tree {
	const out: Tree = {};
	if (!existsSync(dir)) return out;
	const walk = (d: string) => {
		for (const name of readdirSync(d).sort()) {
			const p = join(d, name);
			const rel = relative(dir, p).split(sep).join("/");
			if (IGNORE.test(rel)) continue;
			const st = statSync(p);
			if (st.isDirectory()) walk(p);
			else if (st.isFile()) out[rel] = readFileSync(p, "utf8");
		}
	};
	walk(dir);
	return out;
}

export function writeTree(tree: Tree, dir: string): void {
	for (const [rel, text] of Object.entries(tree)) {
		const p = join(dir, rel);
		writeText(p, text);
		if (rel.includes("/scripts/") || text.startsWith("#!")) chmodSync(p, 0o755);
	}
}

export function treesEqual(a: Tree, b: Tree): boolean {
	const ka = Object.keys(a).sort();
	const kb = Object.keys(b).sort();
	return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

export function treeHash(t: Tree): string {
	return JSON.stringify(Object.keys(t).sort().map((k) => [k, t[k]]));
}

/** Unified diff of two trees (own LCS line diff, 3 lines of context). */
export function treeDiff(a: Tree, b: Tree): string {
	const out: string[] = [];
	for (const rel of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
		const x = a[rel];
		const y = b[rel];
		if (x === y) continue;
		out.push(`--- ${x === undefined ? "/dev/null" : `a/${rel}`}`);
		out.push(`+++ ${y === undefined ? "/dev/null" : `b/${rel}`}`);
		out.push(...hunks(splitLines(x ?? ""), splitLines(y ?? "")));
	}
	return out.join("\n") + (out.length ? "\n" : "");
}

function splitLines(s: string): string[] {
	if (s === "") return [];
	const lines = s.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

type Op = { t: " " | "-" | "+"; s: string };

function lineOps(a: string[], b: string[]): Op[] {
	// Trim common prefix/suffix, then LCS on the middle. Fall back to replace-all when the
	// middle is too large for an O(n*m) table.
	let pre = 0;
	while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
	let suf = 0;
	while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
	const A = a.slice(pre, a.length - suf);
	const B = b.slice(pre, b.length - suf);
	const ops: Op[] = a.slice(0, pre).map((s) => ({ t: " ", s }));
	if (A.length * B.length > 4_000_000) {
		ops.push(...A.map((s): Op => ({ t: "-", s })), ...B.map((s): Op => ({ t: "+", s })));
	} else {
		const n = A.length;
		const m = B.length;
		const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
		for (let i = n - 1; i >= 0; i--)
			for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
		let i = 0;
		let j = 0;
		while (i < n && j < m) {
			if (A[i] === B[j]) {
				ops.push({ t: " ", s: A[i] });
				i++;
				j++;
			} else if (L[i + 1][j] >= L[i][j + 1]) ops.push({ t: "-", s: A[i++] });
			else ops.push({ t: "+", s: B[j++] });
		}
		while (i < n) ops.push({ t: "-", s: A[i++] });
		while (j < m) ops.push({ t: "+", s: B[j++] });
	}
	ops.push(...a.slice(a.length - suf).map((s): Op => ({ t: " ", s })));
	return ops;
}

function hunks(a: string[], b: string[], ctx = 3): string[] {
	const ops = lineOps(a, b);
	const out: string[] = [];
	let k = 0;
	while (k < ops.length) {
		if (ops[k].t === " ") {
			k++;
			continue;
		}
		let start = Math.max(0, k - ctx);
		let end = k;
		// extend while changes are within 2*ctx of each other
		while (end < ops.length) {
			if (ops[end].t !== " ") {
				end++;
				continue;
			}
			let run = 0;
			while (end + run < ops.length && ops[end + run].t === " ") run++;
			if (end + run >= ops.length || run > 2 * ctx) {
				end = Math.min(ops.length, end + ctx);
				break;
			}
			end += run;
		}
		let ai = 0;
		let bi = 0;
		for (let q = 0; q < start; q++) {
			if (ops[q].t !== "+") ai++;
			if (ops[q].t !== "-") bi++;
		}
		const body = ops.slice(start, end);
		const aLen = body.filter((o) => o.t !== "+").length;
		const bLen = body.filter((o) => o.t !== "-").length;
		out.push(`@@ -${aLen ? ai + 1 : ai},${aLen} +${bLen ? bi + 1 : bi},${bLen} @@`);
		for (const o of body) out.push(o.t + o.s);
		k = end;
		start = end;
	}
	return out;
}
