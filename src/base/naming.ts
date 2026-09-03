/** Trace file naming: `<date>-<id8[-id8…]>-<slug>.md`. */

export function traceFileName(sessions: { sessionId: string; startedAt: string }[], title: string | undefined): string {
	const date = (sessions[0]?.startedAt ?? "1970-01-01").slice(0, 10);
	const ids = sessions
		.slice(0, 3)
		.map((s) => s.sessionId.slice(0, 8))
		.join("+");
	const suffix = sessions.length > 3 ? "+etc" : "";
	return `${date}-${ids}${suffix}-${slugify(title ?? "session")}.md`;
}

export function slugify(text: string, cap = 40): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-zа-я0-9]+/gi, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, cap)
		.replace(/-+$/g, "");
	return slug.length > 0 ? slug : "session";
}
