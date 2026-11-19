# IBM Jazz for agents: requirements (DOORS Next), tests (ETM) and source (EWM)

Agents reach IBM Engineering Lifecycle Management through the bundled `jazz` tool server. Work items (`jazz_*`) and reading DOORS Next requirements (`rm_modules`, `rm_search`, `rm_get`) were already there; this page covers writing requirements, test management and source control.

## Setup

Settings → Integrations → IBM Jazz:

1. Fill in the server, sign-in and password as for work items. The password is encrypted with the OS keychain (Windows DPAPI).
2. **IBM Engineering Test Management:** turn it on and pick the project area (**From server** lists them). The server defaults to the work item server with `/ccm` changed to `/qm`. Configuration-managed projects can set the stream or baseline URL. Press **Test**.
3. **IBM EWM source control** needs no setup of its own: it uses the Jazz server and sign-in above, or the EWM server of a link you give the agent (same sign-in). Reading, listing folders and finding files work over HTTP, with no command line: give the agent a stream, component or folder link from the EWM web UI. Only changes (workspaces, load, check-in, accept, deliver) need the EWM SCM command line (`scm.exe` or `lscm` from the EWM client), found on PATH or set here. **Agents may deliver** is off by default. Press **Test**.
4. Servers with a self-signed or company certificate that Windows doesn't trust: turn on **Trust the server's certificate**. It applies only to the Jazz hosts in these settings. Installing the company CA in Windows is the cleaner fix.

## Tools

| Tool | What it does |
| --- | --- |
| `rm_changeset` | Check a DOORS Next changeset: title, component, project, and the artifact types (with attributes) that can be created |
| `rm_read` | One requirement as it is in the changeset |
| `rm_create` | New requirement in the changeset: type, title, text, attributes (enumerations by label), links, folder |
| `rm_update` | Change title, text, description or attributes, add or remove links; everything else is kept |
| `rm_delete` | Delete a requirement in the changeset; `confirm` must repeat its id, modules are refused |
| `qm_projects` | ETM project areas you can see |
| `qm_list` | Find test plans, suites, cases, scripts, execution records or results by words, ids or a server filter |
| `qm_get` | One artifact: fields, links, script steps; `requirements: true` adds validated requirements |
| `qm_create` | New test plan, suite, case, script (with steps) or execution record, with links |
| `qm_update` | Change fields, add or remove links (cases in a plan or suite, script on a case), replace script steps |
| `qm_record_result` | Find (or create) the test case's execution record in the plan and add a result with the verdict |
| `qm_link_requirement` | Link a test case to the DOORS Next requirement it validates, or remove the link |
| `scm_streams`, `scm_components` | Streams and their components |
| `scm_read_file` | A text file from a stream, in windows of lines for big files; with a folder link the path is relative to that folder (a file name is enough) |
| `scm_download` | Copy files (text or binary, e.g. PDFs) into the agent's working folder; a folder link with no paths copies the whole folder |
| `scm_list`, `scm_find_files` | Folder contents and glob search of a folder link or a component path (over HTTP; the command line is only a fallback) |
| `scm_link` | What an EWM link names: server, stream, component (names and ids), path, change set. Every `scm_*` tool also takes `link` and fills stream, component and path from it |
| `scm_workspaces`, `scm_create_workspace` | Repository workspaces; a new one that flows to a stream |
| `scm_load` | Load a repository workspace into a sandbox in the agent's working folder (default `ewm/<workspace>`) |
| `scm_status` | Local changes, outgoing and incoming change sets, conflicts of a sandbox |
| `scm_checkin` | Check local changes in to a new or existing change set, with a comment and a work item link |
| `scm_changesets`, `scm_changeset` | Recent change sets of a workspace or stream; the files one change set touches |
| `scm_changeset_update` | Comment, link a work item, or complete a change set |
| `scm_accept` | Accept incoming change sets into the workspace (and its sandbox) |
| `scm_deliver` | Deliver outgoing change sets to a stream; needs **Agents may deliver** and `confirm` = the stream name |
| `scm_discard` | Discard an undelivered change set; `confirm` = the change set |

DOORS Next writes need a changeset on every call: the changeset URL (`…/rm/cm/changeset/_…`) or any DOORS Next link opened in it. Streams, baselines and global configurations are refused, so nothing reaches a stream until a person delivers the changeset in DOORS Next, and a wrong edit or delete is undone by discarding the changeset. Read-only mode (Settings → Permissions) blocks the three write tools. `tests/invariants.test.ts` checks that every DOORS Next write goes through the one request path that sends the changeset.

EWM source control changes happen only in repository workspaces: agents create one that flows to a stream, load it into a sandbox inside their working folder, edit the files with their usual tools, check in and accept there. A stream is refused wherever a workspace is needed, so a stream changes only by deliver, which is off until the user turns on **Agents may deliver**, and even then needs the stream's name repeated as `confirm`. Read-only mode (Settings → Permissions) blocks every change. `tests/invariants.test.ts` checks that the REST client only reads and that every changing command goes through the read-only guard.

