import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { convert as htmlToText } from "html-to-text";

const CANVAS_BASE_URL = process.env.CANVAS_BASE_URL; // e.g. https://canvas.upenn.edu
const CANVAS_API_TOKEN = process.env.CANVAS_API_TOKEN; // Canvas personal access token
const MCP_SHARED_SECRET = process.env.MCP_SHARED_SECRET; // optional: require callers to send this as a bearer token
const PORT = process.env.PORT || 3000;

if (!CANVAS_BASE_URL || !CANVAS_API_TOKEN) {
  console.warn(
    "WARNING: CANVAS_BASE_URL and/or CANVAS_API_TOKEN are not set. Tool calls will fail until these env vars are configured."
  );
}

// ---- Canvas API helper ----
async function canvasFetch(path, { params } = {}) {
  if (!CANVAS_BASE_URL || !CANVAS_API_TOKEN) {
    throw new Error(
      "Canvas is not configured on this server. Set CANVAS_BASE_URL and CANVAS_API_TOKEN environment variables."
    );
  }
  const url = new URL(CANVAS_BASE_URL.replace(/\/$/, "") + "/api/v1" + path);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) {
        value.forEach((v) => url.searchParams.append(key, v));
      } else if (value !== undefined && value !== null) {
        url.searchParams.set(key, value);
      }
    }
  }
  url.searchParams.set("per_page", "100");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${CANVAS_API_TOKEN}` },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Canvas API error ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

function toReadableText(html) {
  if (!html) return "";
  return htmlToText(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: false } },
      { selector: "img", format: "skip" },
    ],
  }).trim();
}

// ---- Build the MCP server with tools ----
function buildServer() {
  const server = new McpServer({
    name: "canvas-course-materials",
    version: "1.0.0",
  });

  server.registerTool(
    "list_courses",
    {
      title: "List Canvas Courses",
      description:
        "List the current user's active Canvas courses (id, name, course code, term).",
      inputSchema: {
        include_concluded: z
          .boolean()
          .optional()
          .describe("Include concluded/past courses (default false)"),
      },
    },
    async ({ include_concluded }) => {
      const enrollmentState = include_concluded ? undefined : "active";
      const courses = await canvasFetch("/courses", {
        params: {
          "enrollment_state": enrollmentState,
          "state[]": include_concluded ? ["available", "completed"] : ["available"],
          "include[]": ["term"],
        },
      });
      const simplified = courses.map((c) => ({
        id: c.id,
        name: c.name,
        course_code: c.course_code,
        term: c.term?.name,
        workflow_state: c.workflow_state,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(simplified, null, 2) }],
      };
    }
  );

  server.registerTool(
    "list_course_files",
    {
      title: "List Course Files",
      description:
        "List files stored in a Canvas course's Files section. Returns file id, name, size, content type, and a direct download URL.",
      inputSchema: {
        course_id: z.union([z.string(), z.number()]).describe("The Canvas course ID"),
        search_term: z
          .string()
          .optional()
          .describe("Optional search term to filter files by name"),
      },
    },
    async ({ course_id, search_term }) => {
      const files = await canvasFetch(`/courses/${course_id}/files`, {
        params: {
          search_term,
          sort: "created_at",
          order: "desc",
        },
      });
      const simplified = files.map((f) => ({
        id: f.id,
        display_name: f.display_name,
        filename: f.filename,
        size_bytes: f.size,
        content_type: f["content-type"],
        folder_id: f.folder_id,
        download_url: f.url,
        updated_at: f.updated_at,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(simplified, null, 2) }],
      };
    }
  );

  server.registerTool(
    "list_course_folders",
    {
      title: "List Course Folders",
      description:
        "List folders in a Canvas course's Files section, useful for browsing structure before listing files in a specific folder.",
      inputSchema: {
        course_id: z.union([z.string(), z.number()]).describe("The Canvas course ID"),
      },
    },
    async ({ course_id }) => {
      const folders = await canvasFetch(`/courses/${course_id}/folders`);
      const simplified = folders.map((f) => ({
        id: f.id,
        name: f.name,
        full_name: f.full_name,
        parent_folder_id: f.parent_folder_id,
        files_count: f.files_count,
        folders_count: f.folders_count,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(simplified, null, 2) }],
      };
    }
  );

  server.registerTool(
    "list_folder_files",
    {
      title: "List Files In a Folder",
      description: "List files within a specific Canvas folder (use list_course_folders to find folder IDs).",
      inputSchema: {
        folder_id: z.union([z.string(), z.number()]).describe("The Canvas folder ID"),
      },
    },
    async ({ folder_id }) => {
      const files = await canvasFetch(`/folders/${folder_id}/files`);
      const simplified = files.map((f) => ({
        id: f.id,
        display_name: f.display_name,
        filename: f.filename,
        size_bytes: f.size,
        content_type: f["content-type"],
        download_url: f.url,
        updated_at: f.updated_at,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(simplified, null, 2) }],
      };
    }
  );

  server.registerTool(
    "list_course_modules",
    {
      title: "List Course Modules",
      description:
        "List a Canvas course's modules and their items (files, pages, assignments, etc). Useful for seeing how materials are organized week-by-week.",
      inputSchema: {
        course_id: z.union([z.string(), z.number()]).describe("The Canvas course ID"),
      },
    },
    async ({ course_id }) => {
      const modules = await canvasFetch(`/courses/${course_id}/modules`, {
        params: { "include[]": ["items"] },
      });
      const simplified = modules.map((m) => ({
        id: m.id,
        name: m.name,
        position: m.position,
        items: (m.items || []).map((it) => ({
          id: it.id,
          title: it.title,
          type: it.type,
          content_id: it.content_id,
          url: it.url,
        })),
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(simplified, null, 2) }],
      };
    }
  );

  server.registerTool(
    "get_file_metadata",
    {
      title: "Get File Metadata",
      description: "Get metadata and a fresh download URL for a specific Canvas file by its file ID.",
      inputSchema: {
        file_id: z.union([z.string(), z.number()]).describe("The Canvas file ID"),
      },
    },
    async ({ file_id }) => {
      const f = await canvasFetch(`/files/${file_id}`);
      const simplified = {
        id: f.id,
        display_name: f.display_name,
        filename: f.filename,
        size_bytes: f.size,
        content_type: f["content-type"],
        download_url: f.url,
        updated_at: f.updated_at,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(simplified, null, 2) }],
      };
    }
  );

  server.registerTool(
    "get_syllabus",
    {
      title: "Get Course Syllabus",
      description: "Get the syllabus body (readable text) for a Canvas course.",
      inputSchema: {
        course_id: z.union([z.string(), z.number()]).describe("The Canvas course ID"),
      },
    },
    async ({ course_id }) => {
      const course = await canvasFetch(`/courses/${course_id}`, {
        params: { "include[]": ["syllabus_body"] },
      });
      const text = toReadableText(course.syllabus_body) || "(No syllabus content found.)";
      return { content: [{ type: "text", text }] };
    }
  );

  server.registerTool(
    "list_pages",
    {
      title: "List Course Pages",
      description:
        "List the wiki Pages in a Canvas course (syllabus-adjacent content, lecture notes, course info pages, etc). Returns titles and URLs slugs; use get_page to fetch full content.",
      inputSchema: {
        course_id: z.union([z.string(), z.number()]).describe("The Canvas course ID"),
      },
    },
    async ({ course_id }) => {
      const pages = await canvasFetch(`/courses/${course_id}/pages`, {
        params: { sort: "updated_at", order: "desc" },
      });
      const simplified = pages.map((p) => ({
        title: p.title,
        url_slug: p.url,
        updated_at: p.updated_at,
        published: p.published,
        front_page: p.front_page,
      }));
      return { content: [{ type: "text", text: JSON.stringify(simplified, null, 2) }] };
    }
  );

  server.registerTool(
    "get_page",
    {
      title: "Get Page Content",
      description:
        "Get the full readable content of a specific Canvas wiki page by its URL slug (from list_pages).",
      inputSchema: {
        course_id: z.union([z.string(), z.number()]).describe("The Canvas course ID"),
        page_url: z.string().describe("The page's URL slug, e.g. 'week-3-notes' (from list_pages)"),
      },
    },
    async ({ course_id, page_url }) => {
      const page = await canvasFetch(`/courses/${course_id}/pages/${encodeURIComponent(page_url)}`);
      const text = `# ${page.title}\n\n${toReadableText(page.body) || "(No content.)"}`;
      return { content: [{ type: "text", text }] };
    }
  );

  server.registerTool(
    "list_announcements",
    {
      title: "List Course Announcements",
      description: "List recent announcements posted in a Canvas course, with readable message content.",
      inputSchema: {
        course_id: z.union([z.string(), z.number()]).describe("The Canvas course ID"),
        limit: z.number().optional().describe("Max number of announcements to return (default 20)"),
      },
    },
    async ({ course_id, limit }) => {
      const announcements = await canvasFetch(`/announcements`, {
        params: { "context_codes[]": [`course_${course_id}`] },
      });
      const simplified = announcements.slice(0, limit || 20).map((a) => ({
        id: a.id,
        title: a.title,
        posted_at: a.posted_at,
        author: a.author?.display_name,
        message: toReadableText(a.message),
      }));
      return { content: [{ type: "text", text: JSON.stringify(simplified, null, 2) }] };
    }
  );

  server.registerTool(
    "list_assignments",
    {
      title: "List Course Assignments",
      description:
        "List assignments in a Canvas course, including due dates, points, and readable descriptions.",
      inputSchema: {
        course_id: z.union([z.string(), z.number()]).describe("The Canvas course ID"),
      },
    },
    async ({ course_id }) => {
      const assignments = await canvasFetch(`/courses/${course_id}/assignments`, {
        params: { order_by: "due_at" },
      });
      const simplified = assignments.map((a) => ({
        id: a.id,
        name: a.name,
        due_at: a.due_at,
        points_possible: a.points_possible,
        submission_types: a.submission_types,
        html_url: a.html_url,
        description: toReadableText(a.description),
      }));
      return { content: [{ type: "text", text: JSON.stringify(simplified, null, 2) }] };
    }
  );

  server.registerTool(
    "list_discussion_topics",
    {
      title: "List Discussion Topics",
      description:
        "List discussion board topics in a Canvas course, with readable message content (does not include replies).",
      inputSchema: {
        course_id: z.union([z.string(), z.number()]).describe("The Canvas course ID"),
      },
    },
    async ({ course_id }) => {
      const topics = await canvasFetch(`/courses/${course_id}/discussion_topics`);
      const simplified = topics.map((t) => ({
        id: t.id,
        title: t.title,
        posted_at: t.posted_at,
        html_url: t.html_url,
        message: toReadableText(t.message),
      }));
      return { content: [{ type: "text", text: JSON.stringify(simplified, null, 2) }] };
    }
  );

  server.registerTool(
    "get_grades",
    {
      title: "Get Course Grades",
      description:
        "Get your overall grade for a course (current/final score and letter grade) plus a per-assignment breakdown of scores.",
      inputSchema: {
        course_id: z.union([z.string(), z.number()]).describe("The Canvas course ID"),
      },
    },
    async ({ course_id }) => {
      const [enrollments, assignments] = await Promise.all([
        canvasFetch(`/courses/${course_id}/enrollments`, { params: { user_id: "self" } }),
        canvasFetch(`/courses/${course_id}/assignments`, { params: { "include[]": ["submission"] } }),
      ]);

      const enrollment = enrollments[0];
      const overall = enrollment?.grades
        ? {
            current_score: enrollment.grades.current_score,
            current_grade: enrollment.grades.current_grade,
            final_score: enrollment.grades.final_score,
            final_grade: enrollment.grades.final_grade,
          }
        : null;

      const perAssignment = assignments.map((a) => ({
        id: a.id,
        name: a.name,
        points_possible: a.points_possible,
        due_at: a.due_at,
        score: a.submission?.score ?? null,
        grade: a.submission?.grade ?? null,
        submitted_at: a.submission?.submitted_at ?? null,
        workflow_state: a.submission?.workflow_state ?? null,
        late: a.submission?.late ?? null,
        missing: a.submission?.missing ?? null,
      }));

      return {
        content: [
          { type: "text", text: JSON.stringify({ overall, assignments: perAssignment }, null, 2) },
        ],
      };
    }
  );

  server.registerTool(
    "list_quizzes",
    {
      title: "List Course Quizzes",
      description:
        "List quizzes in a Canvas course with due dates, points, and readable instructions/descriptions.",
      inputSchema: {
        course_id: z.union([z.string(), z.number()]).describe("The Canvas course ID"),
      },
    },
    async ({ course_id }) => {
      const quizzes = await canvasFetch(`/courses/${course_id}/quizzes`);
      const simplified = quizzes.map((q) => ({
        id: q.id,
        title: q.title,
        quiz_type: q.quiz_type,
        due_at: q.due_at,
        points_possible: q.points_possible,
        question_count: q.question_count,
        time_limit_minutes: q.time_limit,
        allowed_attempts: q.allowed_attempts,
        description: toReadableText(q.description),
      }));
      return { content: [{ type: "text", text: JSON.stringify(simplified, null, 2) }] };
    }
  );

  server.registerTool(
    "get_quiz",
    {
      title: "Get Quiz Details",
      description:
        "Get full details and instructions for a specific Canvas quiz. Note: actual quiz questions are only exposed by Canvas while you have an active attempt, so this returns the quiz description/instructions rather than question content.",
      inputSchema: {
        course_id: z.union([z.string(), z.number()]).describe("The Canvas course ID"),
        quiz_id: z.union([z.string(), z.number()]).describe("The Canvas quiz ID"),
      },
    },
    async ({ course_id, quiz_id }) => {
      const q = await canvasFetch(`/courses/${course_id}/quizzes/${quiz_id}`);
      const simplified = {
        id: q.id,
        title: q.title,
        due_at: q.due_at,
        points_possible: q.points_possible,
        question_count: q.question_count,
        time_limit_minutes: q.time_limit,
        allowed_attempts: q.allowed_attempts,
        description: toReadableText(q.description),
      };
      return { content: [{ type: "text", text: JSON.stringify(simplified, null, 2) }] };
    }
  );

  server.registerTool(
    "get_quiz_submission",
    {
      title: "Get My Quiz Submission",
      description: "Get your own submission/attempt history and scores for a specific quiz.",
      inputSchema: {
        course_id: z.union([z.string(), z.number()]).describe("The Canvas course ID"),
        quiz_id: z.union([z.string(), z.number()]).describe("The Canvas quiz ID"),
      },
    },
    async ({ course_id, quiz_id }) => {
      const data = await canvasFetch(`/courses/${course_id}/quizzes/${quiz_id}/submissions`);
      const submissions = (data.quiz_submissions || []).map((s) => ({
        id: s.id,
        attempt: s.attempt,
        score: s.score,
        kept_score: s.kept_score,
        workflow_state: s.workflow_state,
        started_at: s.started_at,
        finished_at: s.finished_at,
      }));
      return { content: [{ type: "text", text: JSON.stringify(submissions, null, 2) }] };
    }
  );

  server.registerTool(
    "list_upcoming_deadlines",
    {
      title: "List Upcoming Deadlines",
      description:
        "List your upcoming assignments/quizzes/events across ALL courses, sorted by due date. Good for 'what's due this week' type questions.",
      inputSchema: {},
    },
    async () => {
      const events = await canvasFetch(`/users/self/upcoming_events`);
      const simplified = events.map((e) => ({
        title: e.title,
        type: e.assignment ? "assignment" : e.plannable_type || "event",
        due_at: e.assignment?.due_at || e.start_at,
        course_id: e.assignment?.course_id ?? e.context_code,
        html_url: e.html_url,
        points_possible: e.assignment?.points_possible,
      }));
      return { content: [{ type: "text", text: JSON.stringify(simplified, null, 2) }] };
    }
  );

  server.registerTool(
    "whoami",
    {
      title: "Get Current Canvas User",
      description:
        "Get the profile of the Canvas account this server is authenticated as. Useful as a quick connectivity/auth check.",
      inputSchema: {},
    },
    async () => {
      const me = await canvasFetch(`/users/self`);
      const simplified = { id: me.id, name: me.name, primary_email: me.primary_email ?? me.email };
      return { content: [{ type: "text", text: JSON.stringify(simplified, null, 2) }] };
    }
  );

  return server;
}

// ---- Express app with streamable HTTP transport (stateful sessions) ----
const app = express();
app.use(express.json());

// Optional shared-secret guard, embedded in the URL PATH (not a header), since
// Claude's custom connector UI doesn't support setting arbitrary auth headers
// without full OAuth. If MCP_SHARED_SECRET is set, requests must hit
// /mcp/<secret> instead of /mcp. Strongly recommended since this server holds
// your personal Canvas token server-side.
const MCP_PATH = MCP_SHARED_SECRET ? `/mcp/${MCP_SHARED_SECRET}` : "/mcp";

const transports = {}; // sessionId -> transport

app.post(MCP_PATH, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  let transport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
    };
    const server = buildServer();
    await server.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: no valid session ID provided" },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

const handleSessionRequest = async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
};

app.get(MCP_PATH, handleSessionRequest);
app.delete(MCP_PATH, handleSessionRequest);

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Canvas MCP server listening on port ${PORT}`);
  console.log(`MCP endpoint path: ${MCP_PATH}`);
  if (!MCP_SHARED_SECRET) {
    console.log(
      "NOTE: MCP_SHARED_SECRET is not set — /mcp is unprotected. Set MCP_SHARED_SECRET for a private URL."
    );
  }
});
