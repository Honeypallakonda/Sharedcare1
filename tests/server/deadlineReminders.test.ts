import { describe, it, expect, vi } from 'vitest';

// The scheduler imports the DB pool and the notification sender; the logic under
// test here is pure, so both are stubbed.
vi.mock('../../server/src/db', () => ({ query: vi.fn() }));
vi.mock('../../server/src/lib/notifications', () => ({ createNotification: vi.fn() }));

import {
    loadReminderConfig,
    taskDeadline,
    reachedStages,
    latestReminderStage,
} from '../../server/src/lib/reminderScheduler';

const cfg = loadReminderConfig({});
// Deadline used below: 14 Oct 2026 at 18:00 (a date-only task, default deadline hour)
const deadline = taskDeadline('2026-10-14T00:00:00', cfg);
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m);

describe('reminder configuration', () => {
    it('uses sensible defaults', () => {
        expect(cfg).toEqual({ dayBeforeHour: 18, sameDayHours: 3, deadlineHour: 18, escalationHours: 1 });
    });
    it('accepts 2 hours for the same-day reminder and ignores invalid values', () => {
        expect(loadReminderConfig({ REMINDER_SAME_DAY_HOURS: '2' }).sameDayHours).toBe(2);
        expect(loadReminderConfig({ REMINDER_SAME_DAY_HOURS: 'abc' }).sameDayHours).toBe(3);
        expect(loadReminderConfig({ REMINDER_DAY_BEFORE_HOUR: '99' }).dayBeforeHour).toBe(18);
    });
});

describe('taskDeadline', () => {
    it('gives a date-only task the default deadline hour', () => {
        expect(deadline.getHours()).toBe(18);
        expect(deadline.getDate()).toBe(14);
    });
    it('keeps the time when the task has one', () => {
        expect(taskDeadline('2026-10-14T10:30:00', cfg).getHours()).toBe(10);
    });
});

describe('reachedStages', () => {
    it('sends nothing before the evening before', () => {
        expect(reachedStages(at(13, 17, 59), deadline, cfg)).toEqual([]);
    });
    it('sends the day-before reminder from 18:00 the evening before', () => {
        expect(reachedStages(at(13, 18, 30), deadline, cfg)).toEqual(['day_before']);
    });
    it('sends the same-day reminder 3 hours before, and 2 hours when configured', () => {
        expect(reachedStages(at(14, 15, 0), deadline, cfg)).toContain('same_day');
        expect(reachedStages(at(14, 14, 59), deadline, cfg)).not.toContain('same_day');
        const two = loadReminderConfig({ REMINDER_SAME_DAY_HOURS: '2' });
        expect(reachedStages(at(14, 15, 30), deadline, two)).not.toContain('same_day');
        expect(reachedStages(at(14, 16, 0), deadline, two)).toContain('same_day');
    });
    it('escalates one hour before the deadline', () => {
        expect(reachedStages(at(14, 16, 59), deadline, cfg)).not.toContain('escalation');
        expect(reachedStages(at(14, 17, 0), deadline, cfg)).toContain('escalation');
    });
    it('sends nothing once the deadline has passed', () => {
        expect(reachedStages(at(14, 18, 0), deadline, cfg)).toEqual([]);
    });
});

describe('latestReminderStage', () => {
    it('keeps only the most recent reminder (a late server start sends one, not two)', () => {
        expect(latestReminderStage(['day_before', 'same_day'])).toBe('same_day');
        expect(latestReminderStage(['day_before'])).toBe('day_before');
        expect(latestReminderStage(['escalation'])).toBeNull();
    });
});
