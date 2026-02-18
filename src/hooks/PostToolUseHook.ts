/**
 * PostToolUseHook - Intercepts AFTER successful tool execution
 * Records trace, updates intent map, runs linters
 */

import * as path from "path"
import { HookContext } from "./types"
import { TraceSerializer } from "./TraceSerializer"
import { ContentHasher } from "./ContentHasher"
import { OptimisticLockManager } from "./OptimisticLockManager"
import { IntentContextLoader } from "./IntentContextLoader"

export class PostToolUseHook {
	private traceSerializer: TraceSerializer
	private lockManager: OptimisticLockManager
	private intentLoader: IntentContextLoader

	constructor(workspaceRoot: string, lockManager: OptimisticLockManager) {
		this.traceSerializer = new TraceSerializer(workspaceRoot)
		this.lockManager = lockManager
		this.intentLoader = new IntentContextLoader(workspaceRoot)
	}

	/**
	 * Execute post-tool-use actions
	 * @param context Hook context with tool information
	 * @param result The result from tool execution
	 */
	async execute(context: HookContext, result: any): Promise<void> {
		// Only process successful file writes
		if (context.toolName === "write_to_file" && context.filePath && context.activeIntentId) {
			await this.handleFileWrite(context, result)
		}

		// Handle command execution
		if (context.toolName === "execute_command") {
			await this.handleCommandExecution(context, result)
		}
	}

	/**
	 * Handle post-write-to-file actions
	 * @param context Hook context
	 * @param result Tool execution result
	 */
	private async handleFileWrite(context: HookContext, result: any): Promise<void> {
		if (!context.filePath || !context.activeIntentId) {
			return
		}

		try {
			// Compute content hash of written file
			const contentHash = await ContentHasher.computeFileHash(context.filePath)
			if (!contentHash) {
				return
			}

			// Determine mutation class (simplified - could be enhanced)
			const mutationClass = this.determineMutationClass(context)

			// Get model identifier from context or default
			const modelIdentifier = context.toolParams.modelIdentifier || "unknown"

			// Enhanced AST-level range computation for precise correlation
			const ranges = await this.computeAstRanges(context.filePath)

			// Append trace record
			const traceId = await this.traceSerializer.appendTrace({
				sessionId: context.sessionId,
				intentId: context.activeIntentId,
				filePath: context.filePath,
				startLine: 1,
				endLine: await this.getFileLineCount(context.filePath),
				contentHash,
				modelIdentifier,
				mutationClass,
				ranges,
			})

			// Update intent map
			await this.traceSerializer.updateIntentMap(context.activeIntentId, context.filePath, contentHash, traceId)

			// Update optimistic lock baseline
			await this.lockManager.updateBaseline(context.filePath)

			// Update intent's last trace reference
			await this.intentLoader.updateLastTraceRef(context.activeIntentId, traceId)

			// Run linter/formatter (optional - could trigger errors back to LLM)
			await this.runLinter(context.filePath)
		} catch (error) {
			console.error("PostToolUseHook error:", error)
			// Don't fail the tool execution, just log the error
		}
	}

	/**
	 * Handle post-command-execution actions
	 * @param context Hook context
	 * @param result Tool execution result
	 */
	private async handleCommandExecution(context: HookContext, result: any): Promise<void> {
		// Could log command execution to trace
		// For now, just a placeholder
	}

	/**
	 * Determine mutation class based on context
	 * @param context Hook context
	 * @returns Mutation class
	 */
	private determineMutationClass(context: HookContext): "AST_REFACTOR" | "INTENT_EVOLUTION" | "BUG_FIX" {
		// Simplified logic - could be enhanced with AI classification
		const params = context.toolParams

		if (params.description?.toLowerCase().includes("refactor")) {
			return "AST_REFACTOR"
		}

		if (params.description?.toLowerCase().includes("fix") || params.description?.toLowerCase().includes("bug")) {
			return "BUG_FIX"
		}

		return "INTENT_EVOLUTION"
	}

