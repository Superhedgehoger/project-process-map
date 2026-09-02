import type { FileAdapter, FileReference, Task, TaskAdapter } from "./ports.ts";

export class InMemoryTaskAdapter implements TaskAdapter {
  readonly #tasks = new Map<string, Task>();

  async health(): Promise<"ok"> {
    return "ok";
  }

  async create(task: Omit<Task, "version">): Promise<Task> {
    if (this.#tasks.has(task.id)) throw new Error(`Task already exists: ${task.id}`);
    const created = { ...task, version: 1 };
    this.#tasks.set(created.id, structuredClone(created));
    return structuredClone(created);
  }

  async get(id: string): Promise<Task | undefined> {
    const task = this.#tasks.get(id);
    return task ? structuredClone(task) : undefined;
  }
}

export class InMemoryFileAdapter implements FileAdapter {
  readonly #files = new Map<string, FileReference>();

  async health(): Promise<"ok"> {
    return "ok";
  }

  async attach(file: FileReference): Promise<FileReference> {
    if (this.#files.has(file.id)) throw new Error(`File already exists: ${file.id}`);
    this.#files.set(file.id, structuredClone(file));
    return structuredClone(file);
  }

  async get(id: string): Promise<FileReference | undefined> {
    const file = this.#files.get(id);
    return file ? structuredClone(file) : undefined;
  }
}

