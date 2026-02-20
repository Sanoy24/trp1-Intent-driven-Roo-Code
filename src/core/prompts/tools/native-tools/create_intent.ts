import type OpenAI from "openai"

const CREATE_INTENT_DESCRIPTION = `Create a new active intent for the workspace when no existing intent covers your current task, or all intents are marked DONE. 

Do NOT call this tool without checking first. Your first step should ALWAYS be to check available intents via list_active_intents. If you find an active intent that fits the task, you MUST select it using select_active_intent rather than creating a new one.

When you do need to create an intent, you must propose the following:
1. 'name': A short, human-readable title for the task.
2. 'owned_scope': An array of glob patterns representing the allowed files or directories you predict you will need to modify. Do not be overly broad (e.g., avoiding "*").
3. 'constraints': An array of technical or architectural rules you must follow during the task.
4. 'acceptance_criteria': An array of conditions that must be met to mark this intent as DONE.

Calling this tool will trigger a user approval flow. Ensure your proposed intent scope and constraints are logical and accurate.`

export default {
	type: "function",
	function: {
		name: "create_intent",
		description: CREATE_INTENT_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				name: {
					type: "string",
					description: "A concise name for the intent (e.g., 'Migrate Auth to JWT')",
				},
				owned_scope: {
					type: "array",
					items: {
						type: "string",
					},
					description:
						"File glob patterns defining the authorized modification scope (e.g., ['src/auth/**/*.ts'])",
				},
				constraints: {
					type: "array",
					items: {
						type: "string",
					},
					description: "Technical or architectural constraints the implementation must adhere to.",
				},
				acceptance_criteria: {
					type: "array",
					items: {
						type: "string",
					},
					description: "Conditions defining when this intent considers its goal accomplished.",
				},
			},
			required: ["name", "owned_scope", "constraints", "acceptance_criteria"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
