export const USAGE = `/learn                       learn from this session in the background; asks before applying
/learn undo                  restore your pi as it was before the last apply
/learn stop                  cancel a running /learn
/learn model                 change the improved model or the improver
/learn <task-folder>...      learn from task folders instead (task.md + workspace/)
/learn ... --verify <dir>    also measure the result on held-out task folders with checks`;

export interface Args {
	sub?: "undo" | "stop" | "help" | "model";
	folders: string[];
	verify?: string;
	runs?: number;
}

export function parseArgs(raw: string): Args {
	const toks = raw.match(/"[^"]*"|'[^']*'|\S+/g)?.map((t) => t.replace(/^["']|["']$/g, "")) ?? [];
	const a: Args = { folders: [] };
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i];
		if (i === 0 && (t === "undo" || t === "stop" || t === "help" || t === "model")) a.sub = t;
		else if (t === "--verify") a.verify = toks[++i];
		else if (t === "--runs") a.runs = Number(toks[++i]);
		else if (t.startsWith("--")) throw new Error(`unknown option ${t}\n\n${USAGE}`);
		else a.folders.push(t);
	}
	if (a.runs !== undefined && !(a.runs >= 1)) throw new Error("--runs needs a number >= 1");
	return a;
}
