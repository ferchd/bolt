import type { Database } from "@bolt/database";
import { abort, type HttpContext } from "@bolt/kernel";
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

const taskTitleSchema = v
  .string()
  .max(200)
  .transform((title) => title.trim())
  .refine((title) => title.length > 0, "Task title cannot be blank");

const createTaskSchema = v.object({
  completed: v.boolean().default(false),
  title: taskTitleSchema,
});

const updateTaskSchema = v
  .object({
    completed: v.boolean(),
    title: taskTitleSchema,
  })
  .partial();

export class TasksController {
  public constructor(private readonly database: Database) {}

  public index(context: HttpContext): { data: Task[] } {
    const filters = context.validate.query(taskListSchema);
    const rows = filters.completed === undefined
      ? this.database.query<TaskRow, []>(TASK_SELECT).all()
      : this.database
          .query<TaskRow, { completed: number }>(
            `${TASK_SELECT} WHERE completed = $completed`,
          )
          .all({ completed: filters.completed ? 1 : 0 });

    return { data: rows.map(toTask) };
  }

  public async store(context: HttpContext): Promise<Response> {
    const input = await context.validate.body(createTaskSchema);
    const result = this.database
      .query<unknown, { completed: number; title: string }>(
        "INSERT INTO tasks (title, completed) VALUES ($title, $completed)",
      )
      .run({ completed: input.completed ? 1 : 0, title: input.title });
    const task = this.find(Number(result.lastInsertRowid));

    context.logger.info("Task created", { taskId: task.id });

    return Response.json(task, {
      headers: { location: `/api/tasks/${task.id}` },
      status: 201,
    });
  }

  public show(context: HttpContext): Task {
    const { id } = context.validate.params(taskIdSchema);
    return this.find(id);
  }

  public async update(context: HttpContext): Promise<Task> {
    const { id } = context.validate.params(taskIdSchema);
    const input = await context.validate.body(updateTaskSchema);

    if (input.completed === undefined && input.title === undefined) {
      abort(422, "At least one task field is required", {
        code: "VALIDATION_ERROR",
      });
    }

    const result = this.database
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
        title: input.title ?? null,
      });

    if (result.changes === 0) {
      taskNotFound(id);
    }

    return this.find(id);
  }

  public destroy(context: HttpContext): Response {
    const { id } = context.validate.params(taskIdSchema);
    const result = this.database
      .query<unknown, { id: number }>(
        "DELETE FROM tasks WHERE id = $id",
      )
      .run({ id });

    if (result.changes === 0) {
      taskNotFound(id);
    }

    return new Response(null, { status: 204 });
  }

  private find(id: number): Task {
    const row = this.database
      .query<TaskRow, { id: number }>(`${TASK_SELECT} WHERE id = $id`)
      .get({ id });

    if (!row) {
      taskNotFound(id);
    }

    return toTask(row);
  }
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
