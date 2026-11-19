import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Order models for a search. Empty query: the current choice, then the user's own models,
 * then everything else alphabetically. With a query: every word must appear (anywhere, any
 * case); exact names first, then names where the words appear earlier, then shorter names.
 */
export function rankModels(query: string, all: string[], familiar: string[], current?: string): string[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const mine = new Set(familiar);
	if (!words.length) {
		const first = [...(current && all.includes(current) ? [current] : []), ...familiar.filter((m) => m !== current && all.includes(m))];
		return [...first, ...all.filter((m) => !first.includes(m)).sort()];
	}
	const q = query.trim().toLowerCase();
	return all
		.filter((m) => words.every((w) => m.toLowerCase().includes(w)))
		.map((m) => {
			const l = m.toLowerCase();
			const id = l.slice(l.lastIndexOf("/") + 1);
			const score = (l === q || id === q ? 0 : 1000) + (mine.has(m) ? 0 : 100) + words.reduce((a, w) => a + l.indexOf(w), 0) / 100 + l.length / 1000;
			return { m, score };
		})
		.sort((a, b) => a.score - b.score)
		.map((x) => x.m);
}

type Paint = (color: string, text: string) => string;

export interface PickerState {
	query: string;
	selected: number;
}

/** Render the picker for one frame (pure, for tests). */
export function renderPicker(
	title: string,
	s: PickerState,
	matches: string[],
	total: number,
	familiar: Set<string>,
	width: number,
	paint: Paint = (_c, t) => t,
	maxVisible = 10,
): string[] {
	const w = Math.max(30, width);
	const lines: string[] = [paint("accent", title)];
	const count = paint("dim", `${matches.length} of ${total}`);
	const search = `  ${paint("muted", "search:")} ${s.query}${paint("accent", "▏")}`;
	const gap = w - visibleWidth(search) - visibleWidth(count);
	lines.push(gap >= 1 ? search + " ".repeat(gap) + count : search);
	if (!matches.length) lines.push(paint("warning", "  no model matches; delete a word"));
	const start = Math.max(0, Math.min(s.selected - Math.floor(maxVisible / 2), matches.length - maxVisible));
	for (const [i, m] of matches.slice(start, start + maxVisible).entries()) {
		const on = start + i === s.selected;
		const tag = familiar.has(m) ? paint("dim", "  yours") : "";
		lines.push(`${on ? paint("accent", "→ ") : "  "}${on ? paint("accent", m) : m}${tag}`);
	}
	if (matches.length > maxVisible) lines.push(paint("dim", `  … ${matches.length - maxVisible} more, keep typing or scroll`));
	lines.push(paint("dim", "  ↑↓ move · type to filter · enter select · esc cancel"));
	return lines.map((l) => truncateToWidth(l, w));
}
