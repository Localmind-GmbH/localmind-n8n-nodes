# @localmind/n8n-nodes-localmind

n8n community nodes for [Localmind](https://localmind.ai). Use Localmind agents, conversations, documents and files in your n8n workflows, and use a Localmind agent as the chat model of n8n's AI Agent.

- **Localmind**: ask agents, hold conversations with files and code execution, and search and manage the documents and files of your spaces.
- **Localmind Chat Model**: a Localmind agent as the language model of n8n's AI Agent and AI chains.

A Localmind agent calling an n8n workflow needs no package: see [Workflow as agent tool](https://github.com/Localmind-GmbH/localmind-n8n-nodes/blob/main/docs/customer-guide.md#workflow-as-agent-tool).

**[Customer guide](https://github.com/Localmind-GmbH/localmind-n8n-nodes/blob/main/docs/customer-guide.md)** · [Compatibility](#compatibility) · [Changelog](https://github.com/Localmind-GmbH/localmind-n8n-nodes/blob/main/CHANGELOG.md) · [Security](#security)

## Requirements

- Self-hosted n8n 2.16 or later.
- Localmind with a user API key ([how to create one](https://github.com/Localmind-GmbH/localmind-n8n-nodes/blob/main/docs/customer-guide.md#1-create-an-api-key)). Tested on Localmind 1.5.0, 1.6.0 and 1.7.0; see [Compatibility](#compatibility).

## Installation

In n8n, go to **Settings > Community Nodes > Install**, enter `@localmind/n8n-nodes-localmind` and confirm. The nodes then appear as **Localmind** and **Localmind Chat Model**.

For Docker and Kubernetes (the environment-managed package list), queue mode and air-gapped installations with a verified package file, see [Install the package](https://github.com/Localmind-GmbH/localmind-n8n-nodes/blob/main/docs/customer-guide.md#2-install-the-package).

## Credentials

Create a credential of type **Localmind API**:

| Field                        | Value                                                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API URL                      | Your Localmind API host, usually ending in `-api` (for example `https://acme-api.example.com`), not the app host ending in `-app`. It must use `https://`; plain `http://` only works for local testing. |
| API Key                      | A Localmind user API key (`sk-…`). The nodes act with its user's permissions and within the key's space limits.                                                                                         |
| Allowed HTTP Request Domains | Leave it at **None**. It only concerns n8n's HTTP Request node and keeps the key from being sent to other hosts. The Localmind nodes are not affected.                                                  |

Saving the credential tests the key by listing the agents it can use. From n8n 2.34.0 on, the test says what to fix, for example a wrong key or the app host instead of the API host; older n8n shows its general messages. For a technical user, keys limited to spaces and key rotation, see [Key model for integrations](https://github.com/Localmind-GmbH/localmind-n8n-nodes/blob/main/docs/customer-guide.md#key-model-for-integrations).

## Nodes

### Localmind

| Resource     | Operations                                                                      |
| ------------ | ------------------------------------------------------------------------------- |
| Agent        | Ask, Get (agent configuration), Get Many (all agents the key can use)           |
| Conversation | Create, Get, Get Many, Get Messages, Delete, Send Message                       |
| Document     | Search, Get, Get Many, Get Text, Get Chunks, Reprocess, Update Metadata, Delete |
| File         | Upload, List, Download, Download by URL, Move or Rename, Delete                 |
| Job          | Get (status of a processing run, optionally waiting until it ends)              |
| Space        | Get Many                                                                        |

Agents, spaces, conversations and documents are picked from a searchable list or entered by ID, and folders from a dropdown. Get Many operations support **Return All** with paging, and operations with large answers have a **Simplify** option. The node can also be a tool of n8n's AI Agent: read the [safety notes](https://github.com/Localmind-GmbH/localmind-n8n-nodes/blob/main/docs/customer-guide.md#localmind-as-an-ai-tool) first.

### Which operation for which case

| Need                                                                                   | Use                                                     |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| One answer, with your own system message, temperature, maximum tokens or JSON output   | Agent → Ask                                             |
| PDF or Office documents read by the agent for one answer                               | Agent → Ask                                             |
| Several steps that build on each other, code execution, generated files (Excel, Word…) | Conversation → Create, then Send Message                |
| An Excel or other file the agent opens and works on in code                            | Conversation → Send Message (Localmind 1.7.0) |
| Find passages in a space's documents, or add documents to a space                      | Document → Search, File → Upload                        |
| A Localmind agent inside n8n's AI Agent or an AI chain                                 | Localmind Chat Model                                    |

The full table and every operation in detail are in the customer guide: [Which operation for which case](https://github.com/Localmind-GmbH/localmind-n8n-nodes/blob/main/docs/customer-guide.md#which-operation-for-which-case) and [Operations in detail](https://github.com/Localmind-GmbH/localmind-n8n-nodes/blob/main/docs/customer-guide.md#operations-in-detail).

### Localmind Chat Model

A chat model sub-node for n8n's AI Agent and chains. The selected Localmind agent answers with its own knowledge, skills and tools.

- **No n8n tools.** Localmind does not call tools connected in n8n. When tools are connected to the AI Agent, the node stops with an error instead of ignoring them.
- **Output parser** ("Require Specific Output Format") works. On n8n 2.16 only with streaming switched off in the AI Agent.
- **Files from the chat:** PDFs reach the agent with the AI Agent's option "Automatically Passthrough Binary PDFs" (n8n 2.41 or later), text and CSV files as text. Images and Office files do not; use Agent → Ask for those.
- **No generated files** come back through the chat model; use the Localmind node for that.
- **Agent failures are errors:** an `[Error: …]` answer, an agent stopped at its step limit, an empty answer, or (from Localmind 1.6.0) all code sandboxes busy.

## Good to know

- **Retries:** the nodes retry what is safe to repeat. n8n's own **Retry On Fail** runs the whole node again, so leave it off for Send Message and File → Upload, or the message or file is sent twice.
- **Long tasks:** Ask waits at most 10 minutes, Localmind's limit for one answer. Send Message waits 15 minutes by default, and can also return at once so that a later step reads the answer with Get Messages.
- **Generated files** come back as binary fields (`file_0`, `file_1`, …): by default at most 10 files of up to 50 MB each.
- **Answer language:** from Localmind 1.7.0, agents answer in the language of the message; before, in the key user's interface language.

All details: [Operations in detail](https://github.com/Localmind-GmbH/localmind-n8n-nodes/blob/main/docs/customer-guide.md#operations-in-detail), [Known limits](https://github.com/Localmind-GmbH/localmind-n8n-nodes/blob/main/docs/customer-guide.md#known-limits) and [Troubleshooting](https://github.com/Localmind-GmbH/localmind-n8n-nodes/blob/main/docs/customer-guide.md#troubleshooting).

## Compatibility

**n8n 2.16 or later.** The Chat Model is built on n8n's AI node SDK, which n8n provides from 2.16 on, and n8n loads a package as a whole. Some features need a newer n8n: the environment-managed package list 2.21, the credential test's own messages 2.34, and PDFs from the chat and an output parser with streaming 2.41. Tested on n8n 2.16, 2.41 and 2.46.

**Localmind:** tested on 1.7.0, 1.6.0, and on 1.5.0 without code execution. The nodes are built for 1.0.0 and later; versions before 1.5.0 are not tested.

Some features depend on the Localmind version:

| Feature                                                                                                  | From Localmind  |
| -------------------------------------------------------------------------------------------------------- | --------------- |
| Agent → Ask with PDF, Office, text and CSV documents                                                     | 1.3.0           |
| Send Message waits for a free code sandbox (before, it fails with "No code-execution slot was free")     | 1.3.0           |
| Ask and the Chat Model use the agent's skills; all code steps of a request share one sandbox             | 1.6.0           |
| Ask and the Chat Model report busy code sandboxes as an error (before, the agent answers without code)   | 1.6.0           |
| Send Message waits with a lighter status check, faster in long conversations                             | 1.6.0           |
| Audio and HTML uploads are only stored, not indexed (before, Localmind marks them as failed)             | 1.6.0           |
| Send Message with PDF, Office and other files: the agent gets their text and the original in its sandbox | 1.7.0, upcoming |
| Generated files whose names have characters outside Latin-1 (such as "–" or emoji) can be downloaded     | 1.7.0, upcoming |
| Generated files carry an AI label (EU AI Act)                                                            | 1.7.0, upcoming |
| Agents answer in the language of the message and no longer see the key user's name and email             | 1.7.0, upcoming |
| Ask and the Chat Model retry a rate limit that came before the agent acted                               | 1.7.0, upcoming |

## Development

Needs Node.js 22.12 or later. The published package itself runs on the Node.js of your n8n.

```bash
npm ci --ignore-scripts  # install the dev tools without their install scripts
npm run dev              # n8n with the nodes and hot reload on http://localhost:5678
npm test                 # unit tests (Vitest)
npm run typecheck        # TypeScript check of the code and the tests
npm run lint             # n8n community node lint (strict mode)
npm run build
npm run check:package    # after the build: checks what the package would contain
```

Every pull request and every push to `main` runs lint, type check, tests and build, verifies the dependencies' signatures and checks the package contents. Releases are built by GitHub Actions and published with npm provenance after two approvals: on GitHub, and on npm with 2FA.

## Security

Please report security problems privately, not in a public issue. The [security policy](https://github.com/Localmind-GmbH/localmind-n8n-nodes/blob/main/SECURITY.md) says how.

## License

[MIT](https://github.com/Localmind-GmbH/localmind-n8n-nodes/blob/main/LICENSE.md)
