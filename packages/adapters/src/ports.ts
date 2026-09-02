export type TaskStatus = "todo" | "in_progress" | "submitted" | "completed";

export type Task = {
  id: string;
  nodeId: string;
  title: string;
  status: TaskStatus;
  version: number;
};

export type FileReference = {
  id: string;
  nodeId: string;
  name: string;
  contentType: string;
};

export interface TaskAdapter {
  health(): Promise<"ok" | "degraded">;
  create(task: Omit<Task, "version">): Promise<Task>;
  get(id: string): Promise<Task | undefined>;
}

export interface FileAdapter {
  health(): Promise<"ok" | "degraded">;
  attach(file: FileReference): Promise<FileReference>;
  get(id: string): Promise<FileReference | undefined>;
}

