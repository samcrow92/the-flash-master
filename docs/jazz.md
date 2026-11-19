# IBM Jazz for agents: requirements (DOORS Next), tests (ETM) and source (EWM)

Agents reach IBM Engineering Lifecycle Management through the bundled `jazz` tool server. Work items (`jazz_*`) and reading DOORS Next requirements (`rm_modules`, `rm_search`, `rm_get`) were already there; this page covers writing requirements, test management and source control.

## Setup

Settings → Integrations → IBM Jazz:

1. Fill in the server, sign-in and password as for work items. The password is encrypted with the OS keychain (Windows DPAPI).
2. **IBM Engineering Test Management:** turn it on and pick the project area (**From server** lists them). The server defaults to the work item server with `/ccm` changed to `/qm`. Configuration-managed projects can set the stream or baseline URL. Press **Test**.
3. **IBM EWM source control (read-only):** turn it on. Reading files needs nothing else. Listing folders and searching for files use the EWM SCM command line (`scm.exe` or `lscm` from the EWM client): it is found on PATH, or you set its path. Press **Test**.
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
| `scm_read_file` | A text file from a stream, in windows of lines for big files |
| `scm_download` | Copy text files from a stream into the agent's working folder |
| `scm_list`, `scm_find_files` | Folder contents and glob search (EWM SCM command line) |

DOORS Next writes need a changeset on every call: the changeset URL (`…/rm/cm/changeset/_…`) or any DOORS Next link opened in it. Streams, baselines and global configurations are refused, so nothing reaches a stream until a person delivers the changeset in DOORS Next, and a wrong edit or delete is undone by discarding the changeset. Read-only mode (Settings → Permissions) blocks the three write tools. `tests/invariants.test.ts` checks that every DOORS Next write goes through the one request path that sends the changeset.

Nothing writes to EWM source control; `tests/invariants.test.ts` checks that the SCM client only sends GET requests.

## How it talks to the servers

- **ETM:** the Reportable REST API (`/qm/service/com.ibm.rqm.integration.service.IIntegrationService/resources/<project alias>/<type>`) for reading, creating (POST to the collection; PUT with an external id on servers that refuse POST) and editing (read the XML, change only the touched elements, PUT it back with `If-Match`). Requirement links use OSLC QM: `oslc_qm:validatesRequirement` on the test case's RDF resource.
- **DOORS Next writes:** OSLC RM 2.0 with the changeset in the `Configuration-Context` header (and `vvc.configuration` for older servers). The changeset names its component (`oslc_config:component`), the component its project area; the project's `services.xml` gives the requirement creation factory, the query capability (find a requirement by its id) and the resource shapes (artifact types, attributes, enumeration values). Create is a POST of RDF/XML to the factory; edit reads the artifact's RDF, changes only the touched properties and PUTs it back with `If-Match`; delete is a DELETE with `If-Match`.
- **EWM:** streams and components from the Reportable REST API (`/ccm/rpt/repository/scm`), file contents from `IFilesystemContentService/<stream id>/<component id>/<path>`. EWM has no public REST call for folder listings, hence the command line.

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
- Binary files can't be read or downloaded (text only).
