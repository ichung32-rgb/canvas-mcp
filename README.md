# Canvas Course Materials MCP Server

A remote MCP server that gives Claude access to your Canvas LMS course materials and files.

## Tools exposed

**Files:**
- `list_courses` — your active (or all) courses
- `list_course_files` — files in a course's Files section
- `list_course_folders` — folder structure in a course
- `list_folder_files` — files within a specific folder
- `get_file_metadata` — metadata + fresh download URL for a specific file

**Course site content:**
- `list_course_modules` — modules and their items (files, pages, assignments)
- `get_syllabus` — the course syllabus, as readable text
- `list_pages` — wiki pages in the course (lecture notes, course info, etc.)
- `get_page` — full readable content of a specific page
- `list_announcements` — announcements with readable message bodies
- `list_assignments` — assignments with due dates, points, and readable descriptions
- `list_discussion_topics` — discussion board topics with readable messages (not replies)

**Grades & quizzes:**
- `get_grades` — your overall course grade plus per-assignment score breakdown
- `list_quizzes` — quizzes with due dates, points, and readable instructions
- `get_quiz` — full details/instructions for one quiz (see note below on questions)
- `get_quiz_submission` — your own attempt history and scores for a quiz

**Cross-course utilities:**
- `list_upcoming_deadlines` — everything due soon across ALL your courses, sorted by date — good for "what's due this week"
- `whoami` — confirms the server is authenticated correctly (quick connectivity check)

> **Note on quiz questions:** Canvas only exposes actual quiz question content while you have an active, in-progress attempt (and even then, only for certain quiz types). `get_quiz` returns the quiz's description/instructions rather than the questions themselves — this is a Canvas API limitation, not something the server withholds.

All Canvas HTML content (pages, announcements, assignment descriptions, discussions, quiz instructions) is converted to plain readable text before being returned.

## 1. Get your Canvas credentials

1. **Base URL**: your school's Canvas domain, e.g. `https://canvas.upenn.edu` (no trailing slash, no `/api/v1`).
2. **API token**: log into Canvas → click your profile picture → **Account** → **Settings** → scroll to **Approved Integrations** → **+ New Access Token** → give it a purpose name like "Claude MCP" → generate → copy the token immediately (Canvas only shows it once).

Keep this token secret — it grants API access to your Canvas account.

## 2. Deploy (pick one)

### Option A: Render (easiest, free tier)

1. Push this folder to a new GitHub repo (or use Render's "Deploy from public repo" with the code inline).
2. Go to https://dashboard.render.com → **New** → **Web Service** → connect the repo.
3. Settings:
   - Build command: `npm install`
   - Start command: `npm start`
4. Under **Environment**, add:
   - `CANVAS_BASE_URL` = `https://canvas.yourschool.edu`
   - `CANVAS_API_TOKEN` = *(your token from step 1)*
   - `MCP_SHARED_SECRET` = *(a long random string — run `openssl rand -hex 32` to generate one)*
5. Deploy. Render gives you a public URL like `https://canvas-mcp-xyz.onrender.com`.
6. Your MCP endpoint is `https://canvas-mcp-xyz.onrender.com/mcp/<your-secret>` (note: the secret is part of the path, not a header — this is what makes the URL private).

Note: Render's free tier spins down after inactivity, so the first request after idling may take ~30s to wake up.

### Option B: Fly.io

```bash
fly launch --no-deploy   # answer prompts, don't add a database
fly secrets set CANVAS_BASE_URL=https://canvas.yourschool.edu CANVAS_API_TOKEN=your_token_here MCP_SHARED_SECRET=$(openssl rand -hex 32)
fly deploy
```
Your endpoint: `https://your-app-name.fly.dev/mcp/<your-secret>`

### Option C: Railway

1. https://railway.app → New Project → Deploy from GitHub repo (or "Empty Project" + upload).
2. Add variables `CANVAS_BASE_URL`, `CANVAS_API_TOKEN`, and `MCP_SHARED_SECRET` under the Variables tab.
3. Railway auto-detects `npm start`. Your endpoint: `https://your-app.up.railway.app/mcp/<your-secret>`

## 3. Connect it to Claude

1. In Claude, go to **Settings → Connectors** (or **Customize → Connectors**).
2. Click **Add custom connector**.
3. Paste your full `/mcp/<secret>` URL (e.g. `https://canvas-mcp-xyz.onrender.com/mcp/9f3a...`).
4. Leave OAuth fields blank — this server uses the secret baked into the URL, not per-user OAuth.
5. Click **Add**, then enable it for your conversation via the **+** button → **Connectors**.

## Security notes

- This server holds your Canvas token server-side, so treat the `/mcp/<secret>` URL like a password — anyone who has it can act as you (read-only) in Canvas.
- `MCP_SHARED_SECRET` is what makes the URL unguessable. Without it, `/mcp` is open to anyone who finds your deployment's public address. Always set it.
- The server only implements read (GET) endpoints — it can't post, submit, or modify anything in Canvas.
- Rotate your Canvas token any time from Canvas → Settings if you ever suspect it's exposed, and change `MCP_SHARED_SECRET` (and re-add the connector in Claude) if the URL leaks.

## Local testing

```bash
npm install
CANVAS_BASE_URL=https://canvas.yourschool.edu CANVAS_API_TOKEN=your_token MCP_SHARED_SECRET=devsecret npm start
```
Server listens on port 3000 (or `$PORT`) at `/mcp/devsecret` (or plain `/mcp` if you omit `MCP_SHARED_SECRET`).
