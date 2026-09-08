/**
 * Repo-bound trace rendering: the flavor that can be committed to a public
 * repository. The original session logs are NOT in that repo, so anything
 * that only dereferences against them is noise:
 * - `@L<line>` references and truncation tombstones → removed/shortened
 * - the private log pointer (`- s1 @L → …`) and the `@L` how-to note → removed
 * - absolute paths under the project dir → repo-relative
 * What stays: titles, distilled thoughts, arcs, edited file names (relative),
 * verdict, metrics — the data chain of the session remains followable.
 */

export function toRepoBound(traceMd: string, projectDir?: string): string {
	let s = traceMd;
	// truncation tombstones: keep the fact, drop the private pointer
	s = s.replace(/…⟨урезано, полный текст @L\d+⟩/g, "…⟨truncated⟩");
	s = s.replace(/…⟨truncated, full text @L\d+⟩/g, "…⟨truncated⟩");
	// private log pointer line
	s = s.replace(/^- s1 @L → .*$/gm, "");
	// the @L how-to note
	s = s.replace(/^> `@L<n>`.*$\n/gm, "");
	// frontmatter: the absolute private log path
	s = s.replace(/^\s*logFile: .*$/gm, "");
	// every remaining @L reference (line anchors are private coordinates)
	s = s.replace(/ ?@L\d+(?:(?:–|→|-\|?)L\d+)?/g, "");
	// absolute project paths → repo-relative
	if (projectDir) {
		const clean = projectDir.replace(/\/+$/, "");
		s = s.split(clean + "/").join("");
		s = s.split(clean).join(".");
	}
	// collapse whitespace runs left by removals
	s = s.replace(/\n{3,}/g, "\n\n");
	return s;
}
