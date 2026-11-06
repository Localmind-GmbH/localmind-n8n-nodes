import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import { listAgents } from '../../../shared/agents';
import {
	SANDBOX_BUSY_MESSAGE,
	agentErrorFromAnswer,
	isSandboxBusy,
	stepLimitFromAnswer,
	stepLimitMessage,
} from '../../../shared/errors';
import { attachGeneratedFiles, downloadSettings } from '../../../shared/files';
import { commaList, textParam } from '../../../shared/params';
import { completionTimeoutMs } from '../../../shared/polling';
import { rateLimitedBeforeAction } from '../../../shared/retry';
import { localmindApiRequest } from '../../../shared/transport';
import { getLimit } from '../common';
import {
	askAttachments,
	askFiles,
	askRequest,
	parseJsonAnswer,
	type AskOptions,
	type AskResponse,
} from './ask';
import { simplifyAgent } from '../simplify';

async function ask(this: IExecuteFunctions, itemIndex: number): Promise<INodeExecutionData[]> {
	const agentId = this.getNodeParameter('agent', itemIndex, '', { extractValue: true }) as string;
	const prompt = textParam(this.getNodeParameter('prompt', itemIndex));
	const options = this.getNodeParameter('options', itemIndex, {}) as AskOptions;
	const timeout = completionTimeoutMs(this.getNode(), options.timeoutMinutes, itemIndex);

	const names = commaList(options.attachments);
	const attachments = names.length ? await askAttachments.call(this, itemIndex, names) : [];
	const response = (await localmindApiRequest.call(this, {
		method: 'POST',
		path: '/chat/completions',
		body: askRequest(agentId, prompt, options, attachments),
		timeout,
		// Up to Localmind 1.6.0 a graph agent can hit the rate limit after its first tools ran; a
		// retry would repeat them.
		retryRateLimited: rateLimitedBeforeAction,
		itemIndex,
	})) as AskResponse;

	// Checked first: the busy notice replaces the answer, a later failure and JSON output.
	if (isSandboxBusy(response.notice)) {
		throw new NodeOperationError(this.getNode(), SANDBOX_BUSY_MESSAGE, {
			itemIndex,
			description:
				'Localmind ended the answer because all code sandboxes were busy. Try again later; a new attempt runs the whole request again, including tools the agent already used. Conversation → Send Message waits for a free sandbox instead.',
		});
	}

	const choice = response.choices?.[0];
	const answer = choice?.message?.content ?? '';
	const failure = agentErrorFromAnswer(answer);
	if (failure !== undefined) {
		throw new NodeApiError(
			this.getNode(),
			{ message: failure },
			{
				message: `Localmind: ${failure}`,
				description:
					'The Localmind agent failed while answering. Try again; if it keeps failing, check the agent in the Localmind app (its model, tools and credits).',
				itemIndex,
			},
		);
	}

	const files = askFiles(response);
	const stepLimit = stepLimitFromAnswer(answer);
	if (stepLimit !== undefined) {
		throw new NodeOperationError(this.getNode(), stepLimitMessage(stepLimit), {
			itemIndex,
			description:
				"The answer is incomplete. Raise the agent's step limit in Localmind, split the task into smaller prompts, or use Conversation → Send Message, where the agent can continue in the next message.",
		});
	}
	if (!answer.trim() && files.length === 0) {
		throw new NodeOperationError(this.getNode(), 'The agent returned no answer', {
			itemIndex,
			description:
				'Its last step produced no visible text, for example only reasoning. A Graph Agent that pauses at an approval step cannot run through Ask; use Conversation → Send Message.',
		});
	}

	const json: IDataObject = { agentId, text: answer };
	if (options.jsonOutput) {
		const output = parseJsonAnswer(answer);
		if (output === undefined) {
			throw new NodeOperationError(this.getNode(), "The agent's answer is not valid JSON", {
				itemIndex,
				description: `The answer starts with: ${answer.slice(0, 300)}`,
			});
		}
		json.output = output as IDataObject;
	}

	json.tokens = {
		prompt: response.usage?.prompt_tokens ?? 0,
		completion: response.usage?.completion_tokens ?? 0,
		total: response.usage?.total_tokens ?? 0,
	};
	json.finishReason = choice?.finish_reason ?? null;

	const item: INodeExecutionData = { json };
	await attachGeneratedFiles.call(
		this,
		item,
		files,
		downloadSettings.call(this, options),
		itemIndex,
	);
	return [item];
}

export async function executeAgent(
	this: IExecuteFunctions,
	operation: string,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	switch (operation) {
		case 'ask':
			return await ask.call(this, itemIndex);

		case 'get': {
			const agentId = this.getNodeParameter('agent', itemIndex, '', {
				extractValue: true,
			}) as string;
			const agent = await localmindApiRequest.call(this, {
				method: 'GET',
				path: `/agents/${encodeURIComponent(agentId)}`,
				itemIndex,
			});
			const simplify = this.getNodeParameter('simplify', itemIndex, true) as boolean;
			return [{ json: simplify ? simplifyAgent(agent as IDataObject) : (agent as IDataObject) }];
		}

		case 'getAll': {
			const limit = getLimit.call(this, itemIndex);
			const agents = await listAgents.call(this);
			return agents.slice(0, limit).map((agent) => ({
				json: {
					id: agent.id,
					name: agent.name,
					organizationId: agent.owned_by,
					createdAt: agent.created ? new Date(agent.created * 1000).toISOString() : undefined,
				},
			}));
		}
	}

	throw new NodeOperationError(this.getNode(), `Unknown agent operation "${operation}"`, {
		itemIndex,
	});
}
