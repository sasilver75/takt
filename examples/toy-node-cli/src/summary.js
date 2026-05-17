export function parseTasks(input) {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [title, status = "open", priority = "normal"] = line.split(",").map((part) => part.trim());
      return { title, status, priority };
    });
}

export function summarizeTasks(tasks) {
  return {
    total: tasks.length,
    open: tasks.filter((task) => task.status !== "done").length,
    done: tasks.filter((task) => task.status === "done").length
  };
}

export function formatSummary(summary) {
  return [
    "total=" + summary.total,
    "open=" + summary.open,
    "done=" + summary.done
  ].join("\n");
}
