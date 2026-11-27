import { z } from 'zod';
import { dueInputSchema, getTaskDetails, optionSchema, ownerSchema, resolveTaskDue, workTaskView, type TaskDetails, type TaskState } from './coordinator-desk.ts';

export const workTaskEditShape = {
  title: z.string().max(240).optional(),
  doneWhen: z.string().max(1000).optional(),
  kind: z.enum(['action', 'decision']).optional(),
  owner: ownerSchema.optional(),
  state: z.enum(['todo', 'working', 'waiting', 'postponed', 'ready_to_close', 'done']).optional(),
  now: z.string().max(1000).nullish(),
  due: dueInputSchema.nullish(),
  workItemId: z.string().max(100).nullish(),
  parentTaskId: z.string().max(100).nullish(),
  decisionOptions: z.array(optionSchema).max(4).nullish(),
  recommendation: z.string().max(1000).nullish().describe('For a decision, use the label of the option you recommend.'),
};
const editSchema = z.object(workTaskEditShape);
export type WorkTaskEdit = z.input<typeof editSchema>;

export function workTaskEdit(input: WorkTaskEdit, now: number, previous?: Parameters<typeof getTaskDetails>[0]): { work: TaskDetails; state: TaskState; title?: string } {
  const edit = editSchema.parse(input);
  const old = previous && getTaskDetails(previous);
  const kind = edit.kind ?? old?.kind ?? 'action';
  if (kind === 'action' && (edit.decisionOptions !== undefined || edit.recommendation !== undefined)) {
    throw new Error('Set kind to decision before adding options or a recommendation.');
  }
  const state = edit.state ?? (previous ? workTaskView(previous, '').state : 'todo');
  const parentTaskId = edit.parentTaskId === undefined ? old?.parentTaskId : edit.parentTaskId ?? undefined;
  const workItemId = parentTaskId ? undefined : edit.workItemId === undefined ? old?.workItemId : edit.workItemId ?? undefined;
  const due = edit.due === undefined ? old?.due : edit.due === null ? undefined : resolveTaskDue(edit.due, now);
  const common = {
    owner: edit.owner ?? old?.owner ?? { kind: kind === 'decision' ? 'user' as const : 'agent' as const },
    now: edit.now === undefined ? old?.now : edit.now ?? undefined,
    doneWhen: edit.doneWhen ?? old?.doneWhen,
    source: old?.source,
    due,
    workItemId,
    parentTaskId,
    state: state === 'postponed' ? 'postponed' as const : undefined,
    openState: old?.openState,
  };
  if (kind === 'action') return { work: { ...common, kind }, state, title: edit.title };
  const decision = old?.kind === 'decision' ? old.decision : undefined;
  return {
    work: {
      ...common, kind, decision: {
        options: edit.decisionOptions === undefined ? decision?.options : edit.decisionOptions ?? undefined,
        recommendation: edit.recommendation === undefined ? decision?.recommendation : edit.recommendation ?? undefined,
        answer: decision?.answer,
      },
    },
    state, title: edit.title,
  };
}
