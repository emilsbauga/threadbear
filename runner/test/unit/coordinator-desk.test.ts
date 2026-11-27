import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardView, coordinatorView, hasRemovedDesk, migrateCoordinatorHistoryEntry, migrateCoordinatorRegistry, resolveTaskDue, validateTaskBoard } from '../../src/coordinator-desk.ts';

// Synthetic rows recreate all four live desk shapes. Identifiers, text, paths,
// dates and seqs are invented. The source copies stay outside the repo.
const stamp = '2026-11-20T01:00:00.000Z';
const wakeAt = '2026-11-30T09:00:00.000Z';
const shapes = [
  { tasks: 4, loops: [3, 2, 1, 2, 1], run: true, archives: 6 },
  { tasks: 6, loops: [1, 8, 0, 0, 7], run: true, archives: 9 },
  { tasks: 2, loops: [2, 9, 0, 2, 3], run: false, archives: 6 },
  { tasks: 13, loops: [0, 16, 0, 0, 3], run: false, archives: 11 },
] as const;
const kinds = ['waiting_on_user', 'waiting_on_user', 'user_question', 'user_question', 'user_question'];
const states = ['open', 'closed', 'open', 'answered', 'closed'];

const legacyDesks = shapes.map((shape, i) => {
  const projectId = 'project-' + i;
  const run = { id: 'run-' + i, agentId: 'agent-' + i, helperThreadId: 'helper-' + i,
    nativeRunId: 'native-' + i, status: 'running', brief: 'Private brief', updatedAt: stamp,
    ...(i === 1 ? { summary: 'Checking a result' } : {}) };
  return {
    projectId, threadId: 'thread-' + i, state: 'active', charter: 'Keep the project moving',
    interests: ['progress'], updatedAt: stamp, questions: [],
    seen: Array.from({ length: [188, 17, 0, 2][i]! }, (_, j) => 'seen-' + j),
    events: i === 0 ? [{ key: 'event-1', text: 'A saved event' }] : [],
    ...(i === 0 ? { reports: [{ id: 'report-1', at: stamp, sentAs: 'turn-1', text: 'A saved report' }] } : {}),
    ...(i === 3 ? { wakeAt } : {}),
    tasks: Array.from({ length: shape.tasks }, (_, j) => ({
      id: projectId + '-task-' + j, title: 'Check item ' + j, doneWhen: 'The item was checked',
      ...(j === 0 && shape.run ? { run, state: 'working' } : { state: 'todo' }),
    })),
    loops: shape.loops.flatMap((n, j) => Array.from({ length: n }, (_, k) => ({
      id: projectId + '-loop-' + j + '-' + k, title: 'Loop ' + j + '/' + k,
      kind: kinds[j], state: states[j], createdAt: stamp, updatedAt: stamp,
      ...(states[j] === 'closed' ? { closedAt: stamp } : {}),
      ...(j < 2 ? { options: ['Choose A', 'Choose B'] } : {}),
      ...(k % 2 ? { sourceSeq: 100 + k } : {}),
      ...(k % 3 ? { summary: 'Saved context' } : {}),
    }))),
  };
});

test('all four stored desk shapes migrate idempotently and retain each legacy field', () => {
  const migrated = migrateCoordinatorRegistry(legacyDesks);
  assert.deepEqual(migrateCoordinatorRegistry(JSON.parse(JSON.stringify(migrated))), migrated);
  assert.deepEqual(migrated.map((r) => [r.tasks.length, r.loops.length, boardView(r).tasks.length]), [
    [4, 9, 13], [6, 16, 22], [2, 16, 18], [13, 19, 32],
  ]);
  for (const [index, row] of migrated.entries()) {
    const old = legacyDesks[index]!;
    const { workItems, retiredLoops, tasks, loops, ...registry } = row;
    assert.deepEqual({ ...registry, tasks: tasks.map(({ work, ...t }) => t), loops: loops.map(({ work, ...l }) => l) }, old);
    assert.deepEqual(workItems, []);
    assert.deepEqual(retiredLoops, []);
    const board = boardView(row);
    for (const loop of old.loops) {
      const task = board.tasks.find((t) => t.id === loop.id)!;
      assert.equal(task.kind, loop.kind === 'waiting_on_user' ? 'decision' : 'action');
      assert.equal(task.owner.kind, loop.kind === 'waiting_on_user' ? 'user' : 'agent');
      assert.equal(task.state, loop.state === 'closed' ? 'done' : loop.state === 'answered' ? 'ready_to_close' : 'todo');
      assert.equal(task.now, loop.summary);
      assert.equal(task.closedAt, loop.closedAt);
      assert.equal(task.source?.seq, loop.sourceSeq);
      assert.deepEqual(task.decision?.options, loop.options?.map((label) => ({ label })));
    }
    assert.ok(board.tasks.every((task) => !('run' in task)));
  }
});

