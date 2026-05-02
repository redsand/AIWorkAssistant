export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority: "high" | "medium" | "low";
  result?: string;
  startedAt?: Date;
  completedAt?: Date;
  subtaskJobId?: string;
}

export interface TodoList {
  id: string;
  title: string;
  items: TodoItem[];
  createdAt: Date;
  updatedAt: Date;
  sessionId?: string;
}

class TodoManager {
  private lists: Map<string, TodoList> = new Map();

  createList(title: string, sessionId?: string): TodoList {
    const id = `todo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const list: TodoList = {
      id,
      title,
      items: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      sessionId,
    };
    this.lists.set(id, list);
    return list;
  }

  getList(listId: string): TodoList | undefined {
    return this.lists.get(listId);
  }

  getLists(sessionId?: string): TodoList[] {
    const all = Array.from(this.lists.values());
    if (sessionId) {
      return all.filter((l) => l.sessionId === sessionId);
    }
    return all;
  }

  addItems(
    listId: string,
    items: Array<{
      content: string;
      priority?: "high" | "medium" | "low";
    }>,
  ): TodoList | null {
    const list = this.lists.get(listId);
    if (!list) return null;

    for (const item of items) {
      const id = `item-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      list.items.push({
        id,
        content: item.content,
        status: "pending",
        priority: item.priority || "medium",
      });
    }

    list.updatedAt = new Date();
    return list;
  }

  updateItem(
    listId: string,
    itemId: string,
    updates: Partial<
      Pick<
        TodoItem,
        "status" | "priority" | "content" | "result" | "subtaskJobId"
      >
    >,
  ): TodoItem | null {
    const list = this.lists.get(listId);
    if (!list) return null;

    const item = list.items.find((i) => i.id === itemId);
    if (!item) return null;

    if (updates.status !== undefined) {
      item.status = updates.status;
      if (updates.status === "in_progress") {
        item.startedAt = new Date();
      }
      if (updates.status === "completed" || updates.status === "cancelled") {
        item.completedAt = new Date();
      }
    }
    if (updates.priority !== undefined) item.priority = updates.priority;
    if (updates.content !== undefined) item.content = updates.content;
    if (updates.result !== undefined) item.result = updates.result;
    if (updates.subtaskJobId !== undefined)
      item.subtaskJobId = updates.subtaskJobId;

    list.updatedAt = new Date();
    return item;
  }

  getNextPending(listId: string): TodoItem | null {
    const list = this.lists.get(listId);
    if (!list) return null;
    return list.items.find((i) => i.status === "pending") || null;
  }

  getProgress(listId: string): {
    total: number;
    pending: number;
    inProgress: number;
    completed: number;
    cancelled: number;
  } | null {
    const list = this.lists.get(listId);
    if (!list) return null;

    return {
      total: list.items.length,
      pending: list.items.filter((i) => i.status === "pending").length,
      inProgress: list.items.filter((i) => i.status === "in_progress").length,
      completed: list.items.filter((i) => i.status === "completed").length,
      cancelled: list.items.filter((i) => i.status === "cancelled").length,
    };
  }

  deleteList(listId: string): boolean {
    return this.lists.delete(listId);
  }

  clearCompleted(listId: string): boolean {
    const list = this.lists.get(listId);
    if (!list) return false;
    list.items = list.items.filter(
      (i) => i.status !== "completed" && i.status !== "cancelled",
    );
    list.updatedAt = new Date();
    return true;
  }
}

export const todoManager = new TodoManager();
