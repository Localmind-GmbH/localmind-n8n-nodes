import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

export class LocalmindApi implements ICredentialType {
	name = 'localmindApi';

	displayName = 'Localmind API';

	documentationUrl = 'https://www.npmjs.com/package/@localmind/n8n-nodes-localmind#credentials';

	icon: Icon = { light: 'file:../icons/localmind.svg', dark: 'file:../icons/localmind.dark.svg' };

	properties: INodeProperties[] = [
		{
			displayName: 'API URL',
			name: 'url',
			type: 'string',
			required: true,
			default: '',
			placeholder: 'e.g. https://acme-api.example.com',
			description:
				'The API address of your Localmind instance: the host ending in "-api", not the app host ending in "-app". A trailing /v1 is ignored.',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'A Localmind user API key (starts with "sk-"). The nodes act with the permissions and space scopes of the key owner.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	// Lists the agents the key can use. An "-app" host answers API paths with an HTML 404.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{ $credentials.url.trim().replace(/\\/+$/, "").replace(/\\/v1$/i, "") }}',
			url: '/v1/models',
			// n8n would send the key along to whatever host a redirect points to.
			disableFollowRedirect: true,
		},
		rules: [
			{
				type: 'responseCode',
				properties: {
					value: 401,
					message: 'Localmind rejected the API key: it is wrong, deactivated or expired.',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 404,
					message:
						'No Localmind API at this URL. Use the API host ("…-api.…"), not the app host ("…-app.…").',
				},
			},
		],
	};
}
