# Release test suite

A fixed set of checks against a real Localmind instance. Run it before every release of the package and after every Localmind release that touches the API. The results back the tested versions in the README's compatibility table.

Run it against two instances when you can: one on the newest Localmind release, and one on the development version (`main`). Send Message behaves differently on Localmind up to 1.5.0 (see the README's compatibility table), so both paths get checked.

## Setup

1. **n8n** 2.16 or later, with the package installed from npm or from a tarball made with `npm pack` (see the customer guide's offline installation). Don't use `npm run dev`: it registers the nodes under other type names, so the imported workflows would show unknown nodes.
2. **Localmind test setup:**
   - A test space.
   - A technical user with access to the test space, and an API key for it, limited to the test space.
   - An agent that has code execution, linked to the test space.
3. **In n8n:** a credential of type **Localmind API** named `Localmind API`, with the instance's `-api` URL and the key.
4. Import the workflows below (**Workflows > Import from File**). In each, open the **Settings** node and fill in the IDs. In workflow 05, also fill in `localmindVersion`, the Localmind version under test (for the development version, the next release, such as 1.7.0): its check expects exactly that version's behaviour. Agent → Get Many and Space → Get Many in any Localmind node list them.

## Automated workflows

Each workflow ends in a Code node that stops with an error when a check fails. A run passes when every node is green.

| Workflow                                    | What it checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-agent-ask.json`                         | Agent → Ask with JSON output: parsed answer, token usage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `02-conversation-code-execution-files.json` | Conversation → Create, Send Message with code execution: waits for the answer (also through the sandbox queue when all sandboxes are busy at the time), returns the generated Excel file as binary data under its exact name `Release Check Ü (1).xlsx` (spaces, an umlaut and brackets check that the download link is encoded right on every Localmind version); Get Messages shows it; Delete cleans up                                                                                                                                                                                                |
| `03-file-upload-search-delete.json`         | File → Upload with a unique marker, waits until indexed; Document → Search finds the passage; Document → Delete removes it through the file manager, and a new search no longer finds it                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `04-agent-calls-workflow-check.json`        | A Localmind agent calls an n8n workflow through the MCP Server Trigger, once without and once with inputs (needs the manual setup below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `05-attachments-downloads-labels.json`      | Send Message with attachments: from Localmind 1.7.0 a PDF and a CSV are uploaded and the agent answers from both; before 1.7.0 the PDF is refused with a pointer to 1.7.0 and the CSV goes along as text. An executable is refused. File → Download stops at 'Max File Size (MB)'; an upload keeps only the last part of a file name with a Windows path; from 1.7.0, Ask's generated CSV comes with its AI-label file; a download link behind a path prefix works. It cleans up after itself, and one check at the end reports every problem; what it expects follows `localmindVersion` in its Settings |

## Manual checks

**Agent calls an n8n workflow (for workflow 4)**

1. In the n8n under test, create a workflow with an **MCP Server Trigger** (path `localmind-release-check`, bearer authentication) and two **Code Tools**: `release_word` with the description "Returns the release word" that returns `LIGHTHOUSE-42`, and `combine_numbers` with the description "Combines two numbers a and b into the release result. Pass both numbers.", an input schema from the example `{"a": 6, "b": 7}` and the code ``return `R-${Number(query.a) * Number(query.b) + 7}`;``. Activate it.
2. In Localmind, open the test space, go to **Tools**, create a new tool and choose connection type **HTTP** (not "HTTP API") with the trigger's production URL. Under **HTTP Headers**, enter `Authorization` with `Bearer <token>`, tick **Secure** before you click **Add**, and check that the header appears in the list. Attach the tool to an agent in the test space.
3. Run `04-agent-calls-workflow-check.json` with that agent's ID.

**Generated file as an Outlook attachment (after workflow 2)**

Add a **Microsoft Outlook** node (Send Message) after **Check Answer**, with the attachment taken from the binary field `file_0`, and send it to a test mailbox. Pass: the mail arrives with a readable `Release Check Ü (1).xlsx`. Without a Microsoft 365 test mailbox, n8n's **Send Email** node to any test mailbox checks the same hand-over of the file.

**Credential** (the messages below from n8n 2.34 on; older n8n shows its general messages)

- Save the credential: the test passes.
- Change the URL to the instance's `-app` address and save: the test fails with "Use the API host".
- Use a wrong key: the test fails with "Localmind rejected the API key".

**Localmind Chat Model**

In an AI Agent with a chat trigger and the Localmind Chat Model:

- A plain question gets an answer, streamed in the chat.
- An image attached in the chat does not reach the agent (n8n's AI node SDK drops it); a PDF attached in the chat is read (with the AI Agent's option **Automatically Passthrough Binary PDFs**, n8n 2.41 or later).
- With a memory node (for example Simple Memory), a follow-up question refers to the first answer.
- With a tool connected to the AI Agent, the run stops with "The Localmind Chat Model cannot use tools connected in n8n".
- With **Require Specific Output Format** and a structured output parser: the answer is parsed (the node asks the agent for JSON in the parser's shape) and no tools error appears. On n8n 2.16, only with streaming switched off in the AI Agent.

**Dropdowns**

In a Localmind node, open the lists for **Agent**, **Space**, **Conversation** and **Document** (also with a search text), and the **Folder** dropdown of File → Upload. Pass: each list loads, once with a full key and once with a key limited to the test space.

**Localmind as an AI tool**

Connect a Localmind node as a tool to n8n's AI Agent (or to an MCP Server Trigger), with Agent → Ask and the prompt filled by the model. Pass: the tool answers; a generated file is listed with its link but not downloaded; File → Download by URL as a tool refuses a link that only mentions `/v1/storage/download/` in its query.

**Send Message timeout**

Send a long task (for example the message of workflow 2) with **Timeout (Minutes)** set to 1. Pass: the error says what the agent was doing and names the conversation and message IDs.

## Results

Record each run here, with short notes. "pass" means every check of the workflow passed.

| Date          | Package           | n8n                    | Localmind                                    | 01   | 02         | 03   | 04                      | 05   | Manual checks                                                                                                                                                                       | Notes                                                                                                                                                                                                                                                    |
| ------------- | ----------------- | ---------------------- | -------------------------------------------- | ---- | ---------- | ---- | ----------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-26/27 | 0.1.0             | 2.16.0, 2.41.7         | development version (2026-10-20)             | pass | pass       | pass | pass                    | –    | Credential, Chat Model                                                                                                                                                              | Output parser with streaming fails on n8n 2.16 (documented)                                                                                                                                                                                              |
| 2026-10-29    | 0.1.0             | 2.16.0, 2.41.7         | 1.5.0                                        | pass | not tested | pass | –                       | –    | –                                                                                                                                                                                   | Code execution was not set up in the local 1.5.0 instance                                                                                                                                                                                                |
| 2026-11-04    | 0.1.0             | 2.16.0, 2.41.7         | development version (after 1.7.0-rc.1)       | pass | pass       | pass | pass                    | –    | –                                                                                                                                                                                   | Generated-file links encoded from 1.7.0                                                                                                                                                                                                                  |
| 2026-11-08    | 0.1.0 (`3490e54`) | 2.16.0, 2.41.7, 2.46.4 | development version (after 1.7.0-rc.2)       | pass | pass       | pass | pass (on 2.16 and 2.41) | pass | Credential and Chat Model with streaming in the chat (2.46); generated file as an email attachment via Send Email (no Outlook)                                                      | Also ran test workflows covering every operation of every resource                                                                                                                                                                                       |
| 2026-11-09    | 0.1.0 (`d45d8cd`) | 2.16.0, 2.41.7         | development version (after 1.7.0-rc.2)       | –    | –          | –    | –                       | –    | Dropdowns with a full and a space-limited key; Localmind as an AI tool; credential                                                                                                  | –                                                                                                                                                                                                                                                        |
| 2026-11-09    | 0.1.0 (`d45d8cd`) | 2.16.0, 2.41.7         | 1.6.0                                        | pass | pass       | pass | –                       | pass | –                                                                                                                                                                                   | Localmind 1.6.0 cannot download generated files whose names have characters outside Latin-1 (fixed in 1.7.0); documented as a known limit                                                                                                                |
| 2026-11-19    | 1.0.0 (`a13d577`) | 2.16.0, 2.48.5         | development version (41 commits after 1.7.0) | pass | pass       | pass | pass                    | pass | Credential; Chat Model (streaming, memory, PDF, image, connected tool, output parser); dropdowns with a full and a space-limited key; Localmind as an AI tool; Send Message timeout | The package as built with @n8n/node-cli 0.57.2 (SHA-256 `23e406a0…e39dc9`). As documented, n8n 2.16 does not pass a PDF from the chat on and parses output only with streaming off. The mail hand-over of a generated file was not run (no test mailbox) |
