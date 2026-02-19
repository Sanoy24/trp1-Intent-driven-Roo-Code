/**
 * Linter Runner - Runs linters/tests and records lessons on failure
 * Feeds verification failures back to CLAUDE.md for agent self-correction
 */

import * as path from "path"
import { IntentContextLoader } from "./IntentContextLoader"

export interface LinterResult {
	success: boolean
	output: string
	errors: string[]
}

export class LinterRunner {
	private workspaceRoot: string
	private intentLoader: IntentContextLoader

	constructor(workspaceRoot: string) {
		this.workspaceRoot = workspaceRoot
		this.intentLoader = new IntentContextLoader(workspaceRoot)
	}

	/**
	 * Run linter on a file (ESLint, Prettier, or language-appropriate tool)
	 * On failure, append lesson to CLAUDE.md
	 */
	async runLinter(filePath: string): Promise<LinterResult> {
		const ext = path.extname(filePath)
		const relPath = path.relative(this.workspaceRoot, filePath).replace(/\\/g, "/")
		const result: LinterResult = { success: true, output: "", errors: [] }

		try {
			// Try ESLint for JS/TS (only if eslint is likely installed)
			if ([".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
				const eslintResult = await this.runCommand("npx", ["eslint", relPath, "--format", "compact"], "ESLint")
				if (!eslintResult.success && !this.isToolNotFound(eslintResult.output)) {
					result.success = false
					result.output = eslintResult.output
					result.errors = eslintResult.errors
					await this.recordLesson(`[LINTER FAIL] ${eslintResult.output}`, relPath)
					return result
				}
			}

			// Try Prettier check (only if prettier is likely installed)
			const prettierResult = await this.runCommand("npx", ["prettier", "--check", relPath], "Prettier")
			if (!prettierResult.success && !this.isToolNotFound(prettierResult.output)) {
				result.success = false
				result.output = prettierResult.output
				result.errors = prettierResult.errors
				await this.recordLesson(`[FORMAT] Prettier check failed: ${prettierResult.output}`, relPath)
				return result
			}
		} catch {
			// Linter not available - don't fail, just skip
			result.success = true
		}

		return result
	}

	/**
	 * Run tests for a file or related test file
	 * On failure, append lesson to CLAUDE.md
	 */
	async runTests(filePath: string): Promise<LinterResult> {
		const relPath = path.relative(this.workspaceRoot, filePath).replace(/\\/g, "/")
		const result: LinterResult = { success: true, output: "", errors: [] }

		try {
			// Try npm test / vitest / jest
			const pkgPath = path.join(this.workspaceRoot, "package.json")
			const fs = await import("fs/promises")
			const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8")).scripts || {}

			if (pkg.test) {
				const testResult = await this.runCommand("npm", ["run", "test", "--", "--run", relPath], "Test")
				if (!testResult.success) {
					result.success = false
					result.output = testResult.output
					result.errors = testResult.errors
					await this.recordLesson(`[TEST FAIL] ${testResult.output}`, relPath)
					return result
				}
			}
		} catch {
			// No package.json or test script - skip
		}

		return result
	}

	private async runCommand(
		cmd: string,
		args: string[],
		toolName: string,
	): Promise<{ success: boolean; output: string; errors: string[] }> {
		try {
			const { execFile } = await import("child_process")
			const { promisify } = await import("util")
			const execFileAsync = promisify(execFile)

			const { stdout, stderr } = await execFileAsync(cmd, args, {
				cwd: this.workspaceRoot,
				timeout: 15000,
				maxBuffer: 1024 * 1024,
			})

			const output = [stdout, stderr].filter(Boolean).join("\n").trim()
			return {
				success: true,
				output,
				errors: output ? output.split("\n").filter((l) => l.includes("error") || l.includes("Error")) : [],
			}
		} catch (err: any) {
			const output = err?.stdout || err?.stderr || err?.message || String(err)
			const errors = output.split("\n").filter((l: string) => l.trim().length > 0)
			return {
				success: false,
				output: `${toolName}: ${output}`,
				errors,
			}
		}
	}

	private isToolNotFound(output: string): boolean {
		const lower = output.toLowerCase()
		return (
			lower.includes("not found") ||
			lower.includes("command not found") ||
			lower.includes("cannot find module") ||
			lower.includes("enoent")
		)
	}

	private async recordLesson(lesson: string, filePath: string): Promise<void> {
		const fullLesson = `${lesson} (file: ${filePath})`
		await this.intentLoader.appendLesson(fullLesson)
	}
}
