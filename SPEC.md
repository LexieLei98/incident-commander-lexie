# To-Do App

## Value Proposition
Manage to-do tasks through conversation. Target: anyone wanting quick, conversational task management. Pain: switching between apps, manual list management, losing context.

**Core actions**: Add tasks, view/manage tasks (toggle complete, delete), organize by priority and due date.

## Why LLM?
**Conversational win**: "Add buy groceries, high priority, due Friday" = one sentence vs. multiple form fields.
**LLM adds**: Natural language task creation, prioritization advice, context-aware suggestions.
**What LLM lacks**: Persistent storage (Supabase), user identity (Supabase OAuth).

## UI Overview
**First view**: User's task list showing pending and completed items, sorted by priority/due date.
**Key interactions**: Check/uncheck tasks, delete tasks, add tasks inline or via conversation.
**End state**: Updated task list persisted in Supabase.

## Product Context
- **Database**: Supabase (PostgreSQL)
- **Auth**: Supabase OAuth
- **Constraints**: Tasks are per-user, authenticated access only

## UX Flows

Manage tasks:
1. View task list (pending + completed)
2. Toggle task completion
3. Delete tasks
4. Add new tasks
5. Any combination of the above in a single call

## Tools and Widgets

**Widget: manage-tasks**
- **Input**: `{ actions?: Array<{ type: "add" | "delete" | "toggle", title?: string, priority?: "low" | "medium" | "high", dueDate?: string, taskId?: string }> }`
- **Output**: `{ tasks[] }` (each: id, title, completed, priority, dueDate, createdAt)
- **Views**: task list with inline actions (toggle, delete, add form)
- **Behavior**:
  - No actions / empty array → fetch and display tasks
  - Execute all actions in order, then return updated task list
  - Every call always renders the full task list UI
