import { Notification } from 'electron';
import { ScheduleEntry } from '../storage/scheduleStore';

/** JS's Date.getDay() is 0=Sunday..6=Saturday - schedule entries use 0=Monday..6=Sunday (matches a Russian weekly timetable). */
function mondayFirstDayOf(date: Date): number {
  return (date.getDay() + 6) % 7;
}

function occursOn(entry: ScheduleEntry, now: Date): boolean {
  if (entry.type === 'weekly') return entry.dayOfWeek === mondayFirstDayOf(now);
  return entry.date === now.toISOString().slice(0, 10);
}

function startTimeToday(entry: ScheduleEntry, now: Date): Date {
  const [hours, minutes] = entry.startTime.split(':').map(Number);
  const start = new Date(now);
  start.setHours(hours, minutes, 0, 0);
  return start;
}

let timer: ReturnType<typeof setInterval> | null = null;
let notifiedKeys = new Set<string>();
const CHECK_INTERVAL_MS = 20_000;

/** Polls the schedule and fires a Notification once per entry per day, right at its notify-before moment. */
export function startScheduleNotifier(getEntries: () => ScheduleEntry[], onClick: () => void): void {
  if (timer) return;
  timer = setInterval(() => {
    if (!Notification.isSupported()) return;
    const now = new Date();
    const todayKey = now.toISOString().slice(0, 10);

    for (const entry of getEntries()) {
      if (!occursOn(entry, now)) continue;
      const key = `${entry.id}|${todayKey}`;
      if (notifiedKeys.has(key)) continue;

      const start = startTimeToday(entry, now);
      const notifyAt = new Date(start.getTime() - entry.notifyMinutesBefore * 60_000);
      const msSinceNotifyAt = now.getTime() - notifyAt.getTime();
      if (msSinceNotifyAt < 0 || msSinceNotifyAt >= CHECK_INTERVAL_MS) continue;

      notifiedKeys.add(key);
      const whenLabel = entry.notifyMinutesBefore === 0 ? 'Начинается сейчас' : `Через ${entry.notifyMinutesBefore} мин`;
      const bodyParts = [`${whenLabel} · ${entry.startTime}`, entry.location, entry.teacher].filter(Boolean);
      const notification = new Notification({ title: entry.title, body: bodyParts.join(' · ') });
      notification.on('click', onClick);
      notification.show();
    }

    // Dangling keys from days gone by are harmless but pointless to keep -
    // this only ever holds today's (and briefly yesterday's) entries.
    if (notifiedKeys.size > 500) notifiedKeys = new Set([...notifiedKeys].filter((k) => k.endsWith(todayKey)));
  }, CHECK_INTERVAL_MS);
}

export function stopScheduleNotifier(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
