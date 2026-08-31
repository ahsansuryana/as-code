import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { withAudit } from '../audit.js';
import { registerProfileTool } from '../tool-registry.js';

export interface Task {
  id: string;
  title: string;
  details?: string;
  status: 'pending' | 'in_progress' | 'done';
  depends_on: string[];
  created_at: string;
  updated_at: string;
}

const tasks = new Map<string, Task>();
let taskCounter = 0;

export function registerTaskTools(server: McpServer): void {
  registerProfileTool(
    server,
    'task_create',
    'Add a task to the session checklist. Helps track multi-step work without losing context.',
    {
      title: z.string().min(1).describe('Task title/summary'),
      details: z.string().optional().describe('Detailed description or notes'),
      depends_on: z.array(z.string()).optional().describe('Array of task IDs this task depends on'),
    },
    async ({ title, details, depends_on }) => {
      return withAudit('task_create', { title }, async () => {
        const id = `task-${++taskCounter}`;
        const now = new Date().toISOString();
        const task: Task = {
          id,
          title,
          details,
          status: 'pending',
          depends_on: depends_on ?? [],
          created_at: now,
          updated_at: now,
        };
        tasks.set(id, task);
        return { content: [{ type: 'text' as const, text: `✅ Created task ${id}: ${title}` }] };
      });
    },
    { isWrite: false }
  );

  registerProfileTool(
    server,
    'task_update',
    'Update a task status or details, or delete it.',
    {
      id: z.string().describe('Task ID to update'),
      status: z.enum(['pending', 'in_progress', 'done']).optional().describe('New status'),
      details: z.string().optional().describe('Updated details'),
      delete: z.boolean().optional().describe('Set true to delete the task'),
    },
    async ({ id, status, details, delete: del }) => {
      return withAudit('task_update', { id, status }, async () => {
        if (del) {
          if (!tasks.has(id)) throw new Error(`Task not found: ${id}`);
          tasks.delete(id);
          return { content: [{ type: 'text' as const, text: `🗑️ Deleted task ${id}` }] };
        }

        const task = tasks.get(id);
        if (!task) throw new Error(`Task not found: ${id}`);

        if (status) task.status = status;
        if (details !== undefined) task.details = details;
        task.updated_at = new Date().toISOString();

        return { content: [{ type: 'text' as const, text: `✅ Updated ${id} → status: ${task.status}` }] };
      });
    },
    { isWrite: false }
  );

  registerProfileTool(
    server,
    'task_list',
    'List all tasks in the current session with their status.',
    {},
    async () => {
      return withAudit('task_list', {}, async () => {
        if (tasks.size === 0) {
          return { content: [{ type: 'text' as const, text: 'No tasks yet.' }] };
        }

        const statusIcon = (s: Task['status']) =>
          s === 'done' ? '✅' : s === 'in_progress' ? '🔄' : '⬜';

        const lines = [...tasks.values()].map(t => {
          const deps = t.depends_on.length > 0 ? ` (deps: ${t.depends_on.join(', ')})` : '';
          const detail = t.details ? `\n     ${t.details}` : '';
          return `${statusIcon(t.status)} ${t.id}: ${t.title}${deps}${detail}`;
        });

        return {
          content: [{ type: 'text' as const, text: `Session Tasks:\n\n${lines.join('\n')}` }],
        };
      });
    },
    { isWrite: false }
  );
}
