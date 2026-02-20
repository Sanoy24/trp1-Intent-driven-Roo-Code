/**
 * PostToolUseHook - Intercepts AFTER successful tool execution
 * Records trace, updates intent map, runs linters, records baseline on read
 */

import * as path from "path"
import * as fs from "fs/promises"
import { HookContext } from "./types"
import { TraceSerializer } from "./TraceSerializer"
import { ContentHasher } from "./ContentHasher"
import { OptimisticLockManager } from "./OptimisticLockManager"
import { IntentContextLoader } from "./IntentContextLoader"
import { LinterRunner } from "./LinterRunner"
import { extractPathsFromPatch } from "./PatchUtils"

/** File-modifying tools that require trace recording */
const FILE_MODIFYING_TOOLS = [
	"write_to_file",
	"apply_diff",
	"edit",
	"search_and_replace",
	"search_replace",
	"edit_file",
	"apply_patch",
] as const

export class PostToolUseHook {
	private traceSerializer: TraceSerializer
	private lockManager: OptimisticLockManager
	private intentLoader: IntentContextLoader
	private linterRunner: LinterRunner
	private workspaceRoot: string

	constructor(workspaceRoot: string, lockManager: OptimisticLockManager) {
		this.workspaceRoot = workspaceRoot
		this.traceSerializer = new TraceSerializer(workspaceRoot)
		this.lockManager = lockManager
		this.intentLoader = new IntentContextLoader(workspaceRoot)
		this.linterRunner = new LinterRunner(workspaceRoot)
	}

	/**
	 * Execute post-tool-use actions
	 */
	async execute(context: HookContext, result: any): Promise<void> {
		// Record baseline when agent reads a file (for optimistic locking)
		if (context.toolName === "read_file") {
			await this.handleReadFile(context)
			return
		}

		// Trace and post-process file modifications
		if (context.activeIntentId && this.isFileModifyingTool(context.toolName)) {
			const filePaths = this.getFilePathsForTool(context)
			for (const fp of filePaths) {
				const absPath = path.isAbsolute(fp) ? fp : path.join(context.workspaceRoot, fp)
				await this.handleFileModification(context, absPath, result)
			}
		}

		if (context.toolName === "execute_command") {
			await this.handleCommandExecution(context, result)
		}

		// Automate "DONE" transition on successful task completion
		if (context.toolName === "attempt_completion" && context.activeIntentId) {
			await this.handleCompletion(context)
		}
	}

	/** Mark intent as DONE when agent attempts completion */
	private async handleCompletion(context: HookContext): Promise<void> {
		if (!context.activeIntentId) return
		await this.intentLoader.updateIntentStatus(context.activeIntentId, "DONE")
	}

	/** Record baseline hash when agent reads files (enables optimistic locking) */
	private async handleReadFile(context: HookContext): Promise<void> {
		const paths = this.getReadFilePaths(context)
		for (const relPath of paths) {
			const absPath = path.join(context.workspaceRoot, relPath)
			await this.lockManager.recordBaseline(absPath)
		}
	}

	/** Extract paths from read_file params (path or files array) */
	private getReadFilePaths(context: HookContext): string[] {
		const p = context.toolParams
		if (p.path) return [p.path]
		if (Array.isArray(p.files)) {
			return p.files.map((f: { path: string }) => f.path).filter(Boolean)
		}
		return []
	}

	/** Get file path(s) for a file-modifying tool */
	private getFilePathsForTool(context: HookContext): string[] {
		const p = context.toolParams
		if (p.path) return [p.path]
		if (p.file_path) return [p.file_path]
		if (p.path_to_file) return [p.path_to_file]
		if (context.toolName === "apply_patch" && p.patch) {
			return extractPathsFromPatch(p.patch)
		}
		if (context.filePath) return [context.filePath]
		return []
	}

	private isFileModifyingTool(toolName: string): boolean {
		return FILE_MODIFYING_TOOLS.includes(toolName as (typeof FILE_MODIFYING_TOOLS)[number])
	}

