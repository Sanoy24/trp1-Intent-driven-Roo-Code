/**
 * Patch Utils - Extract file paths from unified diff / patch content
 */

export function extractPathsFromPatch(patch: string): string[] {
	const paths = new Set<string>()
	const markers = ["--- a/", "+++ b/", "*** Update File: ", "*** Add File: ", "*** Delete File: "]
	const lines = patch.split("\n")

	for (const line of lines) {
		for (const marker of markers) {
			if (line.startsWith(marker)) {
				const candidate = line.slice(marker.length).trim()
				if (candidate && candidate !== "/dev/null") {
					paths.add(candidate)
				}
			}
		}
	}

	return Array.from(paths)
}

export function extractFirstPathFromPatch(patch: string): string | undefined {
	const paths = extractPathsFromPatch(patch)
	return paths[0]
}
