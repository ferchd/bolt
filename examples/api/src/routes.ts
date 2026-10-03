import type { Database } from "@bolt/database";
import { abort } from "@bolt/kernel";
import type { Router } from "@bolt/router";
import v from "@bolt/validation";

interface TaskRow {
  readonly completed: number;
  readonly createdAt: string;
  readonly id: number;
  readonly title: string;
  readonly updatedAt: string;
}

interface Task {
  readonly completed: boolean;
  readonly createdAt: string;
  readonly id: number;
  readonly title: string;
  readonly updatedAt: string;
}

const taskIdSchema = v.object({
  id: v.number().integer().min(1),
});

const taskListSchema = v.object({
  completed: v.boolean().optional(),
});

const createTaskSchema = v.object({
  title: v.string().min(1).max(200),
});

const updateTaskSchema = v.object({
  completed: v.boolean().optional(),
  title: v.string().min(1).max(200).optional(),
});

export function registerRoutes(
  router: Router,
  database: Database,
  applicationName: string,
): void {
  router.get("/health", () => {
    const result = database
      .query<{ alive: number }, []>("SELECT 1 AS alive")
      .get();

    return {
      application: applicationName,
      database: result?.alive === 1 ? "up" : "down",
      status: "ok",
    };
  }).as("health");

  router
    .group(() => {
      router.get("/", (context) => {
        const filters = context.validate.query(taskListSchema);
        const rows = filters.completed === undefined
          ? database.query<TaskRow, []>(TASK_SELECT).all()
          : database
              .query<TaskRow, { completed: number }>(
                `${TASK_SELECT} WHERE completed = $completed`,
              )
              .all({ completed: filters.completed ? 1 : 0 });

        return { data: rows.map(toTask) };
      }).as("index");

      router.post("/", async (context) => {
        const input = await context.validate.body(createTaskSchema);
        const title = normalizeTitle(input.title);
        const result = database
          .query<unknown, { title: string }>(
            "INSERT INTO tasks (title) VALUES ($title)",
          )
          .run({ title });
        const task = findTask(database, Number(result.lastInsertRowid));

        return Response.json(task, {
          headers: { location: `/api/tasks/${task.id}` },
          status: 201,
        });
      }).as("store");

      router.get("/:id", (context) => {
        const { id } = context.validate.params(taskIdSchema);
        return findTask(database, id);
      }).as("show");

      router.patch("/:id", async (context) => {
        const { id } = context.validate.params(taskIdSchema);
        const input = await context.validate.body(updateTaskSchema);

        if (input.completed === undefined && input.title === undefined) {
          abort(422, "At least one task field is required", {
            code: "VALIDATION_ERROR",
          });
        }

        const result = database
          .query<
            unknown,
            {
              completed: null | number;
              id: number;
              title: null | string;
            }
          >(
            `UPDATE tasks
             SET title = COALESCE($title, title),
                 completed = COALESCE($completed, completed),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $id`,
          )
          .run({
            completed:
              input.completed === undefined ? null : input.completed ? 1 : 0,
            id,
            title:
              input.title === undefined ? null : normalizeTitle(input.title),
          });

        if (result.changes === 0) {
          taskNotFound(id);
        }

        return findTask(database, id);
      }).as("update");

      router.delete("/:id", (context) => {
        const { id } = context.validate.params(taskIdSchema);
        const result = database
          .query<unknown, { id: number }>(
            "DELETE FROM tasks WHERE id = $id",
          )
          .run({ id });

        if (result.changes === 0) {
          taskNotFound(id);
        }

        return new Response(null, { status: 204 });
      }).as("destroy");
    })
    .prefix("/api/tasks")
    .as("tasks");
}

const TASK_SELECT = `
  SELECT
    id,
    title,
    completed,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM tasks
`;

function findTask(database: Database, id: number): Task {
  const row = database
    .query<TaskRow, { id: number }>(`${TASK_SELECT} WHERE id = $id`)
    .get({ id });

  if (!row) {
    taskNotFound(id);
  }

  return toTask(row);
}

function normalizeTitle(title: string): string {
  const normalized = title.trim();

  if (normalized.length === 0) {
    abort(422, "Task title cannot be blank", {
      code: "VALIDATION_ERROR",
    });
  }

  return normalized;
}

function taskNotFound(id: number): never {
  abort(404, `Task ${id} was not found`, { code: "TASK_NOT_FOUND" });
}

function toTask(row: TaskRow): Task {
  return {
    completed: row.completed === 1,
    createdAt: row.createdAt,
    id: row.id,
    title: row.title,
    updatedAt: row.updatedAt,
  };
}
