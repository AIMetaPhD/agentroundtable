'use strict';
/*
 * Explicit state vocabulary and transition guards.
 *
 * Before this module the app inferred state from booleans, free-form strings
 * and in-memory flags. Every transition below is now named, and illegal
 * transitions throw instead of silently producing combinations such as
 * ended=true/paused=false or approval status "consumed" moving back to "active".
 */

const ROOM = Object.freeze({ ACTIVE: 'active', PAUSED: 'paused', ENDED: 'ended' });
const PARTICIPANT = Object.freeze({ IDLE: 'idle', PROCESSING: 'processing', ERROR: 'error', UNKNOWN: 'unknown', DISABLED: 'disabled' });
const APPROVAL = Object.freeze({ ACTIVE: 'active', CONSUMED: 'consumed', REVOKED: 'revoked', INVALIDATED: 'invalidated', EXPIRED: 'expired' });
const TASK = Object.freeze({ QUEUED: 'queued', RUNNING: 'running', COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled', ORPHANED: 'orphaned' });
const JOB = Object.freeze({ QUEUED: 'queued', RUNNING: 'running', DONE: 'done', FAILED: 'failed', CANCELLED: 'cancelled', INTERRUPTED: 'interrupted' });
const MESSAGE = Object.freeze({ PROCESSING: 'processing', COMPLETE: 'complete', FAILED: 'failed', CANCELLED: 'cancelled' });

function roomFromRow(row) {
  if (!row) return ROOM.ACTIVE;
  if (row.state && Object.values(ROOM).includes(row.state)) return row.state;
  if (row.ended) return ROOM.ENDED;
  if (row.paused) return ROOM.PAUSED;
  return ROOM.ACTIVE;
}

const ROOM_EVENTS = {
  [ROOM.ACTIVE]: { pause: ROOM.PAUSED, end: ROOM.ENDED },
  [ROOM.PAUSED]: { resume: ROOM.ACTIVE, end: ROOM.ENDED },
  [ROOM.ENDED]: { end: ROOM.ENDED },
};

function nextRoom(from, event) {
  const next = (ROOM_EVENTS[from] || {})[event];
  if (!next) throw new Error(`illegal room transition: ${from} --${event}-->`);
  return next;
}

const APPROVAL_EVENTS = {
  [APPROVAL.ACTIVE]: {
    consume: APPROVAL.CONSUMED,
    revoke: APPROVAL.REVOKED,
    invalidate: APPROVAL.INVALIDATED,
    expire: APPROVAL.EXPIRED,
  },
  [APPROVAL.CONSUMED]: {},
  [APPROVAL.REVOKED]: {},
  [APPROVAL.INVALIDATED]: {},
  [APPROVAL.EXPIRED]: {},
};

function nextApproval(from, event) {
  const next = (APPROVAL_EVENTS[from] || {})[event];
  if (!next) throw new Error(`illegal approval transition: ${from} --${event}-->`);
  return next;
}

const TASK_EVENTS = {
  [TASK.QUEUED]: { start: TASK.RUNNING, cancel: TASK.CANCELLED, orphan: TASK.ORPHANED },
  [TASK.RUNNING]: { complete: TASK.COMPLETED, fail: TASK.FAILED, cancel: TASK.CANCELLED, orphan: TASK.ORPHANED },
  [TASK.COMPLETED]: {},
  [TASK.FAILED]: {},
  [TASK.CANCELLED]: {},
  [TASK.ORPHANED]: {},
};

function nextTask(from, event) {
  const next = (TASK_EVENTS[from] || {})[event];
  if (!next) throw new Error(`illegal task transition: ${from} --${event}-->`);
  return next;
}

const JOB_EVENTS = {
  [JOB.QUEUED]: { start: JOB.RUNNING, cancel: JOB.CANCELLED },
  [JOB.RUNNING]: { complete: JOB.DONE, fail: JOB.FAILED, cancel: JOB.CANCELLED, pause: JOB.QUEUED, interrupt: JOB.INTERRUPTED },
  [JOB.DONE]: {},
  [JOB.FAILED]: {},
  [JOB.CANCELLED]: {},
  [JOB.INTERRUPTED]: { requeue: JOB.QUEUED },
};

function nextJob(from, event) {
  const next = (JOB_EVENTS[from] || {})[event];
  if (!next) throw new Error(`illegal job transition: ${from} --${event}-->`);
  return next;
}

function isTerminalTask(state) {
  return [TASK.COMPLETED, TASK.FAILED, TASK.CANCELLED, TASK.ORPHANED].includes(state);
}

module.exports = {
  ROOM, PARTICIPANT, APPROVAL, TASK, JOB, MESSAGE,
  roomFromRow, nextRoom, nextApproval, nextTask, nextJob, isTerminalTask,
};
