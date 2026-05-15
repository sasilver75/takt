import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TaskStore } from "./store.js";
import type { CreateTaskRequest } from "./contracts.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export function createToyServer(store = new TaskStore()): http.Server {
  return http.createServer(async (request, response) => {
    try {
      await route(request, response, store);
    } catch (error) {
      writeJson(response, 500, {
        error: {
          code: "internal_error",
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  });
}

export async function startToyServer(port = 0): Promise<{ server: http.Server; port: number }> {
  const server = createToyServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind to a TCP port");
  return { server, port: address.port };
}

async function route(request: IncomingMessage, response: ServerResponse, store: TaskStore): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderHtml());
    return;
  }
  if (request.method === "GET" && url.pathname === "/assets/app.js") {
    const app = await readFile(path.join(currentDir, "public", "app.js"), "utf8");
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    response.end(app);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/tasks") {
    writeJson(response, 200, store.list());
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/tasks") {
    const input = (await readJson(request)) as CreateTaskRequest;
    try {
      writeJson(response, 201, { task: store.create(input) });
    } catch (error) {
      writeJson(response, 400, {
        error: {
          code: "invalid_task",
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
    return;
  }
  writeJson(response, 404, { error: { code: "not_found", message: "Route not found" } });
}

function renderHtml(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Task Factory</title>
  <style>
    body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#f5f7f8;color:#162026}
    header{background:#18313a;color:white;padding:24px 32px}
    main{max-width:900px;margin:0 auto;padding:24px;display:grid;gap:18px}
    form,.panel{background:white;border:1px solid #d8e0e2;border-radius:8px;padding:16px}
    label{display:grid;gap:6px;font-weight:650}
    input,select,button{font:inherit;padding:10px;border:1px solid #b8c5c9;border-radius:6px}
    button{background:#12616f;color:white;border-color:#12616f;cursor:pointer}
    .summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
    .metric{background:#e9f0f2;padding:12px;border-radius:6px}
    .metric strong{display:block;font-size:26px}
    li{padding:8px 0;border-bottom:1px solid #edf1f2}
  </style>
</head>
<body>
  <header><h1>Task Factory</h1></header>
  <main>
    <section class="summary" id="summary"></section>
    <form id="task-form">
      <label>Task title<input id="task-title" name="title" required></label>
      <label>Priority<select id="task-priority" name="priority"><option>normal</option><option>high</option><option>low</option></select></label>
      <button type="submit">Add Task</button>
    </form>
    <section class="panel"><h2>Open Work</h2><ul id="task-list"></ul></section>
  </main>
  <script type="module" src="/assets/app.js"></script>
</body>
</html>`;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const { port: bound } = await startToyServer(port);
  process.stdout.write(`Task Factory listening on http://127.0.0.1:${bound}\n`);
}