test('the history adapter preserves 32 archives, one drop and one removed coordinator', () => {
  const history = legacyDesks.flatMap((desk, i) => [
    ...Array.from({ length: shapes[i]!.archives }, (_, j) => ({
      projectId: desk.projectId, task: { ...desk.tasks[j % desk.tasks.length], id: 'saved-' + i + '-' + j, state: 'done' },
      questions: [{ id: 'old-question', agentId: 'helper', state: 'answered', questions: [{ question: 'Which one?' }], answer: 'A' }],
      archivedAt: stamp,
    })),
    ...(i === 3 ? [{ projectId: desk.projectId, task: desk.tasks[0], questions: [], droppedAt: stamp, reason: 'No longer needed' }] : []),
  ]);
  const removed = {
    coordinator: {
      ...legacyDesks[2], projectId: 'removed-project', threadId: 'removed-thread',
      loops: [], tasks: [legacyDesks[2]!.tasks[0]],
    },
    removedAt: stamp,
  };
  const migrated = [...history, removed].map(migrateCoordinatorHistoryEntry);
  assert.equal(migrated.length, 34);
  assert.deepEqual(migrated.map(migrateCoordinatorHistoryEntry), migrated);
  for (const [i, row] of migrated.entries()) {
    if (hasRemovedDesk(row)) {
      assert.equal(row.removedAt, stamp);
      assert.equal(boardView(row.coordinator).tasks.length, 1);
    } else {
      const { task: { work, ...task }, ...fields } = row;
      assert.deepEqual({ ...fields, task }, history[i]);
    }
  }
  assert.equal(migrated.filter((r) => 'archivedAt' in r).length, 32);
  assert.equal(migrated.filter((r) => 'droppedAt' in r).length, 1);
});

test('task validation rejects unknown groups, nested subtasks, and dependency cycles', () => {
  const [row] = migrateCoordinatorRegistry(legacyDesks);
  const [grandparent, parent, child] = row!.tasks;
  parent!.work = { kind: 'action', owner: { kind: 'agent' }, parentTaskId: grandparent!.id };
  child!.work = { kind: 'action', owner: { kind: 'agent' }, parentTaskId: parent!.id };
  assert.match(validateTaskBoard(row!)!, /one level/i);
  assert.throws(() => migrateCoordinatorRegistry(JSON.parse(JSON.stringify([row]))), /one level/i);
  child!.work = { kind: 'action', owner: { kind: 'agent' }, workItemId: 'missing' };
  assert.match(validateTaskBoard(row!)!, /work item/i);
  child!.work = { kind: 'action', owner: { kind: 'agent' }, state: 'postponed', due: { type: 'after_task', taskId: parent!.id } };
  parent!.work = { kind: 'action', owner: { kind: 'agent' }, state: 'postponed', due: { type: 'after_task', taskId: child!.id } };
  assert.match(validateTaskBoard(row!)!, /cycle/i);
});

test('due presets resolve to a stored absolute time and reject invalid calendar dates', () => {
  const now = new Date(2026, 10, 26, 14).getTime();
  const expected = new Date(2026, 10, 27, 9).toISOString();
  assert.deepEqual(resolveTaskDue({ type: 'tomorrow' }, now), { type: 'at', at: expected, preset: 'tomorrow' });
  assert.deepEqual(resolveTaskDue({ type: 'date', date: '2026-11-27' }, now), { type: 'at', at: expected, preset: 'date' });
  assert.throws(() => resolveTaskDue({ type: 'date', date: '2026-02-30' }, now));
  assert.throws(() => resolveTaskDue({ type: 'at', at: 'November', preset: 'tomorrow' }, now));
  assert.throws(() => migrateCoordinatorRegistry([{ ...legacyDesks[0], tasks: [
    { ...legacyDesks[0]!.tasks[0], work: { kind: 'decision', owner: { kind: 'person', name: ' ' } } },
  ] }]));
});

test('later legacy fields survive storage without spilling into either client view', () => {
  const original = structuredClone(legacyDesks[0]!);
  const [task, ...otherTasks] = original.tasks;
  const [loop, ...otherLoops] = original.loops;
  assert.ok(task && 'run' in task);
  const [stored] = migrateCoordinatorRegistry([{
    ...original, privateRevision: 12,
    tasks: [{ ...task, privateNote: 'Registry only', run: { ...task.run, privateCursor: 21 } }, ...otherTasks],
    loops: [{ ...loop, privateNote: 'Registry only' }, ...otherLoops],
  }]);
  assert.equal(stored!.privateRevision, 12);
  assert.equal(Reflect.get(stored!.tasks[0]!, 'privateNote'), 'Registry only');
  assert.equal(stored!.tasks[0]!.run?.privateCursor, 21);
  assert.equal(stored!.loops[0]!.privateNote, 'Registry only');
  const wire = JSON.stringify(coordinatorView(stored!));
  assert.doesNotMatch(wire, /privateRevision|privateNote|privateCursor|Private brief/);
});

test('stored legacy loops must remain top-level task board entries', () => {
  const [row] = migrateCoordinatorRegistry(legacyDesks);
  for (const kind of ['user_question', 'waiting_on_user']) {
    const loop = row!.loops.find((l) => l.kind === kind)!;
    const work = loop.work!;
    loop.work = { ...work, parentTaskId: row!.tasks[0]!.id };
    assert.throws(() => migrateCoordinatorRegistry(JSON.parse(JSON.stringify([row]))), /legacy loop cannot be a sub-task/i);
    loop.work = work;
  }
});
