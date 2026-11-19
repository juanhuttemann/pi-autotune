/** Seeded PRNG (mulberry32), so reported p-values are reproducible. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function shuffle<T>(xs: T[], r: () => number): void {
	for (let i = xs.length - 1; i > 0; i--) {
		const j = Math.floor(r() * (i + 1));
		[xs[i], xs[j]] = [xs[j], xs[i]];
	}
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Two-sided permutation test on the difference of means (b - a). */
export function permTest(a: number[], b: number[], iters = 20000, seed = 0): number {
	if (!a.length || !b.length) return 1;
	const r = rng(seed);
	const obs = Math.abs(mean(b) - mean(a));
	const pool = [...a, ...b];
	let hits = 0;
	for (let i = 0; i < iters; i++) {
		shuffle(pool, r);
		if (Math.abs(mean(pool.slice(a.length)) - mean(pool.slice(0, a.length))) >= obs - 1e-12) hits++;
	}
	return (hits + 1) / (iters + 1);
}

/** Pooled two-sided test across tasks: arm labels are shuffled within each task only. */
export function stratifiedPerm(groups: Array<[number[], number[]]>, iters = 20000, seed = 0): number {
	const gs = groups.filter(([a, b]) => a.length && b.length);
	if (!gs.length) return 1;
	const r = rng(seed);
	const stat = (g: Array<[number[], number[]]>) => mean(g.map(([a, b]) => mean(b) - mean(a)));
	const obs = Math.abs(stat(gs));
	let hits = 0;
	for (let i = 0; i < iters; i++) {
		const shuffled = gs.map(([a, b]): [number[], number[]] => {
			const pool = [...a, ...b];
			shuffle(pool, r);
			return [pool.slice(0, a.length), pool.slice(a.length)];
		});
		if (Math.abs(stat(shuffled)) >= obs - 1e-12) hits++;
	}
	return (hits + 1) / (iters + 1);
}

export function median(xs: number[]): number | null {
	if (!xs.length) return null;
	const s = [...xs].sort((x, y) => x - y);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
