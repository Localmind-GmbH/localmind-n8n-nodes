# Changelog

## 1.0.0 (2026-11-10)

The first release.

### Nodes

- **Localmind**, an action node that can also be a tool of n8n's AI Agent:
  - **Agent:** Ask (one prompt with an optional system message, temperature, maximum tokens and JSON output; images and PDF, Office, text and CSV documents as attachments; generated files as binary data), Get, Get Many.
  - **Conversation:** Create, Get, Get Many, Get Messages, Delete, Send Message. Send Message waits for the answer, also while the agent waits for a free code sandbox, and returns the files the agent generates as binary data. It takes images and text files as attachments, and from Localmind 1.7.0 also PDF, Office and other files, which the agent can open in its code sandbox. Disabled Tool IDs limit the agent's tools for a job.
  - **Document:** Search, Get, Get Many, Get Text, Get Chunks, Reprocess, Update Metadata, Delete.
  - **File:** Upload (optionally waiting until the file is indexed), List, Download, Download by URL, Move or Rename, Delete.
  - **Job:** Get. **Space:** Get Many.
  - Searchable lists for agents, spaces, conversations and documents, a folder dropdown, Return All with paging, and a Simplify option for large answers.
- **Localmind Chat Model**: a Localmind agent as the chat model of n8n's AI Agent and AI chains, with streaming, chat memory, output parsers and the PDF, text and CSV files n8n's AI Agent passes on. It stops with a clear error when n8n tools are connected, since Localmind agents work with their own tools.

### Credential and security

- Credential **Localmind API** with the API URL and a user API key. Saving it tests the key; from n8n 2.34 the test says what to fix, for example the app address instead of the API address.
- The key is sent only to the credential's API URL and only over https (plain http only to the same machine), never to another host through a redirect, and is masked if an error text repeats it. By default, n8n's HTTP Request node cannot use the credential.
- Download links are checked before they are followed, downloads are streamed and limited in size, and as an AI tool the node downloads generated files only when this is switched on.

### Reliability

- Requests that are safe to repeat are retried after rate limits, server errors and dropped connections, with backoff. The node never sends a message or uploads a file twice by itself.
- Clear errors for a failed turn, the agent's step limit, busy code sandboxes, approval steps, timeouts and wrong addresses, each saying what to do next. Failed items can go to n8n's error output.

### Compatibility and documentation

- Self-hosted n8n 2.16 or later; tested on n8n 2.16, 2.41 and 2.46.
- Localmind: tested on 1.6.0, on the development version of 1.7.0, and on 1.5.0 without code execution. Features of Localmind 1.7.0 switch on when you update Localmind.
- A README with a compatibility table, and a customer guide covering API keys, installation (also offline), a first workflow, every operation in detail, known limits and troubleshooting.

### Releases

- Published from GitHub Actions with npm provenance. Each GitHub release carries the package file with a signed attestation, so it can be verified before an offline installation.
