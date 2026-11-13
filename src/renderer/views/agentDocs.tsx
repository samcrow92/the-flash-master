/**
 * People-facing documentation of the built-in agents (Documentation → Agents).
 * The agents' own instructions live in agents/<name>.md; keep these pages in step with them.
 */
import type { ReactNode } from "react";

/** One step of an example flow. `actor` is "you", "tool:<name>" or an agent name (rendered with its role icon). */
export type FlowStep = { actor: string; text: ReactNode };
export type AgentFlow = { title: string; steps: FlowStep[] };

export type AgentDoc = {
  name: string;
  title: string;
  /** One line, shown on overview cards. */
  summary: string;
  /** Why this agent exists and the job it does in the team. */
  purpose: ReactNode;
  can: string[];
  when: string[];
  /** When another agent is the better choice. */
  instead?: ReactNode;
  tools: string[];
  /** What you get back. */
  output: ReactNode;
  flows: AgentFlow[];
  prompts: string[];
  tips?: ReactNode[];
};

export const AGENT_DOCS: AgentDoc[] = [
  {
    name: "flashmaster", title: "TheFlashMaster", tools: ["flashmaster-core", "jazz"],
    summary: "The coordinator of the master chat. It plans, delegates and integrates. It never does the work itself.",
    purpose: <>TheFlashMaster is the team lead. You give it a goal; it splits the goal into sub-tasks, hands each one to the best specialist with a short brief, runs independent work in parallel, and brings the compact results back to you as one answer. It deliberately never reads code, edits files or runs commands itself, so every piece of work is done by an expert with the right tools, and you can follow each delegation in the Progress panel.</>,
    can: [
      "Splits a request into sub-tasks and delegates each one to the best specialist, in parallel when they are independent.",
      "Creates custom agents on the fly when no specialist fits (for example a CAN-log analyst or a MISRA checker), and keeps them for later.",
      "Tracks multi-step work on the task board and links Jazz work items.",
      "Sends non-trivial plans and finished work to the Challenger before declaring them done.",
      "Runs specialists on another harness (Copilot, OpenCode, Cursor Agent, Claude Code, Pi, GitLab Duo) when you ask for it.",
    ],
    when: [
      "You have a goal rather than a single step: “add the new DID and test it”, “analyse this defect and prepare a deck”.",
      "The work spans several skills, such as analysis, code, tests and a review.",
      "You don’t know which specialist to pick. Start here and let it choose.",
    ],
    instead: <>For one focused question to one expert, <code>@mention</code> the specialist directly. It is faster and uses fewer requests.</>,
    output: <>A short integrated answer: what was done, by whom, the outcome, and links to artifacts (reports, diffs, decks). Open the Progress panel to see every delegation and its result.</>,
    flows: [
      {
        title: "Feature from a Jazz work item",
        steps: [
          { actor: "you", text: "“Implement work item 48213 (new brake-wear DID) and make sure it is tested.”" },
          { actor: "flashmaster", text: "Creates tasks on the board and delegates in parallel: the work item to the Requirements Analyst, the CDD/Dcm impact to the AUTOSAR & Vector Expert." },
          { actor: "analyst", text: "Returns acceptance criteria and the affected modules." },
          { actor: "autosar-vector", text: "Returns the DID layout, Dcm/NvM configuration changes and a DBC/CDD consistency check." },
          { actor: "challenger", text: "Reviews the plan: “Proceed with changes: define the NvM write strategy.”" },
          { actor: "software-expert", text: "Implements the change and runs the build and unit tests." },
          { actor: "tester", text: "Adds tests for each acceptance criterion and reports 12/12 passing." },
          { actor: "flashmaster", text: "Summarises the result for you, links the diff in Artifacts and closes the tasks." },
        ],
      },
      {
        title: "A job no specialist covers",
        steps: [
          { actor: "you", text: "“Go through these 40 CAN traces and tell me which ones show the wake-up storm.”" },
          { actor: "flashmaster", text: "Checks list_roles, finds no CAN-log specialist and creates one with create_agent: a CAN-log analyst with clear instructions and the vector-autosar tools." },
          { actor: "flashmaster", text: "Delegates the traces to the new agent in batches, in parallel." },
          { actor: "flashmaster", text: "Integrates the findings into one table. The new agent stays in your Specialists list for next time." },
        ],
      },
    ],
    prompts: [
      "Analyse defect 51022, find the root cause and prepare a 5-slide summary for tomorrow’s steering meeting.",
      "Refactor the PWM driver to support the new timer, keep the API stable, and get it reviewed.",
      "Run the reviewer and the challenger on my uncommitted changes and tell me what must change before I commit.",
      "Run this on OpenCode with the cheapest model: summarise every TODO in src/ by module.",
    ],
    tips: [
      <>Say what “done” means (tests pass, a deck exists, a work item is commented). TheFlashMaster uses it to judge results.</>,
      <>Ask it about progress any time (“where are we?”). It answers from the task board and delegations without re-running work.</>,
    ],
  },
  {
    name: "challenger", title: "Challenger", tools: ["flashmaster-core", "jazz"],
    summary: "A constructive devil’s advocate that tries to break a plan, design or implementation before reality does.",
    purpose: <>The Challenger exists to find what is wrong while it is still cheap to fix: before the code is written, before the HIL campaign, before the release. It doesn’t produce the work; it pressure-tests it. Every point it makes must be backed by evidence, and it ends with one clear verdict so the team knows whether to proceed.</>,
    can: [
      "Restates the claim, lists the load-bearing assumptions and how to check each one cheaply.",
      "Runs a pre-mortem: the three most likely reasons this fails.",
      "Finds gaps: edge cases, error paths, timing, safety (ASIL), security, testability, rollback.",
      "Proposes at least one materially different alternative and gives a clear verdict: Proceed, Proceed with changes, or Rethink.",
    ],
    when: [
      "Before you commit to a plan, a design or an estimate.",
      "Before significant work is declared done. TheFlashMaster does this automatically.",
      "When a solution feels too easy, or the stakes (safety, release, customer) are high.",
    ],
    instead: <>It doesn’t rewrite the work. For a line-by-line code review, use the <b>Code Reviewer</b>.</>,
    output: <>Claim, assumptions, pre-mortem, gaps and alternatives, ranked, each with evidence, then a verdict: <b>Proceed</b>, <b>Proceed with changes</b> (numbered must-fix items) or <b>Rethink</b>.</>,
    flows: [
      {
        title: "Challenging an architecture proposal",
        steps: [
          { actor: "you", text: "“@challenger here is the architect’s proposal to move diagnostics to a separate core. Is it sound?”" },
          { actor: "challenger", text: "Lists assumptions: inter-core latency below 1 ms, no shared NvM blocks. Shows how to measure each one." },
          { actor: "challenger", text: "Pre-mortem: the DTC storage race between cores, the startup ordering, and the lack of a measurement plan." },
          { actor: "challenger", text: "Verdict: Proceed with changes. 1) Add an IOC timing budget. 2) Define NvM block ownership. 3) Add a startup sequence test." },
        ],
      },
    ],
    prompts: [
      "Challenge this plan before we start. What breaks first?",
      "We think the flicker comes from the PWM timer. Try to prove us wrong.",
      "Is this estimate realistic? List the assumptions behind it.",
    ],
  },
  {
    name: "analyst", title: "Requirements Analyst", tools: ["flashmaster-core", "jazz"],
    summary: "Turns requests and work items into clear requirements, acceptance criteria and impact analysis.",
    purpose: <>Most rework starts with an unclear requirement. The Requirements Analyst turns a request, a Jazz work item or a DOORS Next module into something the team can build and test: a clear scope, open questions, testable acceptance criteria, and an impact analysis that names the files, signals and tests affected.</>,
    can: [
      "Clarifies goal, scope, assumptions and open questions.",
      "Writes testable acceptance criteria (Given/When/Then).",
      "Impact analysis: affected modules, interfaces, signals, configurations and tests, with paths.",
      "Reads Jazz work items, DOORS Next requirements (rm_search / rm_get) and Word/Excel/PDF specs.",
    ],
    when: [
      "A request or work item is vague and needs to be made testable before anyone builds.",
      "You need to know what a change touches before estimating or planning it.",
      "You need traceability from requirement ids to code and tests.",
    ],
    output: <>Scope and assumptions, open questions, acceptance criteria per requirement id, and an impact list with file paths.</>,
    flows: [
      {
        title: "From DOORS Next requirements to acceptance criteria",
        steps: [
          { actor: "you", text: "Select three requirements in IBM Jazz → Requirements and click Analyse." },
          { actor: "analyst", text: "Reads only those requirements with rm_get and orients in the module with rm_outline." },
          { actor: "analyst", text: "Searches the code for the signals and functions they mention and lists the affected files." },
          { actor: "analyst", text: "Returns Given/When/Then criteria per requirement id, two open questions, and the impact list." },
        ],
      },
    ],
    prompts: [
      "Make work item 48213 testable: acceptance criteria and open questions.",
      "Which modules and tests does SRS-1102 (pedal debounce) affect?",
      "Compare the spec in specs/lighting.docx with the current implementation and list the gaps.",
    ],
  },
  {
    name: "architect", title: "Software Architect", tools: ["flashmaster-core", "jazz"],
    summary: "Designs and evaluates architecture, module boundaries, interfaces and trade-offs.",
    purpose: <>The Software Architect decides the shape of a solution before it is built. It maps the current structure, then lays out two or three real options with their trade-offs and recommends one. For automotive software it respects AUTOSAR layering, ASIL partitioning, and timing and memory budgets.</>,
    can: [
      "Maps the current structure with targeted searches and describes it briefly.",
      "Proposes 2–3 options with trade-offs and a recommendation, including risks and migration steps.",
      "Respects AUTOSAR layering (ASW / RTE / BSW), ASIL partitioning, timing and memory constraints.",
      "Saves long design documents as artifacts.",
    ],
    when: [
      "A new feature or refactoring changes module boundaries or interfaces.",
      "You need to choose between approaches and want the trade-offs written down.",
      "Before a large implementation, to agree on the shape of the solution.",
    ],
    instead: <>For small, local changes, go straight to the <b>Software Expert</b>.</>,
    output: <>A short description of the current architecture, the options compared in a table, a recommendation with risks and migration steps, and a design artifact when the document is long.</>,
    flows: [
      {
        title: "Choosing a design",
        steps: [
          { actor: "you", text: "“@architect we need OTA support for calibration data. How should we structure it?”" },
          { actor: "architect", text: "Maps the bootloader, NvM layout and the current calibration access." },
          { actor: "architect", text: "Compares three options: an A/B partition, a delta in the NvM block, and a separate calibration ECU service." },
          { actor: "architect", text: "Recommends A/B with a migration plan and a list of what to measure, and saves the design as an artifact." },
          { actor: "challenger", text: "(Through TheFlashMaster) pressure-tests the recommendation before you commit." },
        ],
      },
    ],
    prompts: [
      "Propose how to split the body controller into ASIL-B and QM partitions.",
      "Review the current module dependencies and suggest how to break the cycle between Com and Diag.",
      "Give me 3 options for logging on the target with their RAM and CPU cost.",
    ],
  },
  {
    name: "software-expert", title: "Software Expert", tools: ["flashmaster-core"],
    summary: "Implements and refactors code, with deep C/C++, Python, TypeScript and embedded expertise.",
    purpose: <>The Software Expert is the team’s implementer. Given a clear task, it reads only the code it needs, makes a minimal change in the existing style, builds it, and runs the tests. It reports which files changed and why, along with the exact commands it ran and their results.</>,
    can: [
      "Makes minimal, focused changes that follow the existing style.",
      "Builds and runs the relevant tests after a change and reports the exact commands and results.",
      "Applies embedded rules: no dynamic allocation at runtime, careful integer promotion and volatile use, short ISRs.",
    ],
    when: [
      "The task is clear and you need code written, fixed or refactored.",
      "Executing the tasks of an approved plan.",
    ],
    instead: <>If the cause of a bug is still unknown, start with the <b>winIDEA Debug Engineer</b> (on target) or the Superpowers <code>/debug</code> skill.</>,
    output: <>A list of changed files with one line each on why, the build and test commands with their results, and the diff in Artifacts.</>,
    flows: [
      {
        title: "Implementing a small change",
        steps: [
          { actor: "you", text: "“@software-expert add a 20 ms debounce to the brake pedal input (SRS-1102).”" },
          { actor: "software-expert", text: "Finds the input handler and the existing debounce helper and reuses it, without adding a new module." },
          { actor: "software-expert", text: "Builds and runs the unit tests, then reports: 2 files changed, “ctest: 48 passed”." },
          { actor: "you", text: "Open Artifacts to see the side-by-side diff, then ask @reviewer to check it." },
        ],
      },
    ],
    prompts: [
      "Implement task 3 of the plan in docs/plans/ota.md.",
      "Refactor can_rx.c so the dispatch table is const and lives in flash.",
      "Port the Python signal decoder in tools/ to TypeScript with the same tests.",
    ],
  },
  {
    name: "reviewer", title: "Code Reviewer", tools: ["flashmaster-core", "jazz"],
    summary: "Reviews changes for correctness, safety, maintainability and project conventions.",
    purpose: <>The Code Reviewer is your second pair of eyes before a commit. It looks only at the scope you give it (a diff, files or a feature) and returns findings ranked by severity, each with a location and a concrete fix. If the change is fine, it says so in one line.</>,
    can: [
      "Reviews only the given scope (a diff, files or a feature), starting from git diff.",
      "Ranks findings as blocker, major, minor or nit, each with file:line and a concrete fix.",
      "Checks error handling, concurrency, resource leaks, security, tests, and MISRA-relevant issues in embedded C.",
    ],
    when: [
      "Before you commit or open a merge request.",
      "After each task of a Superpowers plan, to catch problems while they are still small.",
    ],
    instead: <>To question whether the approach itself is right, ask the <b>Challenger</b>.</>,
    output: <>A ranked list: <b>blocker</b>, <b>major</b>, <b>minor</b>, <b>nit</b>, each with file:line, the problem and the fix. Or one line saying it is fine.</>,
    flows: [
      {
        title: "Review before commit",
        steps: [
          { actor: "you", text: "“@reviewer review my uncommitted changes.”" },
          { actor: "reviewer", text: "Reads git diff and only the surrounding code it needs." },
          { actor: "reviewer", text: "Reports: blocker at can_rx.c:88 (a buffer index isn’t bounds-checked, with a fix), minor at debounce.c:14 (a magic number)." },
          { actor: "software-expert", text: "(Through TheFlashMaster or on your request) applies the fixes, and the Reviewer confirms." },
        ],
      },
    ],
    prompts: [
      "Review my uncommitted changes.",
      "Review src/diag/ for MISRA-relevant issues only.",
      "Review the diff against main with a focus on concurrency.",
    ],
  },
  {
    name: "tester", title: "Test Engineer", tools: ["flashmaster-core", "vector-autosar", "jazz"],
    summary: "Designs and writes tests, runs suites, analyses failures and coverage.",
    purpose: <>The Test Engineer turns requirements and code paths into tests that would actually catch a bug: equivalence classes, boundaries and error paths. It writes the tests in the framework the project already uses, runs them, and explains failures with a root-cause hypothesis and the evidence.</>,
    can: [
      "Derives test cases from requirements and code paths: equivalence classes, boundaries, error paths.",
      "Writes tests in the project’s framework: pytest, GoogleTest, Unity/CMock, vitest, CANoe test modules / CAPL.",
      "Runs suites and reports pass/fail counts, with a root-cause hypothesis for each failure.",
    ],
    when: [
      "New code needs tests, or coverage of a requirement must be shown.",
      "A suite fails and you need the failures sorted and explained.",
    ],
    instead: <>For HiL/SiL test cases in EXAM, use the <b>EXAM Test Agent</b>.</>,
    output: <>The test cases (or the test files written), the pass/fail counts, and for each failure a likely cause with evidence. Long logs go to Artifacts.</>,
    flows: [
      {
        title: "Testing a requirement",
        steps: [
          { actor: "you", text: "“@tester write tests for SRS-1102 and run them.”" },
          { actor: "tester", text: "Derives cases: a pulse just below 20 ms, exactly 20 ms, above 20 ms, bouncing input, and a stuck-high fault." },
          { actor: "tester", text: "Writes them in the existing GoogleTest suite and runs ctest." },
          { actor: "tester", text: "Reports 5/6 passing. The stuck-high case fails because the timeout path is never reached (evidence: the coverage line), and the log is saved as an artifact." },
        ],
      },
    ],
    prompts: [
      "Write boundary tests for the voltage plausibility check and run them.",
      "The nightly suite has 7 failures. Sort them by likely cause.",
      "Write a CANoe test module for the wake-up sequence in the DBC.",
    ],
  },
  {
    name: "autosar-vector", title: "AUTOSAR & Vector Expert", tools: ["flashmaster-core", "vector-autosar", "jazz"],
    summary: "Expert in AUTOSAR and the Vector toolchain: DBC, ARXML, CDD, DaVinci, CANoe and CAPL.",
    purpose: <>The AUTOSAR & Vector Expert answers the questions that usually mean opening four Vector tools. With the <code>vector-autosar</code> tools it asks targeted questions of DBC, ARXML and CDD files instead of reading them whole, lints CAPL, runs CANoe tests and drives the DaVinci Configurator command line. It knows the BSW stack and flags inconsistencies between the files.</>,
    can: [
      "Answers targeted questions about DBC messages and signals, ARXML elements and references, and CDD diagnostics (DIDs, routines, DTCs) without dumping whole files.",
      "Indexes and lints CAPL, runs CANoe tests over COM automation, and validates or generates with the DaVinci Configurator command line.",
      "Knows SWC/port design, RTE, BSW configuration (Com, PduR, CanIf, CanTp, Dcm, Dem, NvM, Os), E2E and UDS.",
      "Flags inconsistencies between DBC, ARXML and CDD.",
    ],
    when: [
      "Questions about signals, PDUs, ECU extracts or diagnostic services.",
      "Changing a communication or BSW configuration.",
      "Writing or checking CAPL and CANoe test modules.",
    ],
    output: <>Answers that cite ARXML paths or DBC message/signal names, consistency findings, and CANoe or DaVinci results.</>,
    flows: [
      {
        title: "Tracing a signal end to end",
        steps: [
          { actor: "you", text: "“@autosar-vector where does BrakePedalPos come from and who receives it?”" },
          { actor: "tool:dbc_find", text: "Finds the signal in message BRK_01 (0x1A0), 12 bits, factor 0.1." },
          { actor: "tool:arxml_refs", text: "Follows the I-signal to the PDU, the Com configuration and the receiving SWC port." },
          { actor: "autosar-vector", text: "Reports the chain and flags that the ARXML init value differs from the DBC (0 vs 0xFFF)." },
        ],
      },
    ],
    prompts: [
      "List every DID in the CDD that is writable in the extended session.",
      "Check that DBC, ARXML and CDD agree on the signals of the BCM.",
      "Lint tests/wakeup.can and run the CANoe test module.",
    ],
  },
  {
    name: "winidea-debugger", title: "winIDEA Debug Engineer", tools: ["flashmaster-core", "winidea"],
    summary: "Debugs embedded software on real hardware through iSYSTEM/TASKING winIDEA.",
    purpose: <>Some bugs only exist on the target. The winIDEA Debug Engineer drives your debugger through the winIDEA Python SDK and debugs systematically: it reproduces the symptom, forms two or three hypotheses, places breakpoints and watches that tell them apart, and concludes with evidence such as values and call stacks.</>,
    can: [
      "Connects, downloads, resets, runs, halts and steps the target.",
      "Sets breakpoints, reads and writes variables and memory, reads the call stack, evaluates expressions.",
      "Follows systematic debugging: reproduce, 2–3 hypotheses, instrument to tell them apart, conclude with evidence.",
    ],
    when: [
      "A defect only shows on target, or depends on timing, registers or memory.",
      "You need evidence (values, call stacks) rather than a guess from reading code.",
    ],
    instead: <>It states what it will write before touching memory or flash. Without winIDEA and its SDK installed, use the <b>Software Expert</b> with <code>/debug</code>.</>,
    output: <>The symptom, the hypotheses, the observations that decided between them (values, stacks), the root cause, and a proposed fix with how to verify it on target.</>,
    flows: [
      {
        title: "A reset on the target",
        steps: [
          { actor: "you", text: "“@winidea-debugger the ECU resets about 2 s after ignition. Find out why.”" },
          { actor: "winidea-debugger", text: "Hypotheses: a watchdog timeout in init, a stack overflow in the Com task, or a trap from an unaligned access." },
          { actor: "tool:set_breakpoint", text: "Sets breakpoints on the trap handler and the watchdog callback, then runs." },
          { actor: "tool:call_stack", text: "Halts in the trap handler: the call stack shows NvM_ReadAll → memcpy with an odd address." },
          { actor: "winidea-debugger", text: "Root cause: an unaligned access in the NvM copy. It proposes the fix and a check to run on target." },
        ],
      },
    ],
    prompts: [
      "Connect, download build/app.elf and stop at main.",
      "Watch g_wheelSpeed[0..3] while I spin the wheel and tell me which sensor is off.",
      "Find why the CAN Rx queue overflows under load.",
    ],
  },
  {
    name: "exam-test-agent", title: "EXAM Test Agent", tools: ["flashmaster-core", "exam", "jazz"],
    summary: "Expert in EXAM (MicroNova) HiL/SiL test automation: designs and creates test cases, runs suites, analyses results.",
    purpose: <>The EXAM Test Agent closes the loop from requirement to HiL result. It designs test cases from DOORS Next or Jazz, creates them in EXAM in the least invasive way (preferring the Test Case Generator over Groovy), runs them on the agreed system configuration, and separates test defects from real findings. It records what it learns about your EXAM site in notes, so later runs start faster.</>,
    can: [
      "Checks that EXAM is up, installs the RESTapi plugin if needed, and opens models.",
      "Designs test cases from DOORS Next requirements or Jazz items, with boundaries, state transitions and fault cases.",
      "Creates them through the Test Case Generator or Groovy, filters and runs suites, and reads failures from JUnit results.",
      "Separates test defects (expectation, timing, mapping) from real findings in the system under test.",
    ],
    when: [
      "You test on a HiL, SiL or test bench driven by EXAM.",
      "You need EXAM test cases created from requirements, or a campaign run and analysed.",
    ],
    output: <>A test design table (ID, requirement, steps, expected result with tolerance and technique), the EXAM elements it created, and run results as passed/failed/errors with a one-line cause for each failure.</>,
    flows: [
      {
        title: "Requirement to HiL result",
        steps: [
          { actor: "you", text: "“@exam-test-agent create HiL tests for SRS-2210 (low-beam auto on) and run them on the BCM bench.”" },
          { actor: "tool:exam_status", text: "EXAM is running and the RESTapi plugin is available. It reads exam_notes for the site’s keyword syntax." },
          { actor: "exam-test-agent", text: "Designs 6 cases: the light-sensor thresholds, hysteresis, and a sensor timeout fault." },
          { actor: "tool:exam_generate", text: "Writes keyword descriptions and generates the test cases in package Tests.Lighting." },
          { actor: "tool:exam_run", text: "Runs them on the bench configuration, then reads the failures with exam_results." },
          { actor: "exam-test-agent", text: "5 passed, 1 failed. The hysteresis case fails because the threshold is 30 lx instead of 35 lx: a real finding, with evidence." },
        ],
      },
    ],
    prompts: [
      "Check my EXAM setup and tell me what is missing.",
      "Run the suite Regression.Wiper on the SiL configuration and summarise the failures.",
      "Create test cases for the DTC set/clear behaviour of B1234.",
    ],
  },
  {
    name: "jazz-analyst", title: "Jazz Work Item Analyst", tools: ["flashmaster-core", "jazz"],
    summary: "Fetches IBM Jazz/EWM work items, analyses them against the code, and updates them.",
    purpose: <>The Jazz Work Item Analyst connects your queue to your code. It reads only the work items you need, summarises each in a few lines, finds the files they probably affect, and estimates effort and risk. It updates or comments on items only when you ask, and quotes exactly what it wrote.</>,
    can: [
      "Queries and reads work items and summarises each in two or three lines.",
      "Finds the likely affected files and estimates effort and risk.",
      "Creates board tasks linked to work items, and comments or updates items when asked, quoting what it wrote.",
    ],
    when: [
      "Triage: “what is in my queue and how big is each item?”",
      "Linking work items to the code they affect.",
    ],
    instead: <>It changes work items only when your request says so.</>,
    output: <>A triage table (id, type, state, what is asked, likely files, effort, risk), and the exact text of any comment it posted.</>,
    flows: [
      {
        title: "Morning triage",
        steps: [
          { actor: "you", text: "“@jazz-analyst triage my open defects for the lighting team.”" },
          { actor: "tool:jazz_query", text: "Fetches the 9 open defects assigned to the team." },
          { actor: "jazz-analyst", text: "Summarises each, maps it to likely files and estimates effort and risk." },
          { actor: "jazz-analyst", text: "On request, creates board tasks linked to the three high-risk items." },
        ],
      },
    ],
    prompts: [
      "Triage my open defects and rank them by risk.",
      "Read 48213 and tell me which files it affects.",
      "Comment the analysis result on 51022.",
    ],
  },
  {
    name: "rca-analyst", title: "NOW Analysis & RCA (Ishikawa)", tools: ["flashmaster-core", "office", "jazz"],
    summary: "Structured problem analysis in NOW format with an Ishikawa root-cause analysis, following INCOSE practice.",
    purpose: <>When something has gone wrong and people need to understand why, the RCA Analyst writes a structured analysis. It uses the NOW format (current situation, objective, way forward) and an Ishikawa root-cause analysis with 5 Whys, following INCOSE systems-engineering practice. Every cause is marked confirmed, plausible or ruled out, with evidence, and it also asks why the defect escaped verification.</>,
    can: [
      "Writes the NOW analysis: current situation, measurable objective, way forward with owners and verification methods.",
      "Builds an Ishikawa diagram (drawn in the chat) with systems-engineering categories and 5 Whys.",
      "Marks each cause confirmed, plausible or ruled out, with evidence, and asks why the defect escaped verification.",
      "Exports to PowerPoint or SVG with the office tools.",
    ],
    when: [
      "A field issue, escalation or recurring defect needs a root cause and corrective actions.",
      "Management or a customer expects a structured 8D-style analysis.",
    ],
    output: <>An Ishikawa diagram drawn in the chat, the NOW sections, and a cause table (cause, category, status, evidence, trace). On request it also produces a deck or an SVG.</>,
    flows: [
      {
        title: "Field issue to corrective actions",
        steps: [
          { actor: "you", text: "“@rca-analyst analyse defect 51022 (cold-start flicker) and give me a deck.”" },
          { actor: "rca-analyst", text: "Reads the defect, the logs and the related requirements, and writes the N (Now) section from the facts." },
          { actor: "rca-analyst", text: "Fills the fishbone, drills down with 5 Whys, and confirms “shared PWM timer” with evidence." },
          { actor: "rca-analyst", text: "Writes the W (Way forward) section: containment, corrective and preventive actions with owners and verification." },
          { actor: "tool:pptx_create", text: "Builds the deck with an Ishikawa slide. You get the path to the file." },
        ],
      },
    ],
    prompts: [
      "Do a NOW analysis with Ishikawa for the CAN bus-off issue in the attached logs.",
      "Why did this defect escape our verification? Use the test reports in reports/.",
      "Turn the RCA in this chat into a 6-slide deck using our template.",
    ],
  },
  {
    name: "presentation-expert", title: "Presentation Expert", tools: ["flashmaster-core", "office"],
    summary: "Creates and edits PowerPoint decks: storyline, clean slides, speaker notes and corporate templates.",
    purpose: <>The Presentation Expert turns results into a deck that gets a decision. It starts from the audience and the decision you need, builds a storyline, and writes slides whose titles state the takeaway, with detail moved to the speaker notes. For an existing deck it edits only the slides that need to change.</>,
    can: [
      "Builds a storyline for the audience and decision, with takeaway titles and at most five bullets a slide.",
      "Creates new decks in one pass, using a corporate template when you name one.",
      "Edits existing decks slide by slide instead of rebuilding them, and adds Ishikawa slides.",
    ],
    when: [
      "Results need to be presented: status, analysis, design review, steering committee.",
      "An existing deck needs updating with new numbers or findings.",
    ],
    output: <>The saved .pptx path, the list of slide titles, and anything it could not do. It doesn’t paste slide contents back into the chat.</>,
    flows: [
      {
        title: "Updating a status deck",
        steps: [
          { actor: "you", text: "“@presentation-expert update decks/weekly.pptx with this week’s test results.”" },
          { actor: "tool:pptx_outline", text: "Reads the slide titles and finds that slides 3 and 4 hold test status." },
          { actor: "tool:pptx_edit", text: "Updates the numbers and the takeaway titles on those two slides only." },
          { actor: "presentation-expert", text: "Reports the saved path and the changed slide titles." },
        ],
      },
    ],
    prompts: [
      "Make a 6-slide steering deck from the RCA in this chat, using templates/corp.potx.",
      "Shorten decks/review.pptx to 10 slides and move the details to the speaker notes.",
      "Add a slide with the test results table after slide 4.",
    ],
  },
];
