export type TaskPriority = "low" | "normal" | "high";

export type Task = {
  id: string;
  title: string;
  priority: TaskPriority;
  completed: boolean;
};

export type TaskListResponse = {
  tasks: Task[];
  summary: {
    total: number;
    completed: number;
    open: number;
    highPriorityOpen: number;
  };
};

export type CreateTaskRequest = {
  title: string;
  priority?: TaskPriority;
};
