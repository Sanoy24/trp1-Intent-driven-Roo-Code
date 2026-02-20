import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"
import type { Task } from "../task/Task"
import { IntentContextLoader } from "../../hooks/IntentContextLoader"
import { formatResponse } from "../prompts/responses"

export class CreateIntentTool extends BaseTool<"create_intent"> {
	readonly name = "create_intent" as const

	async execute(
		params: { name?: string; owned_scope?: string[]; constraints?: string[]; acceptance_criteria?: string[] },
		task: Task,
		callbacks: ToolCallbacks,
	): Promise<void> {
		const { pushToolResult, askApproval } = callbacks

		if (!params.name) {
			task.recordToolError("create_intent")
			pushToolResult(await task.sayAndCreateMissingParamError("create_intent", "name"))
			return
		}
		if (!params.owned_scope || !Array.isArray(params.owned_scope)) {
			task.recordToolError("create_intent")
			pushToolResult(await task.sayAndCreateMissingParamError("create_intent", "owned_scope"))
			return
		}
		if (!params.constraints || !Array.isArray(params.constraints)) {
			task.recordToolError("create_intent")
			pushToolResult(await task.sayAndCreateMissingParamError("create_intent", "constraints"))
			return
		}
		if (!params.acceptance_criteria || !Array.isArray(params.acceptance_criteria)) {
			task.recordToolError("create_intent")
			pushToolResult(await task.sayAndCreateMissingParamError("create_intent", "acceptance_criteria"))
			return
		}

		// Success: Format message for user approval
		const message = `Agent proposes creating new Intent:
Name: ${params.name}
Scope: ${JSON.stringify(params.owned_scope)}
Constraints: ${JSON.stringify(params.constraints)}
Acceptance Criteria: ${JSON.stringify(params.acceptance_criteria)}`

		// Use command ask type for general permission prompts
		const approved = await askApproval("command", message)

		if (approved) {
			try {
				const intentLoader = new IntentContextLoader(task.cwd)
				const newId = await intentLoader.createIntent(params as any)
				pushToolResult(
					`Successfully created and saved intent as ${newId}. You may now select it using select_active_intent.`,
				)
			} catch (error) {
				pushToolResult(
					formatResponse.toolError(
						`Failed to save intent: ${error instanceof Error ? error.message : String(error)}\n\nYou MUST immediately stop execution using the attempt_completion tool since you cannot proceed without an active intent.`,
					),
				)
			}
		} else {
			pushToolResult(
				formatResponse.toolError(
					"User declined the intent creation.\n\nYou MUST immediately stop execution using the attempt_completion tool since you cannot proceed without an active intent.",
				),
			)
		}
	}
}

export const createIntentTool = new CreateIntentTool()
