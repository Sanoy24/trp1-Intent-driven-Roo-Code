/**
 * Intent Context Loader - Reads and parses active_intents.yaml
 * Loads intent metadata and constructs context for LLM injection
 */

import * as fs from "fs/promises"
import * as path from "path"
import * as yaml from "yaml"
import { ActiveIntent, IntentMetadata } from "./types"

export class IntentContextLoader {
	private workspaceRoot: string
	private orchestrationDir: string

	constructor(workspaceRoot: string) {
		this.workspaceRoot = workspaceRoot
		this.orchestrationDir = path.join(workspaceRoot, ".orchestration")
	}

	/**
	 * Load all active intents from YAML file
	 * @returns Array of intent metadata
	 */
	async loadActiveIntents(): Promise<IntentMetadata[]> {
		try {
			const yamlPath = path.join(this.orchestrationDir, "active_intents.yaml")
			try {
				const content = await fs.readFile(yamlPath, "utf8")
				const data = yaml.parse(content) as ActiveIntent

				if (!data || !data.active_intents) {
					console.warn(`[IntentContextLoader] Malformed YAML at ${yamlPath}: missing active_intents key`)
					return []
				}

				// Normalize: support both 'id' and 'intent_id' as the primary key field
				const normalized = data.active_intents.map((raw: any) => ({
					...raw,
					id: raw.id ?? raw.intent_id,
				})) as IntentMetadata[]

				return normalized
			} catch (readError: any) {
				if (readError.code === "ENOENT") {
					// Expected if setup isn't done yet, but good to know WHERE it looked
					console.info(`[IntentContextLoader] No intents file found at ${yamlPath}`)
					return []
				}
				throw readError
			}
		} catch (error) {
			console.error(`[IntentContextLoader] Failed to load intents:`, error)
			throw error
		}
	}

	/**
	 * Load a specific intent by ID
	 * @param intentId The intent ID to load
	 * @returns Intent metadata or undefined if not found
	 */
	async loadIntent(intentId: string): Promise<IntentMetadata | undefined> {
		const intents = await this.loadActiveIntents()
		return intents.find((intent) => intent.id === intentId)
	}

	/**
	 * Construct XML context block for LLM injection
	 * @param intent The intent to create context for
	 * @returns XML string with intent context
	 */
	constructIntentContext(intent: IntentMetadata): string {
		const constraintsList = intent.constraints.map((c) => `  - ${c}`).join("\n")
		const scopeList = intent.owned_scope.map((s) => `  - ${s}`).join("\n")
		const criteriaList = intent.acceptance_criteria.map((c) => `  - ${c}`).join("\n")

		return `<intent_context>
<intent_id>${intent.id}</intent_id>
<intent_name>${intent.name}</intent_name>
<status>${intent.status}</status>

<architectural_constraints>
${constraintsList}
</architectural_constraints>

<owned_scope>
${scopeList}
</owned_scope>

<acceptance_criteria>
${criteriaList}
</acceptance_criteria>

<governance_rules>
- You MUST only modify files within the owned_scope
- All changes MUST respect the architectural_constraints
- Your work is complete when all acceptance_criteria are met
- If you need to edit files outside owned_scope, you MUST request scope expansion
</governance_rules>
</intent_context>`
	}

	/**
	 * Update intent status
	 * @param intentId The intent ID to update
	 * @param status New status
	 */
	async updateIntentStatus(intentId: string, status: "PENDING" | "IN_PROGRESS" | "DONE" | "BLOCKED"): Promise<void> {
		const intents = await this.loadActiveIntents()
		const intent = intents.find((i) => i.id === intentId)

		if (intent) {
			intent.status = status

			const yamlPath = path.join(this.orchestrationDir, "active_intents.yaml")
			const data: ActiveIntent = { active_intents: intents }
			await fs.writeFile(yamlPath, yaml.stringify(data), "utf8")
		}
	}

