# Localmind nodes for n8n

The package `@localmind/n8n-nodes-localmind` connects your own n8n to Localmind. It adds two nodes:

- **Localmind**: ask agents, hold conversations, search and manage the documents and files of your spaces.
- **Localmind Chat Model**: use a Localmind agent as the language model of n8n's AI Agent and AI chains.

The other direction, a Localmind agent calling an n8n workflow, needs no package. See [Workflow as agent tool](#workflow-as-agent-tool).

## Requirements

| What             | Version                                                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| n8n, self-hosted | 2.16 or later (2.21 or later for the environment-managed package list)                                                                       |
| Localmind        | 1.0.0 or later (tested on 1.5.0; older versions are being confirmed). Some features need a newer version; see [Known limits](#known-limits). |
| Network          | n8n must reach your Localmind API host. Use HTTPS.                                                                                           |

## 1. Create an API key

The nodes sign in with a Localmind user API key. A key acts with the permissions of the user who created it.

1. In Localmind, open your **user settings** and go to the **API Keys** tab.
2. Select **Create API Key**. Give it a **Name**, optionally a **Description**, an **Expiration** (Never, 30 days, 90 days or 1 year) and, under **Access**, the spaces it is limited to (leave it empty for all spaces). Creating keys needs a role that allows it in your organization.
3. Copy the key (it starts with `sk-`). It is shown only once.

### Key model for integrations

For workflows that run for a team or a company, don't use an employee's personal key:

- **Use a technical user.** Create a Localmind user for the integration, for example `n8n-integration`, and add it only to the spaces the workflows need. Its permissions in those spaces decide what the workflows can do.
- **Limit the key to those spaces.** A key with space scopes searches, reads and changes documents, files and conversations only in those spaces, even if the user has access to more. The limit also covers download links of files in those spaces. Files that agents generate with code execution are not tied to a space: Localmind only checks that whoever downloads one belongs to the same organization, so anyone in your organization who has the link can fetch the file. Treat these links as confidential.
- **What the agent learns about the key's user.** Up to Localmind 1.6.0, an agent run through the nodes sees the key user's name and email and answers in that user's interface language (German unless set otherwise). From 1.7.0 it sees neither and answers in the language of the message, since the messages come from whoever your workflow serves. `{{USER_NAME}}` and `{{USER_EMAIL}}` in the agent's own instructions still name the key user. With a technical user, the agent never sees an employee's name.
- **Credits and audit stay traceable.** The credits the workflows use and their audit entries are recorded for the technical user, separate from your employees' use.
- **Rotate keys.** Give keys an expiration. To rotate: create a new key, enter it in the n8n credential, run the credential test, then deactivate the old key.

## 2. Install the package

Pick one of these ways. After installing, the nodes appear in n8n as **Localmind** and **Localmind Chat Model**.

### Settings UI

Requires an n8n owner or admin.

1. In n8n, go to **Settings > Community Nodes** and select **Install**.
2. Enter `@localmind/n8n-nodes-localmind`. To install a specific version, add it: `@localmind/n8n-nodes-localmind@1.0.0`.
3. Confirm that you understand the risks of installing unverified code, and select **Install**.

This also works in queue mode.

### Environment-managed package list (n8n 2.21 or later)

For deployment pipelines and Kubernetes: at every start, n8n brings its community packages in line with the list. It installs what is missing; packages already in place are not reinstalled.

```bash
N8N_COMMUNITY_PACKAGES_MANAGED_BY_ENV=true
N8N_COMMUNITY_PACKAGES='[{"name":"@localmind/n8n-nodes-localmind","version":"1.0.0"}]'
```

> **Warning:** with this setting, n8n **uninstalls every community package that isn't in the list**, and the Community Nodes page becomes read-only. List all community packages you use.

To pin the exact package contents, add its checksum. `npm view @localmind/n8n-nodes-localmind@1.0.0 dist.integrity` prints it:

```json
[{ "name": "@localmind/n8n-nodes-localmind", "version": "1.0.0", "checksum": "sha512-…" }]
```

### Manual installation with npm

To install from the command line. In Docker, open a shell in the container first (`docker exec -it n8n sh`).

```bash
mkdir -p ~/.n8n/nodes && cd ~/.n8n/nodes
npm install --legacy-peer-deps @localmind/n8n-nodes-localmind@1.0.0
```

`--legacy-peer-deps` keeps npm from installing its own copy of the n8n libraries next to the package, which could then differ from the version of the running n8n. Then restart n8n. In queue mode, install the package on the main instance, on every worker and on every webhook processor.

### Offline installation (air-gapped)

1. On a machine with internet access, download the package: `npm pack @localmind/n8n-nodes-localmind@1.0.0`. This creates `localmind-n8n-nodes-localmind-1.0.0.tgz`.
2. Copy the file to the n8n host (for Docker: `docker cp localmind-n8n-nodes-localmind-1.0.0.tgz n8n:/tmp/`).
3. On the n8n host or in the container:

   ```bash
   mkdir -p ~/.n8n/nodes && cd ~/.n8n/nodes
   npm install --legacy-peer-deps /tmp/localmind-n8n-nodes-localmind-1.0.0.tgz
   ```

   `--legacy-peer-deps` stops npm from downloading the n8n libraries the package expects from n8n itself. The package has no other dependencies.

4. Restart n8n.

If you run a private npm registry, n8n can also install from it (`N8N_COMMUNITY_PACKAGES_REGISTRY`; this requires an n8n license).

## 3. Set up the credential

In n8n, create a credential of type **Localmind API**:

| Field   | Value                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API URL | Your Localmind **API host**: usually the address ending in `-api`, for example `https://acme-api.example.com`. The app address (usually ending in `-app`, the one you open in the browser) does not serve the API. It must start with `https://`: plain `http://` works only for this machine (`localhost`, `*.localhost`, `127.0.0.1`), since it would carry the key unencrypted. A trailing `/v1` is ignored. |
| API Key | The key from step 1.                                                                                                                                                                                                                                                                                                                                                                                            |

In Docker, "this machine" is n8n's own container: an address such as `http://host.docker.internal:8000` or a Compose service name like `http://backend:8000` is refused. Use Localmind's `https://` address, or put a reverse proxy with TLS in front of it.

Saving runs a test that lists the agents the key can use. From n8n 2.34.0 on, it says when the key is wrong or expired and when you entered the app address instead of the API address; older n8n shows its general messages instead (see [Troubleshooting](#troubleshooting)).

## Which operation for which case

| Need                                                                                        | Use                                                   |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| One answer, no history; your own system message, temperature, maximum tokens or JSON output | Agent → Ask                                           |
| PDF, Office or other documents read by the agent for one answer                             | Agent → Ask                                           |
| Files the agent generates with code (Excel, Word, …)                                        | Agent → Ask or Conversation → Send Message            |
| Several steps that build on each other, or work in a specific space                         | Conversation → Create, then Send Message              |
| Wait for a free code sandbox instead of answering without code                              | Conversation → Send Message                           |
| Limit the agent's tools for one job                                                         | Conversation → Send Message, option Disabled Tool IDs |
| Find passages in a space's documents                                                        | Document → Search                                     |
| Add documents to a space so agents and searches find them                                   | File → Upload                                         |
| Use a Localmind agent inside an n8n AI Agent or chain                                       | Localmind Chat Model, without n8n tools               |

**Long tasks.** Send Message waits for the answer, by default for up to 15 minutes. When the agent needs to run code and all sandboxes are busy, the message waits in Localmind's queue. If the time runs out, the node says what the agent was doing (working, or waiting for a sandbox at position N) and gives the IDs to fetch the answer later with Conversation → Get Messages. The turn may still be running: check its answer before you send the message again, or the agent does the work twice. For jobs you expect to take long, switch off **Wait for Answer** and read the answer in a later step. With **Simplify** on, Get Messages marks each answer as `complete`, `in progress`, `waiting for a code sandbox`, `failed` or `incomplete` (an earlier, partial answer that a later one replaced), so the later step can tell whether the answer is final.

## Workflow as agent tool

A Localmind agent can call an n8n workflow as a tool, through n8n's **MCP Server Trigger**. This works with your own n8n and needs no package.

1. **In n8n,** build a workflow that starts with an **MCP Server Trigger** and attach the tools the agent may use. Set its authentication (bearer or header) and activate (publish) the workflow.
2. Copy the trigger's **production URL** (it contains `/mcp/`). Use the public address of your n8n: not the test URL, and not the address of a proxy path in between.
3. **In Localmind,** open the space, go to **Tools** and create a new tool. Choose the connection type **HTTP** (not "HTTP API") and enter the URL. Under **HTTP Headers**, enter the authentication header (for example `Authorization` with the value `Bearer …`), tick **Secure** before you click **Add**, and check that the header appears in the list: a header that is only typed in is not sent, and n8n answers 403. Test the connection, save the tool and attach it to the agent.

Three things must be in place:

- **Network:** the Localmind backend must reach your n8n host. Check firewalls, proxies and DNS between the two.
- **Authentication header:** on Localmind before 1.5.0, any custom header on an MCP Server tool breaks the connection, marked **Secure** or not (fixed in 1.5.0). Update Localmind to 1.5.0 or later to use authentication.
- **The right URL:** the production URL of the MCP Server Trigger, from the public address of your n8n.

## Localmind as an AI tool

The Localmind node can be a tool of n8n's AI Agent. The AI Agent's model then fills in the node's parameters, and text it reads (a mail, a web page, a document) can steer it: a prompt injection can make it delete or move files, send messages to other conversations of the key's user, pick a different agent, or pass data on through other tools. Set it up so that a manipulated model cannot do much harm:

- **Use a technical user and a key limited to the spaces the workflow needs** (see [Key model for integrations](#key-model-for-integrations)).
- **Fix what the model must not choose.** Set agent, space, conversation and paths to fixed values or to values from earlier nodes, instead of letting the model define them.
- **Keep destructive operations out of reach.** Don't offer File → Delete, File → Move or Rename and Document → Delete as tools, or put a human approval step in front of them.
- **Don't combine it with outbound tools** (mail, HTTP requests, chat messages) in the same AI Agent, so data it reads cannot be sent elsewhere.
- **Expect text only.** Binary data does not reach the AI Agent: File → Upload and attachments need binary data from earlier nodes and do not work, generated files are not downloaded unless 'Download Files' is switched on explicitly, and the model cannot pick from dropdowns such as Folder, so give IDs and paths.

## Known limits

**Conversations**

- Attachments to Send Message are limited to JPEG, PNG, GIF and WebP images and text files. Localmind's API does not yet take PDF, Office or other files into a conversation; send documents with Agent → Ask instead.
- Agent → Ask hands documents to the agent as text only. The agent cannot open the original file in code (for example to edit an Excel sheet); that needs Send Message with real file attachments, which comes with a later Localmind release.
- Conversations cannot be renamed through the API. A title can be set when the conversation is created.
- Get Messages always returns the whole history of a conversation; the API has no paging for it.
- If an agent stops at an approval step, someone has to approve it in the Localmind app; the node reports it as an error.
- Conversation → Create accepts any agent and space; an agent that is not available in that space fails only at the first Send Message.
- On Localmind up to 1.5.0, a turn that got a code-execution slot and then failed, or that was never resumed, cannot be told apart from one still working: Send Message waits until its timeout, and Get Messages shows it as `in progress`. Check the conversation in the Localmind app.
- On Localmind up to 1.5.0, Send Message waits by reading the conversation's message history, which takes longer in long conversations. From Localmind 1.6.0 it uses a lighter status check.
- Waiting in the code-execution queue needs Localmind 1.3.0. On older versions, or when the queue is turned off or full, Send Message fails with "No code-execution slot was free"; try again later.
- Disabled Tool IDs also turns off skills; turning off all of them also turns off code execution.

**Ask and Localmind Chat Model**

- Documents (PDF, Office, text, CSV) for Agent → Ask need Localmind 1.3.0 or later.
- Ask keeps no history. When all code sandboxes are busy, Ask and the Chat Model fail with an error from Localmind 1.6.0 on (before, the agent answers without running code); Send Message waits instead. A new attempt runs the whole request again, including tools the agent already used.
- From Localmind 1.6.0, agents use their skills, and all code steps of one request share one sandbox. Before, skills are not used and each code step starts in a new sandbox.
- The Chat Model cannot use tools connected to the n8n AI Agent: the Localmind agent works with its own tools. When n8n tools are connected, the node stops with an error.
- Files an agent generates are not returned through the Chat Model; use the Localmind node for that.
- Files from the chat reach the Chat Model only as far as n8n's AI Agent passes them on: PDFs only with the AI Agent's option **Automatically Passthrough Binary PDFs** (n8n 2.41 or later, not in 2.16), text and CSV files as text, Office files and images not at all. Use Agent → Ask for Office files and images.
- After a rate-limit error (too many requests), Agent → Ask and the Chat Model without streaming are not retried automatically (with streaming, the Chat Model retries): an agent may already have acted, and a retry would repeat that. Turn on n8n's **Retry On Fail** for the node where that is acceptable.
- The Chat Model offers agents, not plain base models.
- With an output parser (Require Specific Output Format) and streaming, n8n 2.16 cannot read the answer for the parser; switch off streaming in the AI Agent, or use a newer n8n. Without streaming it works on 2.16 too.
- Graph Agents that pause at an approval step cannot run through Ask or the Chat Model: the answer is empty and the node reports an error, or, with chat memory, the Chat Model may repeat its previous answer. Use Conversation → Send Message.
- Localmind stops an answer of Ask or the Chat Model after 10 minutes; use Send Message for longer tasks.

**Documents and files**

- File → Upload accepts PDF, DOCX, PPTX, XLS and XLSX files, images (PNG, JPG, GIF, WebP, SVG), text files (TXT, Markdown, CSV, JSON), audio and HTML files (stored only, see below) and archives (ZIP, TAR, TAR.GZ, TAR.BZ2, unpacked into the folder). Other types are refused, including old Word files (.doc): convert them to .docx first. A file can be up to 50 MB by default; administrators can change the limit per organization or space.
- Audio and HTML files are only stored, not indexed. On Localmind up to 1.5.0, Localmind tries to index them and shows them as failed; the files are stored all the same.
- Folders cannot be created empty, deleted or copied through the API. A folder appears when you upload a file into it.
- Web sources and tables (reading or appending rows) are not available through the API yet.
- Uploads are limited to 20 per minute per user; the node waits and retries automatically. Up to Localmind 1.5.0 the limit can count all users together, so other people's uploads use it up too.
- Images the agent creates with its image tool are not returned as binary fields. With Agent → Ask they come as Markdown links at the start of the answer, which File → Download by URL can fetch; in conversations they show in the Localmind app. Files from code execution (Excel, Word, PDF, charts saved as files) are returned.
- Files an agent generates are not saved to a space by themselves. To keep one in the data pool, pass the binary field (`file_0`, … by default) to File → Upload.
- Ask and Send Message download at most 10 generated files of up to 50 MB each by default ('Max Files to Download', 'Max File Size (MB)'). Larger or further files stay listed with their link and can be fetched with File → Download by URL.
- With a key limited to spaces, Job → Get cannot read the runs of uploads and reprocessing and reports "PipelineRun … not found". File → Upload is not affected: it waits on the document itself. Only a cancelled upload goes unnoticed with such a key: Upload then waits until its timeout.
- When processing of a document is cancelled or fails, Localmind tries again on its own after about 30 minutes, unless the failure is permanent or automatic recovery is turned off for the organization. Document → Reprocess starts it at once.
- Move or Rename needs the full new path including the file name, and the target folder must exist. After a move, Document → Reprocess of that document can fail; upload the file again instead. Document → Get still shows the path and name the file was uploaded under, since the API has no field for the current one.
- Parsing, transcription, extraction and comparison of documents as separate operations are not available through the API. Transcription with an API key will come with a future Localmind release; this package does not offer it yet. Analysis, extraction and comparison are not planned yet and are available in the Localmind web app.

**General**

- The answer language follows the Localmind version: up to 1.6.0 the key user's interface language, from 1.7.0 the language of the message. For a fixed language on every version, ask for it in the message or in Ask's System Message.
- There is no trigger node for Localmind events yet.
- As a tool of n8n's AI Agent, see [Localmind as an AI tool](#localmind-as-an-ai-tool).
- n8n's **Retry On Fail** runs the whole node again. A Send Message or File → Upload that already succeeded for an item is then sent again: the agent gets the message twice, and the file is uploaded twice. Turn Retry On Fail off for these operations; the node already retries what is safe to repeat.
- The node's own retries come on top of Retry On Fail: against a failing server an item can take up to 15 attempts (about 40 seconds) before it fails.
- n8n's AI Agent takes the Localmind Chat Model's agent and the chat memory from the first item only. For a different agent per item, use **Loop Over Items**.

## Troubleshooting

The credential test shows its own messages from n8n 2.34.0 on; older n8n shows its general ones ("Authorization failed", "The resource you are requesting could not be found"). A Localmind node shows Localmind's message, starting with "Localmind:", and n8n replaces some network errors with its own wording, as listed below.

| Message                                                                                                              | Cause and fix                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential test: "Localmind rejected the API key"; in a node: "Localmind: Invalid API key"                           | The key is wrong, deactivated or expired. Create a new one.                                                                                                                                                                            |
| Credential test: "No Localmind API at this URL"; in a node: "Localmind: Not Found" with the hint to use the API host | The credential points to the app address (`-app`) or a wrong host. Use the `-api` address.                                                                                                                                             |
| "The connection cannot be established, this usually occurs due to an incorrect host (domain) value"                  | The host name in the API URL does not exist, or the URL starts with `http://` for another machine, which the credential refuses. Check it for typos, and use the `https://` address.                                                   |
| Localmind: the API URL must use https                                                                                | The credential's API URL starts with `http://` and points to another machine. Plain http would carry the key unencrypted; use the `https://` address.                                                                                  |
| "The service refused the connection - perhaps it is offline"                                                         | Nothing answers at this address or port. Check the API URL and that Localmind is running.                                                                                                                                              |
| Localmind: … (CREDITS_EXHAUSTED)                                                                                     | The organization or space has no credits left.                                                                                                                                                                                         |
| Localmind: API key does not have access to this space                                                                | The key is limited to other spaces.                                                                                                                                                                                                    |
| No answer within N minute(s)                                                                                         | The turn may still be running. Check its answer with Get Messages before you send the message again; raise the timeout, or switch off 'Wait for Answer' and read the answer later.                                                     |
| No answer from Localmind within N minute(s) (Localmind Chat Model)                                                   | The streamed answer stopped without finishing. Localmind ends an answer after 10 minutes; check the agent in the Localmind app.                                                                                                        |
| Localmind named more than 50 runs for this message                                                                   | Localmind kept starting new runs for one message, which points to a problem in Localmind. Check the answer with Get Messages before you send the message again.                                                                        |
| Localmind: more than 200000 results                                                                                  | 'Return All' or the 'Limit' would read more than 1,000 pages. Set a lower 'Limit', or narrow the request with filters.                                                                                                                 |
| … cannot be attached to a conversation message                                                                       | Send Message takes JPEG, PNG, GIF and WebP images and text files only. Use Agent → Ask for documents.                                                                                                                                  |
| Test Connection of an MCP tool in Localmind: "403 Forbidden"                                                         | The n8n MCP Server Trigger rejected the token. The header must be `Authorization` with the value `Bearer <token>`, the token must match the trigger's credential in n8n, and the header must be added to the list (not only typed in). |
