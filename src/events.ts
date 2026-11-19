import { escapeRe, trunc } from "./util.ts";

export interface RunStats {
	trajectory: string;
	final: string;
	cost: number;
	toolCalls: number;
	toolErrors: number;
	tools: Record<string, number>;
	firstInputTokens: number | null;
	outputTokens: number;
	modelErrors: string[];
	system: { sections: string[]; addendum: string; skills: string[]; chars: number };
	skillReads: number;
	skillScriptRuns: number;
	/** Paths the agent touched through tools (read/edit/write), for the generality tripwire. */
	touchedPaths: string[];
}

const OBS_TRUNC = 10_000;

type Block = { type: string; text?: string; thinking?: string; name?: string; arguments?: unknown };

/** pi `--mode json` JSONL -> [ACTION]/[OBSERVATION]/[ERROR] trajectory + measurements. */
export function parseEvents(jsonl: string): RunStats {
	const lines: string[] = [];
	const s: RunStats = {
		trajectory: "",
		final: "",
		cost: 0,
		toolCalls: 0,
		toolErrors: 0,
		tools: {},
		firstInputTokens: null,
		outputTokens: 0,
		modelErrors: [],
		system: { sections: [], addendum: "", skills: [], chars: 0 },
		skillReads: 0,
		skillScriptRuns: 0,
		touchedPaths: [],
	};
	const touched = new Set<string>();
	for (const raw of jsonl.split("\n")) {
		if (!raw.trim()) continue;
		let e: { type?: string; message?: Record<string, unknown> };
		try {
			e = JSON.parse(raw);
		} catch {
			continue;
		}
		// Only fully assembled messages: streaming deltas split words across chunks.
		if (e.type !== "message_end" || !e.message) continue;
		const m = e.message as {
			role?: string;
			content?: string | Block[];
			sections?: Record<string, string>;
			usage?: { input?: number; cacheRead?: number; output?: number; cost?: { total?: number } };
			stopReason?: string;
			errorMessage?: string;
			isError?: boolean;
			toolName?: string;
		};
		const content: Block[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []);
		if (m.role === "system") {
			const sec = m.sections ?? {};
			s.system = {
				sections: Object.keys(sec),
				addendum: sec.addendum ?? "",
				skills: [...(sec.skills ?? "").matchAll(/<name>(.*?)<\/name>/g)].map((x) => x[1]),
				chars: Object.values(sec).reduce((a, v) => a + String(v ?? "").length, 0),
			};
		} else if (m.role === "user") {
			lines.push(`[TASK]\n${content.map((c) => c.text ?? "").join("")}`);
		} else if (m.role === "assistant") {
			const u = m.usage ?? {};
			s.cost += u.cost?.total ?? 0;
			s.outputTokens += u.output ?? 0;
			if (s.firstInputTokens === null) s.firstInputTokens = (u.input ?? 0) + (u.cacheRead ?? 0);
			for (const c of content) {
				if (c.type === "text" && c.text?.trim()) {
					lines.push(`[ASSISTANT]\n${c.text.trim()}`);
					s.final = c.text.trim();
				} else if (c.type === "thinking" && c.thinking?.trim()) {
					lines.push(`[THINKING]\n${trunc(c.thinking.trim(), 3000)}`);
				} else if (c.type === "toolCall" && c.name) {
					s.toolCalls++;
					s.tools[c.name] = (s.tools[c.name] ?? 0) + 1;
					const args = JSON.stringify(c.arguments ?? {});
					if (c.name === "read" && /\/skills\//.test(args)) s.skillReads++;
					else if (c.name === "bash" && /skills\//.test(args)) s.skillScriptRuns++;
					const a = (c.arguments ?? {}) as Record<string, unknown>;
					for (const k of ["path", "file_path", "filePath"]) if (typeof a[k] === "string") touched.add(a[k] as string);
					lines.push(`[ACTION] ${c.name} ${args}`);
				}
			}
			if (m.stopReason === "error") {
				s.modelErrors.push(m.errorMessage ?? "unknown");
				lines.push(`[ERROR] model error: ${m.errorMessage ?? ""}`);
			}
		} else if (m.role === "toolResult") {
			const text = content
				.filter((c) => c.type === "text")
				.map((c) => c.text ?? "")
				.join("");
			if (m.isError) s.toolErrors++;
			lines.push(`${m.isError ? "[ERROR]" : "[OBSERVATION]"} (${m.toolName ?? "?"})\n${trunc(text, OBS_TRUNC)}`);
		}
	}
	s.trajectory = lines.join("\n\n");
	s.touchedPaths = [...touched];
	return s;
}

/**
 * Leak tripwire on assembled text. Markers match as whole names, so a workspace file such
 * as `healthcheck.py` does not trip the marker `check.py`.
 */
export function leakHits(text: string, markers: string[]): string[] {
	return markers.filter((mk) => new RegExp(`(?<![\\w.-])${escapeRe(mk)}(?![\\w-])`).test(text));
}
