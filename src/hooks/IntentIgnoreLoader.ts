/**
 * Intent Ignore Loader - Loads .intentignore patterns
 * Excludes certain intents or files from scope enforcement when configured
 */

import * as fs from "fs/promises"
import * as path from "path"
import { minimatch } from "minimatch"

export interface IntentIgnoreConfig {
	/** Glob patterns for file paths to exclude from intent scope checks */
	excludedPaths: string[]
	/** Intent IDs to exclude from scope enforcement (e.g., for legacy code) */
	excludedIntents: string[]
}

export class IntentIgnoreLoader {
	private workspaceRoot: string

	constructor(workspaceRoot: string) {
		this.workspaceRoot = workspaceRoot
	}

	/**
	 * Load .intentignore from workspace root or .orchestration/
	 * Format: One pattern per line, # for comments
	 * Lines starting with intent: are intent ID exclusions
	 */
	async load(): Promise<IntentIgnoreConfig> {
		const config: IntentIgnoreConfig = {
			excludedPaths: [],
			excludedIntents: [],
		}

		const candidates = [
			path.join(this.workspaceRoot, ".intentignore"),
			path.join(this.workspaceRoot, ".orchestration", ".intentignore"),
		]

		for (const filePath of candidates) {
			try {
				const content = await fs.readFile(filePath, "utf8")
				const lines = content.split("\n")

				for (const line of lines) {
					const trimmed = line.trim()
					if (!trimmed || trimmed.startsWith("#")) continue

					if (trimmed.toLowerCase().startsWith("intent:")) {
						const intentId = trimmed.slice(7).trim()
						if (intentId && !config.excludedIntents.includes(intentId)) {
							config.excludedIntents.push(intentId)
						}
					} else {
						if (!config.excludedPaths.includes(trimmed)) {
							config.excludedPaths.push(trimmed)
						}
					}
				}
				break
			} catch (err: any) {
				if (err?.code !== "ENOENT") {
					console.warn(`[IntentIgnoreLoader] Failed to read ${filePath}:`, err)
				}
			}
		}

		return config
	}

	/**
	 * Check if a file path is excluded by .intentignore
	 */
	static isPathExcluded(relativePath: string, excludedPaths: string[]): boolean {
		const normalized = relativePath.replace(/\\/g, "/")
		return excludedPaths.some((pattern) => minimatch(normalized, pattern, { dot: true }))
	}

	/**
	 * Check if an intent is excluded by .intentignore
	 */
	static isIntentExcluded(intentId: string, excludedIntents: string[]): boolean {
		return excludedIntents.includes(intentId)
	}
}