	private async handleFileModification(context: HookContext, filePath: string, result: any): Promise<void> {
		if (!context.activeIntentId) return

		try {
			// Block-level content hash: for write_to_file use the written content; else hash file
			const contentHash = await this.getContentHash(context, filePath)
			if (!contentHash) return

			const mutationClass = this.determineMutationClass(context)
			const modelIdentifier = context.modelIdentifier
			const ranges = await this.computeAstRanges(filePath)

			const traceId = await this.traceSerializer.appendTrace({
				sessionId: context.sessionId,
				intentId: context.activeIntentId,
				filePath,
				startLine: 1,
				endLine: await this.getFileLineCount(filePath),
				contentHash,
				modelIdentifier,
				mutationClass,
				ranges,
			})

			await this.traceSerializer.updateIntentMap(context.activeIntentId, filePath, contentHash, traceId)
			await this.lockManager.updateBaseline(filePath)
			await this.intentLoader.updateLastTraceRef(context.activeIntentId, traceId)

			// Run linter and record lessons on failure
			const linterResult = await this.linterRunner.runLinter(filePath)
			if (!linterResult.success) {
				// Lesson already recorded by LinterRunner
			}
		} catch (error) {
			console.error("PostToolUseHook error:", error)
		}
	}

	/** Get content hash: block-level for write_to_file (params.content), else file hash */
	private async getContentHash(context: HookContext, filePath: string): Promise<string | null> {
		// write_to_file: hash the exact content written (block-level, spatial independence)
		if (context.toolName === "write_to_file" && context.toolParams.content) {
			return ContentHasher.computeHash(context.toolParams.content)
		}
		// Other tools: hash the modified file (apply_diff, edit, etc. modify in place)
		return ContentHasher.computeFileHash(filePath)
	}

	private determineMutationClass(context: HookContext): "AST_REFACTOR" | "INTENT_EVOLUTION" | "BUG_FIX" {
		const params = context.toolParams
		const desc = (params.description || params.reason || "").toLowerCase()
		const mutationClass = params.mutation_class || params.mutationClass

		if (mutationClass === "AST_REFACTOR" || mutationClass === "INTENT_EVOLUTION" || mutationClass === "BUG_FIX") {
			return mutationClass
		}
		if (desc.includes("refactor")) return "AST_REFACTOR"
		if (desc.includes("fix") || desc.includes("bug")) return "BUG_FIX"
		return "INTENT_EVOLUTION"
	}

	private async getFileLineCount(filePath: string): Promise<number> {
		try {
			const content = await fs.readFile(filePath, "utf8")
			return content.split("\n").length
		} catch {
			return 0
		}
	}

	private async computeAstRanges(
		filePath: string,
	): Promise<Array<{ start_line: number; end_line: number; content_hash: string }>> {
		try {
			const content = await fs.readFile(filePath, "utf8")
			const lineCount = content.split("\n").length

			if (
				filePath.endsWith(".ts") ||
				filePath.endsWith(".tsx") ||
				filePath.endsWith(".js") ||
				filePath.endsWith(".jsx")
			) {
				return await this.analyzeJSTypescriptRanges(content, lineCount)
			}

			return [
				{
					start_line: 1,
					end_line: lineCount,
					content_hash: ContentHasher.computeHash(content),
				},
			]
		} catch {
			return []
		}
	}

	private async analyzeJSTypescriptRanges(
		content: string,
		lineCount: number,
	): Promise<Array<{ start_line: number; end_line: number; content_hash: string }>> {
		const ranges: Array<{ start_line: number; end_line: number; content_hash: string }> = []
		const lines = content.split("\n")
		let currentFunction: { start_line: number } | null = null

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]
			const lineNum = i + 1

			if (line.match(/^\s*(export\s+)?(async\s+)?(function|class|const|let|var)\s+\w+/)) {
				if (currentFunction) {
					const functionContent = lines.slice(currentFunction.start_line - 1, i).join("\n")
					ranges.push({
						start_line: currentFunction.start_line,
						end_line: i,
						content_hash: ContentHasher.computeHash(functionContent),
					})
				}
				currentFunction = { start_line: lineNum }
			}

			if (line.match(/^\s*export\s+default\s+(function|async\s+function)/)) {
				if (currentFunction) {
					const functionContent = lines.slice(currentFunction.start_line - 1, i).join("\n")
					ranges.push({
						start_line: currentFunction.start_line,
						end_line: i,
						content_hash: ContentHasher.computeHash(functionContent),
					})
				}
				currentFunction = { start_line: lineNum }
			}
		}

		if (currentFunction) {
			const functionContent = lines.slice(currentFunction.start_line - 1).join("\n")
			ranges.push({
				start_line: currentFunction.start_line,
				end_line: lines.length,
				content_hash: ContentHasher.computeHash(functionContent),
			})
		}

		if (ranges.length === 0) {
			return [
				{
					start_line: 1,
					end_line: lineCount,
					content_hash: ContentHasher.computeHash(content),
				},
			]
		}

		return ranges
	}

	private async handleCommandExecution(context: HookContext, result: any): Promise<void> {
		// Placeholder for command execution trace logging
	}
}