	/**
	 * Update intent's last trace reference
	 * @param intentId The intent ID to update
	 * @param traceId The trace record ID
	 */
	async updateLastTraceRef(intentId: string, traceId: string): Promise<void> {
		const intents = await this.loadActiveIntents()
		const intent = intents.find((i) => i.id === intentId)

		if (intent) {
			intent.last_trace_ref = traceId

			const yamlPath = path.join(this.orchestrationDir, "active_intents.yaml")
			const data: ActiveIntent = { active_intents: intents }
			await fs.writeFile(yamlPath, yaml.stringify(data), "utf8")
		}
	}

	/**
	 * Create a new intent and save to active_intents.yaml
	 * @param intentData The data for the new intent
	 * @returns The newly created intent ID
	 */
	async createIntent(intentData: Omit<IntentMetadata, "id" | "status" | "last_trace_ref">): Promise<string> {
		await this.ensureOrchestrationDir()
		const yamlPath = path.join(this.orchestrationDir, "active_intents.yaml")
		let intents: IntentMetadata[] = []

		try {
			intents = await this.loadActiveIntents()
		} catch (e) {
			// File might not exist yet, start fresh
		}

		// Determine next ID (e.g., INT-001 -> INT-002)
		let nextNum = 1
		for (const intent of intents) {
			const match = intent.id.match(/^INT-(\d+)$/)
			if (match) {
				const num = parseInt(match[1], 10)
				if (num >= nextNum) {
					nextNum = num + 1
				}
			}
		}

		const nextId = `INT-${nextNum.toString().padStart(3, "0")}`

		const newIntent: IntentMetadata = {
			id: nextId,
			name: intentData.name,
			status: "PENDING",
			created_at: new Date().toISOString(),
			owned_scope: intentData.owned_scope,
			constraints: intentData.constraints,
			acceptance_criteria: intentData.acceptance_criteria,
		}

		intents.push(newIntent)

		const data: ActiveIntent = { active_intents: intents }
		await fs.writeFile(yamlPath, yaml.stringify(data), "utf8")

		return nextId
	}

	/**
	 * Load shared brain (CLAUDE.md or AGENT.md) content
	 * Checks .orchestration/ first, then workspace root (per task doc)
	 * @returns Content of CLAUDE.md/AGENT.md or empty string
	 */
	async loadSharedBrain(): Promise<string> {
		const candidates = [
			path.join(this.orchestrationDir, "CLAUDE.md"),
			path.join(this.orchestrationDir, "AGENT.md"),
			path.join(this.workspaceRoot, "CLAUDE.md"),
			path.join(this.workspaceRoot, "AGENT.md"),
		]
		for (const filePath of candidates) {
			try {
				return await fs.readFile(filePath, "utf8")
			} catch {
				// continue to next candidate
			}
		}
		return ""
	}

	/**
	 * Append a categorized entry to CLAUDE.md (shared brain).
	 * Categories:
	 *   - LESSON: auto-appended when lint/tests fail (verification loop)
	 *   - DECISION: auto-appended when an intent completes (architectural decision)
	 *   - RULE: manually authored architectural constraints
	 * @param entry  The content body of the entry
	 * @param category The category label (defaults to "LESSON")
	 */
	async appendEntry(entry: string, category: "LESSON" | "DECISION" | "RULE" = "LESSON"): Promise<void> {
		await this.ensureOrchestrationDir()
		const claudePath = path.join(this.orchestrationDir, "CLAUDE.md")
		const timestamp = new Date().toISOString()
		const section = `\n## [${category}] ${timestamp}\n\n${entry}\n`

		try {
			await fs.appendFile(claudePath, section, "utf8")
		} catch {
			// File doesn't exist yet — create it with a header
			const header = `# Shared Brain — TRP1 Governed Workspace\n\nThis file is auto-managed by the Hook Engine.\nDo not edit LESSON or DECISION sections manually.\n`
			await fs.writeFile(claudePath, header + section, "utf8")
		}
	}

	/**
	 * Backwards-compatible alias for lint/test failure lessons.
	 * @param lesson The lesson text
	 */
	async appendLesson(lesson: string): Promise<void> {
		await this.appendEntry(lesson, "LESSON")
	}

	/**
	 * Ensure .orchestration directory exists
	 */
	async ensureOrchestrationDir(): Promise<void> {
		try {
			await fs.mkdir(this.orchestrationDir, { recursive: true })
		} catch {
			// Directory already exists
		}
	}
}