## How it talks to the servers

- **ETM:** the Reportable REST API (`/qm/service/com.ibm.rqm.integration.service.IIntegrationService/resources/<project alias>/<type>`) for reading, creating (POST to the collection; PUT with an external id on servers that refuse POST) and editing (read the XML, change only the touched elements, PUT it back with `If-Match`). Requirement links use OSLC QM: `oslc_qm:validatesRequirement` on the test case's RDF resource.
- **DOORS Next writes:** OSLC RM 2.0 with the changeset in the `Configuration-Context` header (and `vvc.configuration` for older servers). The changeset names its component (`oslc_config:component`), the component its project area; the project's `services.xml` gives the requirement creation factory, the query capability (find a requirement by its id) and the resource shapes (artifact types, attributes, enumeration values). Create is a POST of RDF/XML to the factory; edit reads the artifact's RDF, changes only the touched properties and PUTs it back with `If-Match`; delete is a DELETE with `If-Match`.
- **EWM:** streams and components from the Reportable REST API (`/ccm/rpt/repository/scm`), file contents from `IFilesystemContentService/<stream id>/<component id>/<path>`. Folders: EWM has no public REST call that lists a folder. The file content service sends a folder as a zip, which is what the web UI's *Download as zip* uses: `IFilesystemContentService/<stream or workspace id>/<component id>/<path or ->?itemType=com.ibm.team.scm.Folder&contextType=com.ibm.team.scm.Stream|Workspace&format=zip[&itemId=<folder id>]`. The app reads that zip in memory (cached for 10 minutes, up to 300 MB) for listings, searches and the files of a folder link. Changes have no REST call at all, hence the command line: `scm create workspace`, `load`, `show status`, `checkin`, `changeset associate|comment|complete`, `list changesets|changes|workspaces`, `accept`, `deliver`, `discard`, each with `-r <server>` (and `-u`/`-P` with Basic or form sign-in) and `--json` where it has one.

All HTTP goes through the same Jazz session as work items: form, Basic, Windows (Kerberos/NTLM) or browser SSO (Jazz Authorization Server / OIDC), the system proxy and the Windows certificate store.

## Not yet verified on a live server

No Jazz server was available while building this, so it was written against IBM's documentation and Jazz forum answers and tested with recorded-style responses. Check these on the first real use:

- **DOORS Next changesets:** reading the component from `oslc_config:component`, treating `oslc_config:committed` as delivered, and whether a server wants the `oslc_config.context` query parameter as well as the header.
- **DOORS Next create without a folder** puts the requirement in the project's root folder; it is not placed in a module (module structure editing is not supported yet).
- **DOORS Next enumeration labels** are read from the shape document (`rdfs:label` / `dcterms:title` of each allowed value); if a server only lists the value URLs, pass the URL as the value.
- **ETM element names and order.** The created XML uses `dc:title`/`dc:description`, `alm:owner`/`alm:state`, link elements with `href`, `suiteelements/suiteelement/testcase` for suites and `steps/step` (testscript namespace) for scripts. Some ETM versions validate the element order.
- **Execution result details.** Notes go into `details` as XHTML; the verdict uses `com.ibm.rqm.execution.common.state.<verdict>`. Step results are not written.
- **Finding a test case through OSLC** for requirement links (`oslc:shortId`, then `dcterms:identifier`).
- **Project alias** taken from the projects feed (`<alias>` or the last part of the entry id).
- **EWM components** from `scm/workspace[itemId=…]/components`, falling back to the web client's `IScmRestService2/workspace` service.
- **SCM command line** flags `list remotefiles -r <repo> --json --depth <n>`, and its JSON shape. With Basic or form sign-in the user and password are passed as `-u`/`-P`; with Windows or SSO sign-in it relies on an earlier `scm login`.
- **Folder zip download** (`format=zip` with `itemType`, `contextType` and the folder's `itemId`): the parameters come from the web UI's download link as quoted on the Jazz forum; whether the archive wraps everything in the folder's own name is guessed (one top folder is dropped). If a server refuses it, the error names the HTTP status, and the SCM command line is used when installed.
- **jazz-community/ewm-scm-utils** was checked (2026-11-19) and not used: it is a Java tool on the Plain Java Client Libraries for repository statistics, load-rule conversion and baseline downloads, with its last code change in 2022. It would need Java and IBM's client libraries on every PC and has no HTTP API to call.
- **SCM command line for changes:** the flags above (`create workspace -s`, `--description`, `checkin -c/--comment`, `accept -t/-s/-d`, `deliver -s/-t -c`, `discard -w`), that `show status` and `checkin` accept `-r`, the `changeset associate|comment|complete` subcommands (newer CLIs also call them `set changeset` / `add workitem`), and the JSON field names (`uuid`, `alias`, `comment`, `state`, `workitems`, `flow-target`). If the check-in output has no change set id, the work item is not linked and the tool says so.
