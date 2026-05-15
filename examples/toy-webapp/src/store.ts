import type { CreateTaskRequest, Task, TaskListResponse, TaskPriority } from "./contracts.js";

const priorities = new Set<TaskPriority>(["low", "normal", "high"]);

export class TaskStore {
  private nextId = 4;
  private readonly tasks: Task[] = [
    { id: "task-1", title: "Confirm API telemetry", priority: "high", completed: false },
    { id: "task-2", title: "Polish dashboard copy", priority: "normal", completed: false },
    { id: "task-3", title: "Ship smoke tests", priority: "high", completed: true }
  ];

  list(): TaskListResponse {
    const completed = this.tasks.filter((task) => task.completed).length;
    const highPriorityOpen = this.tasks.filter((task) => task.priority === "high" && !task.completed).length;
    return {
      tasks: [...this.tasks],
      summary: {
        total: this.tasks.length,
        completed,
        open: this.tasks.length - completed,
        highPriorityOpen
      }
    };
  }

  create(input: CreateTaskRequest): Task {
    const title = input.title.trim();
    if (!title) throw new Error("Task title is required");
    const priority = input.priority ?? "normal";
    if (!priorities.has(priority)) throw new Error(`Unsupported priority: ${priority}`);
    const task: Task = {
      id: `task-${this.nextId}`,
      title,
      priority,
      completed: false
    };
    this.nextId += 1;
    this.tasks.push(task);
    return task;
  }
}
