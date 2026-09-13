/**
 * Repo-bound trace rendering: the flavor that can be committed to a public
 * repository. The original session logs are NOT in that repo, so anything
 * that only dereferences against them is noise:
 * - `@L<line>` references and truncation tombstones → removed/shortened
 * - the private log pointer (`- s1 @L → …`) and the `@L` how-to note → removed
 * - absolute paths under the project dir → repo-relative
 * What stays: titles, distilled thoughts, arcs, edited file names (relative),
 * verdict, metrics — the data chain of the session remains followable.
 * - any other absolute path under the operator's home → `~/…` (no machine layout leaks)
 */

import { homedir } from "node:os";

export function toRepoBound(traceMd: string, projectDir?: string, home: string = homedir()): string {
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
	// every @L anchor, fully — bare `@L` glyphs left by ranges/arcs would read
	// as noise, and without the log there is nothing to point at
	s = s.replace(/ ?@L\d+(?:(?:–|→|-\|?)L\d+)?/g, "");
	s = s.replace(/ ?@L(?=[^\w]|\b)/g, "");
	// absolute project paths → repo-relative
	if (projectDir) {
		const clean = projectDir.replace(/\/+$/, "");
		s = s.split(clean + "/").join("");
		s = s.split(clean).join(".");
	}
	// any other absolute path under the operator's home (other repos, reports, dotfiles) → `~`
	const cleanHome = home.replace(/\/+$/, "");
	if (cleanHome.length > 1) s = s.split(cleanHome).join("~");
	// truncated renderings cut the home path mid-name (`/Users/alex…`), and other operators'
	// homes may appear in pasted output: mask any `/Users/<x>` or `/home/<x>` prefix as `~`
	s = s.replace(/\/(?:Users|home)\/[^/\s`'"()⟨⟩]*/g, "~");
	// collapse whitespace runs left by removals
	s = s.replace(/\n{3,}/g, "\n\n");
	return s;
}
