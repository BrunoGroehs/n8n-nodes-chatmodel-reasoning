import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class OpenAiCompatibleReasoningApi implements ICredentialType {
	name = 'openAiCompatibleReasoningApi';

	displayName = 'OpenAI Compatible API (Reasoning)';

	documentationUrl = 'https://openrouter.ai/docs';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
		},
		{
			displayName: 'Base URL',
			name: 'url',
			type: 'string',
			default: 'https://openrouter.ai/api/v1',
			description:
				'Base URL of the API. For OpenRouter use https://openrouter.ai/api/v1. For DeepSeek native use https://api.deepseek.com/v1.',
			required: true,
		},
	];
}
