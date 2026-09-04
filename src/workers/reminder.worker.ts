import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';

import { db } from '../core/db/drizzle.js';
import { enqueueNotification } from '../core/queues/notification.queue.js';
import { notifications, tasks } from '../core/db/schema/index.js';

/**
 * Produces the two scheduled notification types.
 *
 * Both `task_reminder` and `attendance_warning` existed as enum values and as
 * switches in the app's preferences screen, but nothing ever created one — the
 * toggles muted a category that never sent anything. This is the producer.
 *
 * A plain timer rather than a BullMQ queue, for the same reason as
 * `cleanup.worker.ts`: a Worker blocking on Redis around the clock to deliver a
 * handful of jobs a day costs more than the work. Both sweeps are idempotent —
 * they re-derive who is due from the database and skip anyone already told — so
 * two replicas running them concurrently is harmless.
 */

const RUN_EVERY_MS = 6 * 60 * 60 * 1000;
/** Let the process finish booting before the first sweep. */
const FIRST_RUN_DELAY_MS = 90_000;

/**
 * How long before a repeat warning about the same subject.
 *
 * Attendance moves slowly: without a cooldown, a subject sitting below its
 * threshold would produce a warning on every sweep until the user attended
 * enough classes to climb back, which is nagging rather than useful.
 */
const ATTENDANCE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD`, matching how Postgres renders a `date` column. */
function isoDay(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Whether the *server* should remind about this task.
 *
 * The device schedules an exact local notification for anything carrying a due
 * time, in the user's own timezone. The server has no timezone at all, so its
 * UTC-day sweep would fire up to a day off and could not know the device had
 * already notified. It therefore covers only what the device does not: one-off,
 * date-only tasks.
 *
 * Expressed as a plain function as well as SQL because Drizzle `where`
 * predicates are circular objects that cannot be asserted in tests — this is
 * what makes the policy checkable.
 */
export function serverShouldRemind(
  task: { seriesId: string | null; dueTime: string | null },
): boolean {
  return task.seriesId === null && task.dueTime === null;
}

/**
 * Reminds about pending tasks due today or tomorrow.
 *
 * Overdue tasks are deliberately excluded: the reminder is "this is coming up",
 * and a task left pending for weeks would otherwise generate a notification on
 * every sweep forever.
 *
 * Deduplicated on `metadata.task_id`, so a task is reminded about at most once
 * in its life. Moving a due date therefore does not earn a second reminder —
 * the alternative, keying on date as well, would notify again every time
 * someone rescheduled.
 *
 * Days are UTC. Users have no stored timezone, so a reminder can land up to a
 * day early or late at the extremes; worth revisiting when the schema carries
 * one.
 */
export async function sendTaskReminders(): Promise<number> {
  const due = await db
    .select({
      id: tasks.id, userId: tasks.userId, title: tasks.title, dueDate: tasks.dueDate,
      seriesId: tasks.seriesId, dueTime: tasks.dueTime,
    })
    .from(tasks)
    .where(and(
      eq(tasks.status, 'pending'),
      inArray(tasks.dueDate, [isoDay(0), isoDay(1)]),
      // Filtered in SQL so the sweep does not haul back every occurrence of
      // every habit, and again in JS so the policy is testable. See
      // `serverShouldRemind`.
      isNull(tasks.seriesId),
      isNull(tasks.dueTime),
    ))
    .then((rows) => rows.filter(serverShouldRemind));

  if (due.length === 0) return 0;

  // One query for the whole batch rather than a lookup per task.
  const alreadySent = await db
    .select({ taskId: sql<string>`${notifications.metadata}->>'task_id'` })
    .from(notifications)
    .where(and(
      eq(notifications.type, 'task_reminder'),
      inArray(sql`${notifications.metadata}->>'task_id'`, due.map((t) => t.id)),
    ));

  const sent = new Set(alreadySent.map((r) => r.taskId));
  const pending = due.filter((t) => !sent.has(t.id));

  for (const task of pending) {
    const dueToday = task.dueDate === isoDay(0);
    await enqueueNotification({
      userId: task.userId,
      type: 'task_reminder',
      title: dueToday ? 'Due today' : 'Due tomorrow',
      body: task.title,
      deepLink: '/tasks',
      metadata: { task_id: task.id },
    });
  }

  console.log(`[Reminders] Task reminders queued: ${pending.length} of ${due.length} due`);
  return pending.length;
}

/** One subject sitting below its attendance threshold. */
interface LowSubject {
  id: string;
  user_id: string;
  name: string;
  threshold_pct: number;
  attended_pct: number;
}

/**
 * Warns about subjects that have fallen below their attendance threshold.
 *
 * The percentage is computed in Postgres rather than by loading every session
 * row: a user with a full semester of subjects would otherwise pull thousands
 * of rows per sweep to derive a handful of numbers.
 *
 * Subjects with no sessions logged are skipped — 0 of 0 is not a shortfall.
 */
export async function sendAttendanceWarnings(): Promise<number> {
  const result = await db.execute(sql`
    SELECT s.id,
           s.user_id,
           s.name,
           s.threshold_pct,
           ROUND(
             100.0 * COUNT(a.id) FILTER (WHERE a.status = 'present') / COUNT(a.id)
           )::int AS attended_pct
      FROM subjects s
      JOIN attendance_sessions a ON a.subject_id = s.id
     GROUP BY s.id
    HAVING COUNT(a.id) > 0
       AND 100.0 * COUNT(a.id) FILTER (WHERE a.status = 'present') / COUNT(a.id)
           < s.threshold_pct
  `);

  // The postgres.js driver returns a RowList, which is already an array — no
  // `.rows` unwrapping as with node-postgres.
  const low = result as unknown as LowSubject[];
  if (low.length === 0) return 0;

  const recent = await db
    .select({ subjectId: sql<string>`${notifications.metadata}->>'subject_id'` })
    .from(notifications)
    .where(and(
      eq(notifications.type, 'attendance_warning'),
      gte(notifications.createdAt, new Date(Date.now() - ATTENDANCE_COOLDOWN_MS)),
      inArray(sql`${notifications.metadata}->>'subject_id'`, low.map((s) => s.id)),
    ));

  const cooling = new Set(recent.map((r) => r.subjectId));
  const toWarn = low.filter((s) => !cooling.has(s.id));

  for (const subject of toWarn) {
    await enqueueNotification({
      userId: subject.user_id,
      type: 'attendance_warning',
      title: `${subject.name} attendance is low`,
      body: `You are at ${subject.attended_pct}%, below your ${subject.threshold_pct}% target.`,
      deepLink: '/attendance',
      metadata: { subject_id: subject.id },
    });
  }

  console.log(
    `[Reminders] Attendance warnings queued: ${toWarn.length} ` +
      `(${low.length} below threshold, ${cooling.size} in cooldown)`,
  );
  return toWarn.length;
}

/** Runs both sweeps. One failing must not stop the other. */
export async function runReminderSweep(): Promise<void> {
  const results = await Promise.allSettled([sendTaskReminders(), sendAttendanceWarnings()]);
  for (const r of results) {
    if (r.status === 'rejected') {
      console.error('[Reminders] Sweep failed:', r.reason instanceof Error ? r.reason.message : r.reason);
    }
  }
}

let timer: NodeJS.Timeout | null = null;

export function startReminderSchedule(): void {
  const run = () => void runReminderSweep();

  setTimeout(run, FIRST_RUN_DELAY_MS).unref();
  timer = setInterval(run, RUN_EVERY_MS);
  // Do not hold the process open on this timer alone.
  timer.unref();
}

export function stopReminderSchedule(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
