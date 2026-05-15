import type { TaskListResponse } from "../contracts.js";

const summary = requireElement<HTMLDivElement>("#summary");
const list = requireElement<HTMLUListElement>("#task-list");
const form = requireElement<HTMLFormElement>("#task-form");
const titleInput = requireElement<HTMLInputElement>("#task-title");
const priorityInput = requireElement<HTMLSelectElement>("#task-priority");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await fetch("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: titleInput.value, priority: priorityInput.value })
  });
  titleInput.value = "";
  await render();
});

await render();

async function render(): Promise<void> {
  const response = await fetch("/api/tasks");
  const data = (await response.json()) as TaskListResponse;
  summary.innerHTML = [
    metric("Total", data.summary.total),
    metric("Open", data.summary.open),
    metric("Completed", data.summary.completed),
    metric("High Priority Open", data.summary.highPriorityOpen)
  ].join("");
  list.innerHTML = data.tasks
    .map((task) => `<li><strong>${escapeHtml(task.title)}</strong> <span>${task.priority}</span> ${task.completed ? "done" : "open"}</li>`)
    .join("");
}

function metric(label: string, value: number): string {
  return `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}
