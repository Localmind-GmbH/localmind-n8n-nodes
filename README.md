# @localmind/n8n-nodes-localmind

n8n community nodes for [Localmind](https://localmind.ai): use Localmind agents, conversations, documents and files in n8n workflows, and use a Localmind agent as the chat model of n8n's AI Agent.

Setting it up for the first time? The [customer guide](https://github.com/Localmind-GmbH/localmind-n8n-nodes/blob/main/docs/customer-guide.md) walks through the API key, installation (also offline), the credential and the known limits.

[Credentials](#credentials) · [Nodes](#nodes) · [Which operation for which case](#which-operation-for-which-case) · [Send Message](#send-message) · [Documents and files](#documents-and-files) · [Localmind Chat Model](#localmind-chat-model) · [Compatibility](#compatibility) · [Development](#development)

## Credentials

The **Localmind API** credential has two fields:

| Field   | Value                                                                                                                                                                                                                |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API URL | The API host of your Localmind instance, usually the one ending in `-api` (for example `https://acme-api.example.com`). The app host (usually ending in `-app`) does not serve the API. A trailing `/v1` is ignored. |
| API Key | A Localmind user API key (`sk-…`). The nodes act with the key owner's permissions and space scopes.                                                                                                                  |

Saving the credential lists the agents the key can use. A wrong key or an `-app` host fails with a message that says what to fix.

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

Agents, spaces, conversations and documents are picked from a searchable list or entered by ID; folders from a dropdown of the space's file manager. Get Many operations support "Return All" with paging.

Requests retry `429 Too Many Requests` and, for requests that are safe to repeat, `5xx` answers and dropped connections, waiting as long as the `Retry-After` header says or backing off exponentially. Requests that would act twice when repeated, such as sending a message, are not retried after a `5xx` or a dropped connection. Agent → Ask and the Chat Model without streaming are not retried after a `429` either: an agent built as a graph can hit the rate limit after its first tools ran, and a retry would repeat them. Errors read `Localmind: <detail>` and carry the HTTP status. n8n's own **Retry On Fail** runs the whole node again, so a Send Message or Upload that already succeeded is sent again: leave it off for those, and turn it on for Ask or the Chat Model only where repeating the agent's actions is acceptable.

### Which operation for which case

| Need                                                                                   | Use                                             |
| -------------------------------------------------------------------------------------- | ----------------------------------------------- |
| One answer, no history; own system message, temperature, maximum tokens or JSON output | Agent → Ask                                     |
| PDF, Office or other documents read by the agent for one answer                        | Agent → Ask                                     |
| Files the agent generates with code (Excel, Word, …)                                   | Agent → Ask or Conversation → Send Message      |
| Several steps that build on each other, or a specific space                            | Conversation → Create + Send Message            |
| Wait when all code sandboxes are busy                                                  | Conversation → Send Message                     |
| Limit the agent's tools for this job                                                   | Conversation → Send Message (Disabled Tool IDs) |
| Use a Localmind agent inside an n8n AI chain                                           | Localmind Chat Model, without n8n tools         |

### Ask

Sends one prompt to an agent through Localmind's OpenAI-compatible endpoint, without keeping a conversation. The agent runs in its home space. From Localmind 1.6.0 it also uses its skills, with all code steps of one request sharing one sandbox. When all code sandboxes are busy, Ask fails with an error from Localmind 1.6.0 on; before, the agent answers without running code.

- **Attachments:** JPEG, PNG, GIF and WebP images go to the vision model (other image types are refused); PDF, Office, text and CSV documents are read as text for this answer (at most 10 documents). Nothing is stored.
- **Timeout:** 10 minutes, also the most Localmind allows for one answer. For longer tasks use Send Message.
- **JSON Output:** asks the model for JSON and parses the answer into the `output` field. When no message mentions JSON, the node adds "Respond with a JSON object." (OpenAI models require it).
- **Generated files** are downloaded as binary fields `file_0`, `file_1`, … (the prefix is an option). Each entry in `files` also carries its download link. At most 10 files of up to 50 MB each are downloaded ('Max Files to Download', 'Max File Size (MB)'); a file over a limit, or one that fails to download, gets `errorMessage` and keeps its link, and the answer is kept. As a tool of an AI Agent, files are only downloaded when 'Download Files' is switched on explicitly. Images from the agent's image tool are not among them; they come as Markdown links at the start of `text`, which File → Download by URL can fetch.

### Send Message

Sends a message to a conversation and, by default, waits for the agent's answer.

- **Output:** the answer as `text`, the files the agent generated, token usage and, optionally, the tool calls. Generated files (for example Excel or Word files from code execution) are downloaded as binary fields `file_0`, `file_1`, … The same download limits apply as for Ask.
- **Waiting:** while the agent works, the node checks the conversation every 2 seconds. When the agent needs to run code and all code sandboxes are busy, the turn waits in Localmind's queue; the node then checks every 20 seconds, and every 10 seconds while the turn continues after the wait.
- **Timeout:** 15 minutes by default, adjustable. On a timeout the agent keeps working in Localmind. The error says what it was doing (working, or waiting for a sandbox at a given position) and gives the IDs to read the answer later with Get Messages.
- **Without waiting:** switch off "Wait for Answer" to get the conversation and message IDs at once, for jobs you expect to take long.
- **Attachments:** JPEG, PNG, GIF and WebP images and text files from the input's binary fields. PDF, Office and other files are refused; send PDF and Office documents with Agent → Ask.
- **Disabled tools:** tools the agent must not use, as tool IDs (Agent → Get lists them under `toolIds`). Skills count as tools; turning off all of them also turns off code execution. The list replaces the conversation's setting.
- **Errors:** a failed turn, a turn stopped in the Localmind app, a turn stopped at the agent's step limit, a turn without a free sandbox and an agent paused at an approval step (approvals need the Localmind app) stop the node with a clear message.
- **Get Messages** gives each assistant message a `status` (with Simplify on): `complete`, `in progress`, `waiting for a code sandbox`, `failed` or `incomplete` (a partial answer that a later one replaced), so a workflow that reads the answer later can tell whether it is final. A turn that continues after its sandbox wait counts as `in progress` until its final answer is saved; on Localmind up to 1.5.0 one whose resumed run failed looks the same. A message sent to the conversation while the resumed run works hides that run from the conversation's status; Get Messages then checks the latest three answers' own runs.

### Documents and files

- **File → Upload** stores a file in a space's file manager, where Localmind indexes it. By default the node waits until indexing is done (by default for up to 10 minutes; the timeout can be raised) and returns the document ID, so a following Document → Search finds the file. Audio and HTML files are only stored, not indexed. Archives are extracted into the folder and deleted; the node waits for each extracted file and lists them in `extractedFiles`, each with a `status`: `completed`, `failed`, `stored` (only stored, not indexed), `processing` (still being processed when the timeout ran out) or `unknown` (Localmind could not be asked, for example after a network error; the reason is in `errorMessage`).
- **Document → Search** finds text passages by meaning and keywords in one space, optionally limited to folders (`contracts/2024`, `invoices/*`) or documents, with a minimum score.
- **Document → Update Metadata** merges the given fields into the document's metadata; a field set to `null` is removed. Localmind's own fields (such as `original_filename`) cannot be changed or removed; changes to them are ignored.
- **Document → Delete** deletes the document's file through the file manager, which also removes the document and its search index. A document without a file there (for example a table Localmind turned into SQL) is deleted as a record only, which leaves its stored file and search entries behind; the output then says `recordOnly: true`.
- **Job → Get** reads a processing run, for example from Reprocess. A failed run's error is in `errorMessage` (not `error`, which n8n would treat as a failed item).
- **Simplify:** Get and Get Many of agents, conversations and documents, Update Metadata and Job → Get return at most ten fields in camelCase by default; switch 'Simplify' off for Localmind's raw answer. A document's `path` and `name` are where it was uploaded; after File → Move or Rename the API has no field for the new one.

### Localmind Chat Model

A chat model sub-node for n8n's AI Agent and chains. The selected Localmind agent answers with its own knowledge and tools.

- **No n8n tools.** The Localmind API does not call tools defined in n8n. When tools are connected to the AI Agent, the node stops with an error instead of ignoring them. An output parser ("Require Specific Output Format") works without streaming on n8n 2.16 and later (the agent's JSON goes to n8n as the parser's tool call) and with streaming on newer n8n such as 2.41, where the JSON arrives as text in one piece. With streaming on n8n 2.16 the parser fails: that version hands the parser the streamed answer in a form it cannot read; switch streaming off in the AI Agent there. The node adds the parser's JSON schema to the question and drops n8n's instruction to call the parser's tool, which a Localmind agent cannot do.
- **Agent failures are errors.** Localmind reports a failure during an answer as an `[Error: …]` text, and an answer cut off at the agent's step limit with a notice; the node turns both into errors, and an empty answer as well. From Localmind 1.6.0, an answer that Localmind ended because all code sandboxes were busy is an error too; with streaming, the chat first shows Localmind's notice ("All compute resources are currently in use", by default in German).
- **Files from the chat** reach the agent only as far as n8n's AI Agent passes them on: PDFs only with the AI Agent's option 'Automatically Passthrough Binary PDFs' (n8n 2.41 or later, not in 2.16), text and CSV files as text. Office files and images do not reach it (n8n's AI node SDK drops images). Use Agent → Ask for Office files and images.
- **No generated files.** Files the agent creates are not returned through the chat model.
- Options: maximum number of tokens, sampling temperature and timeout (10 minutes, also the most Localmind allows for one answer). Streamed answers report token usage.

## Compatibility

- **n8n 2.16 or later.** The chat model is built on n8n's AI node SDK, which n8n provides from 2.16 on. n8n loads a package as a whole, so the package as a whole needs 2.16.
- **Localmind 1.0.0 or later** (tested on 1.5.0; code execution there and older versions are being confirmed). Some features depend on the Localmind version:

  | Feature                                                                                                                | Localmind                                                                                                                       |
  | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
  | Agent → Ask with PDF, Office, text and CSV documents; the Chat Model with the PDF, text and CSV files n8n passes on    | 1.3.0                                                                                                                           |
  | Generated files from Send Message and Get Messages                                                                     | 1.2.0, expected                                                                                                                 |
  | Send Message waits by polling the conversation state, lighter than reading the history                                 | 1.6.0                                                                                                                           |
  | Send Message waits in the code-execution queue when all sandboxes are busy (before: "No code-execution slot was free") | 1.3.0                                                                                                                           |
  | Send Message up to 1.5.0: waits by following the run and the message history, which is heavier in long conversations   | 1.0.0                                                                                                                           |
  | Ask and Chat Model use the agent's skills, and all code steps of a request share one sandbox                           | 1.6.0; before, skills are not used and each code step runs in a new sandbox                                                     |
  | Agents answer in the language of the message and do not see the key user's name and email                              | 1.7.0; before, they answer in the key user's interface language and see the name and email                                      |
  | Ask and the Chat Model fail with an error when all code sandboxes are busy                                             | 1.6.0; before, the agent answers without running code                                                                           |
  | Audio and HTML uploads are only stored, not indexed                                                                    | 1.6.0; before, Localmind tries to index them and marks them failed. The node does not wait for them and reports them as stored. |

## Development

```bash
npm ci
npm run dev      # n8n with the nodes and hot reload on http://localhost:5678
npm test         # unit tests (Vitest)
npm run typecheck  # TypeScript check of the code and the tests
npm run lint     # n8n community node lint (strict mode)
npm run build
npm run check:package  # after the build: only the expected files, nothing secret or internal
```

Every pull request and every push to `main` runs lint, type check, tests and build, verifies the dependencies' signatures and checks the package contents. Releases are built and published by GitHub Actions with npm provenance, after a maintainer's approval.

## Security

Please report security problems privately, not in a public issue. The [security policy](https://github.com/Localmind-GmbH/localmind-n8n-nodes/blob/main/SECURITY.md) says how.

## License

[MIT](LICENSE.md)
