import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** What the widget shows. Mutated by the job; the widget reads it on every frame. */
export interface Progress {
	task: string;
	taskNo: number;
	tasks: number;
	steps: string[];
	stage: string;
	detail: string;
	started: number;
	stageStarted: number;
	/** running | waiting (for the user's answer) | done | failed */
	state: "running" | "waiting" | "done" | "failed";
}

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function clock(ms: number): string {
	const t = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(t / 3600);
	const m = Math.floor((t % 3600) / 60);
	const s = String(t % 60).padStart(2, "0");
	return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

type Paint = (color: string, text: string) => string;
const plain: Paint = (_c, t) => t;

/** Left and right parts on one line, the right one flush with the edge. */
function spread(left: string, right: string, width: number): string {
	const gap = width - visibleWidth(left) - visibleWidth(right);
	return gap >= 1 ? left + " ".repeat(gap) + right : truncateToWidth(`${left} ${right}`, width);
}

/** Render the progress widget for one frame. Pure: easy to test, no timers here. */
export function renderProgress(p: Progress, width: number, frame: number, now: number, paint: Paint = plain): string[] {
	const w = Math.max(20, width);
	const cur = p.steps.indexOf(p.stage);
	const spin = SPINNER[frame % SPINNER.length];
	const lead =
		p.state === "running"
			? paint("accent", spin)
			: p.state === "waiting"
				? paint("success", "✔")
				: p.state === "failed"
					? paint("error", "✖")
					: paint("success", "✔");
	const task = p.task ? `  ${paint("text", p.task)}${p.tasks > 1 ? paint("dim", ` (task ${p.taskNo} of ${p.tasks})`) : ""}` : "";
	// Overall bar: one cell per step; the current cell shimmers while running.
	const bar = p.steps
		.map((_, i) => {
			if (i < cur || p.state === "waiting" || p.state === "done") return paint("success", "▰");
			if (i === cur) return paint(frame % 6 < 3 ? "accent" : "muted", "▰");
			return paint("dim", "▱");
		})
		.join("");
	const elapsed = paint("muted", clock(now - p.started));
	const word = p.state === "running" ? "learning" : p.state === "failed" ? "learning failed" : "learned";
	const head = spread(`${lead} ${paint(p.state === "failed" ? "error" : "accent", word)}${task}   ${bar}`, elapsed, w);

	// Stepper: ✔ done ─ ⠹ current ┄ ○ next. Falls back to a compact form when narrow.
	const parts = p.steps.map((s, i) => {
		if (i < cur || (p.state !== "running" && cur >= 0 && i <= cur)) return paint("success", `✔ ${s}`);
		if (i === cur) return paint("accent", `${p.state === "running" ? spin : "▸"} ${s}`);
		return paint("dim", `○ ${s}`);
	});
	let stepper = parts[0] ?? "";
	for (let i = 1; i < parts.length; i++) stepper += paint(i <= cur ? "success" : "dim", i <= cur ? " ─ " : " ┄ ") + parts[i];
	const stepLine =
		visibleWidth(stepper) + 2 <= w
			? `  ${stepper}`
			: `  ${paint("dim", `step ${Math.max(cur, 0) + 1}/${p.steps.length}`)} ${paint("accent", `▸ ${p.stage || p.steps[0]}`)}`;

	const stepTime = p.state === "running" && cur >= 0 ? paint("dim", ` · this step ${clock(now - p.stageStarted)}`) : "";
	const detailColor = p.state === "failed" ? "error" : p.state === "waiting" ? "success" : "muted";
	const detail = `  ${paint(detailColor, p.detail || "preparing a copy of your pi config")}${stepTime}`;
	return [head, stepLine, detail].map((l) => truncateToWidth(l, w));
}