	/**
	 * Get line count of a file
	 * @param filePath Absolute path to file
	 * @returns Number of lines
	 */
	private async getFileLineCount(filePath: string): Promise<number> {
		try {
			const fs = await import("fs/promises")
			const content = await fs.readFile(filePath, "utf8")
			return content.split("\n").length
		} catch {
			return 0
		}
	}

	/**
	 * Run linter on file (placeholder)
	 * @param filePath Absolute path to file
	 */
	private async runLinter(filePath: string): Promise<void> {
		// Placeholder for linter integration
		// Could run ESLint, Prettier, etc. and feed errors back to LLM
	}

	/**
	 * Compute AST-level ranges for precise correlation
	 * @param filePath The file to analyze
	 * @returns Array of ranges with content hashes
	 */
	private async computeAstRanges(
		filePath: string,
	): Promise<Array<{ start_line: number; end_line: number; content_hash: string }>> {
		try {
			// For now, compute ranges based on file content analysis
			// This is a simplified approach - in production you'd want proper AST parsing
			const fs = await import("fs/promises")
			const content = await fs.readFile(filePath, "utf8")
			const lineCount = content.split("\n").length

			// For TypeScript/JavaScript files, try to identify function/class boundaries
			if (
				filePath.endsWith(".ts") ||
				filePath.endsWith(".tsx") ||
				filePath.endsWith(".js") ||
				filePath.endsWith(".jsx")
			) {
				return await this.analyzeJSTypescriptRanges(filePath, content, lineCount)
			}

			// Fallback to single range for entire file
			return [
				{
					start_line: 1,
					end_line: lineCount,
					content_hash: ContentHasher.computeHash(content),
				},
			]
		} catch (error) {
			console.error("Failed to compute AST ranges:", error)
			return []
		}
	}

	/**
	 * Analyze JavaScript/TypeScript files for AST node boundaries
	 * @param filePath The file being analyzed
	 * @param content File content
	 * @param lineCount Total lines
	 * @returns Array of ranges
	 */
	private async analyzeJSTypescriptRanges(
		filePath: string,
		content: string,
		lineCount: number,
	): Promise<Array<{ start_line: number; end_line: number; content_hash: string }>> {
		const ranges: Array<{ start_line: number; end_line: number; content_hash: string }> = []
		const lines = content.split("\n")

		// Track function/class boundaries
		let currentFunction: { start_line: number; start_content: string } | null = null

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]
			const lineNum = i + 1

			// Detect function/class declarations
			if (line.match(/^\s*(export\s+)?(async\s+)?(function|class|const|let|var)\s+\w+/)) {
				// Close previous function if open
				if (currentFunction) {
					const functionContent = lines.slice(currentFunction.start_line - 1, i).join("\n")
					ranges.push({
						start_line: currentFunction.start_line,
						end_line: i,
						content_hash: ContentHasher.computeHash(functionContent),
					})
				}
				currentFunction = { start_line: lineNum, start_content: line }
			}

			// Handle export default function
			if (line.match(/^\s*export\s+default\s+(function|async\s+function)/)) {
				if (currentFunction) {
					const functionContent = lines.slice(currentFunction.start_line - 1, i).join("\n")
					ranges.push({
						start_line: currentFunction.start_line,
						end_line: i,
						content_hash: ContentHasher.computeHash(functionContent),
					})
				}
				currentFunction = { start_line: lineNum, start_content: line }
			}
		}

		// Close final function if still open
		if (currentFunction) {
			const functionContent = lines.slice(currentFunction.start_line - 1).join("\n")
			ranges.push({
				start_line: currentFunction.start_line,
				end_line: lines.length,
				content_hash: ContentHasher.computeHash(functionContent),
			})
		}

		// If no functions/classes found, use entire file as single range
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
}
