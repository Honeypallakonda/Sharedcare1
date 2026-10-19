import cron from 'node-cron';
import { addDays, format, startOfDay } from 'date-fns';
import { query } from '../db';
import { createNotification } from './notifications';
import logger from './logger';
import { pickLang } from './i18n';
import { getAppUrl, isMailConfigured, sendMail } from './mailer';

// Rappels planifiés du cercle de soin:
//  - rappels d'événements (events.reminder_30min / reminder_1hour), notifiés
//    à TOUS les membres du cercle (notification interne + web push);
//  - rappel quotidien (9h) de renouvellement d'ordonnance, notifié aux membres
//    admin + family du cercle, une seule fois par jour et par ordonnance.
//  - rappels d'échéance par e-mail + notification (tâches et événements): la
//    veille, puis quelques heures avant le jour J, avec ESCALADE vers les autres
//    membres quand la personne assignée n'a pas terminé la tâche (voir plus bas).
// Les rappels de prise de médicaments (medication_intakes) sont gérés ailleurs.

interface EventRow {
    id: string;
    circle_id: string;
    title: string;
    /** Naive local timestamp string ('YYYY-MM-DDTHH:mm:ss'), see the pg type parser in db.ts */
    start_time: string;
    location?: string | null;
}

interface MemberRow {
    user_id: string;
    /** Recipient's preferred language ('fr' | 'en' | 'es'), defaults to 'fr' */
    language: string;
}

// events.start_time is a naive TIMESTAMP holding LOCAL wall-clock time, so the
// comparison windows must be formatted as naive server-local strings, NOT
// toISOString(), which is UTC and would shift the windows by the UTC offset.
const toLocalNaive = (d: Date): string => format(d, "yyyy-MM-dd'T'HH:mm:ss");

interface ReminderTexts {
    title: string;
    body: string;
}

function buildEventTexts(event: EventRow, kind: '30min' | '1hour', language: string): ReminderTexts {
    // start_time is 'YYYY-MM-DDTHH:mm:ss': extract HH:mm directly, no Date round-trip.
    const timeStr = event.start_time.slice(11, 16);
    const suffix = `${timeStr}${event.location ? ` · ${event.location}` : ''}`;
    const lang = pickLang(language);

    if (lang === 'es') {
        return {
            title: `⏰ Recordatorio: ${event.title}`,
            body: `${kind === '30min' ? 'Dentro de 30 minutos' : 'Dentro de 1 hora'} · ${suffix}`,
        };
    }
    if (lang === 'en') {
        return {
            title: `⏰ Reminder: ${event.title}`,
            body: `${kind === '30min' ? 'In 30 minutes' : 'In 1 hour'} · ${suffix}`,
        };
    }
    return {
        title: `⏰ Rappel : ${event.title}`,
        body: `${kind === '30min' ? 'Dans 30 minutes' : 'Dans 1 heure'} · ${suffix}`,
    };
}

/**
 * Members of the circle who have NOT yet received the given notification
 * (type + related_id), with their preferred language. Optional role filter.
 */
async function membersToNotify(
    circleId: string,
    relatedId: string,
    type: string,
    roles?: string[]
): Promise<MemberRow[]> {
    const params: unknown[] = [circleId, relatedId, type];
    let roleFilter = '';
    if (roles && roles.length > 0) {
        params.push(roles);
        roleFilter = `AND cm.role = ANY($4)`;
    }
    const { rows } = await query(
        `SELECT cm.user_id, COALESCE(u.language, 'fr') AS language
         FROM circle_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.circle_id = $1
           ${roleFilter}
           AND NOT EXISTS (
             SELECT 1 FROM notifications n
             WHERE n.user_id = cm.user_id
               AND n.related_id = $2
               AND n.type = $3
           )`,
        params
    );
    return rows as MemberRow[];
}

async function processEventWindow(
    windowStart: Date,
    windowEnd: Date,
    flagColumn: 'reminder_30min' | 'reminder_1hour',
    kind: '30min' | '1hour'
): Promise<void> {
    const type = flagColumn; // notification type mirrors the flag name
    const { rows } = await query(
        `SELECT e.id, e.circle_id, e.title, e.start_time, e.location
         FROM events e
         WHERE e.${flagColumn} = true
           AND e.start_time BETWEEN $1 AND $2`,
        [toLocalNaive(windowStart), toLocalNaive(windowEnd)]
    );

    for (const event of rows as EventRow[]) {
        // Every circle member gets the event reminder; the NOT EXISTS dedup is
        // per user, so a member added between two ticks still gets notified.
        const members = await membersToNotify(event.circle_id, event.id, type);
        for (const member of members) {
            const { title, body } = buildEventTexts(event, kind, member.language);
            await createNotification({
                userId: member.user_id,
                circleId: event.circle_id,
                title,
                message: body,
                type,
                relatedId: event.id,
                url: '/calendar',
                tag: `reminder-${event.id}-${kind}`,
            });
        }
        if (members.length > 0) {
            logger.info('reminder.event_sent', { eventId: event.id, type: kind, recipients: members.length });
        }
    }
}

async function checkEventReminders(): Promise<void> {
    const now = new Date();

    try {
        // Window: 25 to 35 min from now (covers the "30 min before" cron tick)
        await processEventWindow(
            new Date(now.getTime() + 25 * 60 * 1000),
            new Date(now.getTime() + 35 * 60 * 1000),
            'reminder_30min',
            '30min'
        );

        // Window: 55 to 65 min from now (covers the "1 hour before" cron tick)
        await processEventWindow(
            new Date(now.getTime() + 55 * 60 * 1000),
            new Date(now.getTime() + 65 * 60 * 1000),
            'reminder_1hour',
            '1hour'
        );
    } catch (err) {
        logger.error('reminder.scheduler_error', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

interface PrescriptionRow {
    id: string;
    circle_id: string;
    title: string;
    /** 'YYYY-MM-DD' */
    renewal_date: string;
}

function buildPrescriptionTexts(prescription: PrescriptionRow, language: string): ReminderTexts {
    const [y, m, d] = prescription.renewal_date.split('-');
    const lang = pickLang(language);
    if (lang === 'es') {
        return {
            title: '💊 Renovación de receta',
            body: `«${prescription.title}» debe renovarse antes del ${d}/${m}/${y}`,
        };
    }
    if (lang === 'en') {
        return {
            title: '💊 Prescription renewal',
            body: `"${prescription.title}" must be renewed by ${prescription.renewal_date}`,
        };
    }
    return {
        title: '💊 Renouvellement d\'ordonnance',
        body: `« ${prescription.title} » est à renouveler avant le ${d}/${m}/${y}`,
    };
}

/**
 * Daily prescription renewal reminders: for every prescription whose renewal
 * window is open (renewal_date - reminder_days <= today <= renewal_date),
 * notify the admin + family members of the circle. At most one notification
 * per prescription per day: the inner NOT EXISTS skips prescriptions that
 * already got a 'prescription_renewal' notification today (related_id check).
 */
async function checkPrescriptionRenewals(): Promise<void> {
    try {
        const { rows } = await query(
            `SELECT p.id, p.circle_id, p.title,
                    to_char(p.renewal_date, 'YYYY-MM-DD') AS renewal_date
             FROM prescriptions p
             WHERE p.renewal_date IS NOT NULL
               AND p.renewal_date - p.reminder_days <= CURRENT_DATE
               AND p.renewal_date >= CURRENT_DATE
               AND NOT EXISTS (
                 SELECT 1 FROM notifications n
                 WHERE n.related_id = p.id
                   AND n.type = 'prescription_renewal'
                   AND n.created_at >= CURRENT_DATE
               )`
        );

        for (const prescription of rows as PrescriptionRow[]) {
            const { rows: memberRows } = await query(
                `SELECT cm.user_id, COALESCE(u.language, 'fr') AS language
                 FROM circle_members cm
                 JOIN users u ON u.id = cm.user_id
                 WHERE cm.circle_id = $1
                   AND cm.role IN ('admin', 'family')`,
                [prescription.circle_id]
            );

            for (const member of memberRows as MemberRow[]) {
                const { title, body } = buildPrescriptionTexts(prescription, member.language);
                await createNotification({
                    userId: member.user_id,
                    circleId: prescription.circle_id,
                    title,
                    message: body,
                    type: 'prescription_renewal',
                    relatedId: prescription.id,
                    url: '/medications',
                    tag: `prescription-${prescription.id}`,
                });
            }
            logger.info('reminder.prescription_sent', {
                prescriptionId: prescription.id,
                recipients: (memberRows as MemberRow[]).length,
            });
        }
    } catch (err) {
        logger.error('reminder.prescription_error', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

function buildHydrationTexts(firstName: string, language: string): ReminderTexts {
    const lang = pickLang(language);
    if (lang === 'es') {
        return {
            title: '🌡️ Calor: hora de hidratarse',
            body: firstName
                ? `Hace mucho calor hoy. Ofrezca un vaso de agua a ${firstName} y mantenga la casa fresca.`
                : 'Hace mucho calor hoy. Ofrezca un vaso de agua y mantenga la casa fresca.',
        };
    }
    if (lang === 'en') {
        return {
            title: '🌡️ Heat: time to hydrate',
            body: firstName
                ? `Strong heat today. Offer ${firstName} a glass of water and keep the home cool.`
                : 'Strong heat today. Offer a glass of water and keep the home cool.',
        };
    }
    return {
        title: '🌡️ Forte chaleur : pensez à hydrater',
        body: firstName
            ? `Forte chaleur aujourd'hui. Proposez un verre d'eau à ${firstName} et gardez le logement au frais.`
            : `Forte chaleur aujourd'hui. Proposez un verre d'eau et gardez le logement au frais.`,
    };
}

/**
 * Heat-episode hydration reminders: every minute, for circles with an ACTIVE
 * heat episode whose reminder_times contains the current local HH:mm, notify the
 * admin + family members. Dedup window of 5 minutes (keyed on the circle id in
 * related_id) guards against a double cron tick; reminder_times default 4 hours
 * apart, so the next slot fires normally. A missed minute (server down) simply
 * skips that slot: hydration reminders are preventive, not critical.
 */
async function checkHeatwaveHydration(): Promise<void> {
    try {
        // L'heure courante DOIT etre calculee dans le meme fuseau que le cron
        // (process.env.TZ ?? 'Europe/Paris'), pas dans le fuseau de l'OS: les
        // reminder_times sont saisis par l'aidant en heure locale. Sinon, sur un
        // Docker en UTC sans TZ, les rappels tomberaient a la mauvaise heure.
        const tz = process.env.TZ || 'Europe/Paris';
        const nowHm = new Intl.DateTimeFormat('en-GB', {
            timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        }).format(new Date());
        const { rows } = await query(
            `SELECT h.circle_id
             FROM heatwave_settings h
             WHERE h.enabled = TRUE AND h.active = TRUE
               AND h.reminder_times @> to_jsonb($1::text)
               AND NOT EXISTS (
                 SELECT 1 FROM notifications n
                 WHERE n.related_id = h.circle_id
                   AND n.type = 'heatwave_hydration'
                   AND n.created_at >= NOW() - INTERVAL '5 minutes'
               )`,
            [nowHm]
        );

        for (const { circle_id: circleId } of rows as Array<{ circle_id: string }>) {
            const recipientResult = await query(
                'SELECT first_name FROM care_recipients WHERE circle_id = $1',
                [circleId]
            );
            const firstName: string = recipientResult.rows[0]?.first_name?.trim() || '';

            const { rows: memberRows } = await query(
                `SELECT cm.user_id, COALESCE(u.language, 'fr') AS language
                 FROM circle_members cm
                 JOIN users u ON u.id = cm.user_id
                 WHERE cm.circle_id = $1 AND cm.role IN ('admin', 'family')`,
                [circleId]
            );

            for (const member of memberRows as MemberRow[]) {
                const { title, body } = buildHydrationTexts(firstName, member.language);
                await createNotification({
                    userId: member.user_id,
                    circleId,
                    title,
                    message: body,
                    type: 'heatwave_hydration',
                    relatedId: circleId,
                    url: '/',
                    tag: `heatwave-${circleId}`,
                });
            }
            if ((memberRows as MemberRow[]).length > 0) {
                logger.info('reminder.heatwave_sent', { circleId, recipients: (memberRows as MemberRow[]).length });
            }
        }
    } catch (err) {
        logger.error('reminder.heatwave_error', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

// ─── Deadline reminders (day before + same day) and escalation ───────────────
//
// Applies to tasks (tasks.due_date, not completed) and to events that have a
// reminder flag. Per item, each person is told at most once per stage (dedup on
// notifications: user + related_id + type), by in-app/push notification AND, when
// SMTP is configured, by e-mail:
//   - day_before : the evening before (REMINDER_DAY_BEFORE_HOUR, default 18)
//   - same_day   : REMINDER_SAME_DAY_HOURS before the deadline (default 3; 2 works)
//   - escalation : tasks only. The assigned member has not completed the task
//                  ESCALATION_HOURS_BEFORE (default 1) before the deadline, so the
//                  OTHER admin/family members are asked to step in.
// A task whose due_date has no time of day (00:00) is due at TASK_DEADLINE_HOUR.

export interface ReminderConfig {
    dayBeforeHour: number;
    sameDayHours: number;
    deadlineHour: number;
    escalationHours: number;
}

export type DeadlineStage = 'day_before' | 'same_day' | 'escalation';

const intEnv = (value: string | undefined, fallback: number, min: number, max: number): number => {
    const n = Number.parseInt(value ?? '', 10);
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

export function loadReminderConfig(env: NodeJS.ProcessEnv = process.env): ReminderConfig {
    return {
        dayBeforeHour: intEnv(env.REMINDER_DAY_BEFORE_HOUR, 18, 0, 23),
        sameDayHours: intEnv(env.REMINDER_SAME_DAY_HOURS, 3, 1, 12),
        deadlineHour: intEnv(env.TASK_DEADLINE_HOUR, 18, 1, 23),
        escalationHours: intEnv(env.ESCALATION_HOURS_BEFORE, 1, 1, 12),
    };
}

/** Parses a naive 'YYYY-MM-DDTHH:mm:ss' local timestamp (no timezone shift). */
const parseNaive = (value: string): Date => {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
    if (!m) return new Date(NaN);
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
};

/** A task's deadline: its own time, or TASK_DEADLINE_HOUR when it is date-only. */
export function taskDeadline(dueNaive: string, cfg: ReminderConfig): Date {
    const d = parseNaive(dueNaive);
    if (Number.isNaN(d.getTime())) return d;
    if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) d.setHours(cfg.deadlineHour, 0, 0, 0);
    return d;
}

/** Stages whose trigger time has passed while the deadline is still ahead. */
export function reachedStages(now: Date, deadline: Date, cfg: ReminderConfig): DeadlineStage[] {
    if (Number.isNaN(deadline.getTime()) || now.getTime() >= deadline.getTime()) return [];
    const HOUR = 3_600_000;
    const dayBefore = new Date(deadline);
    dayBefore.setDate(dayBefore.getDate() - 1);
    dayBefore.setHours(cfg.dayBeforeHour, 0, 0, 0);
    const sameDay = new Date(deadline.getTime() - cfg.sameDayHours * HOUR);
    const escalation = new Date(deadline.getTime() - cfg.escalationHours * HOUR);

    const stages: DeadlineStage[] = [];
    if (dayBefore.getTime() < sameDay.getTime() && now.getTime() >= dayBefore.getTime()) stages.push('day_before');
    if (now.getTime() >= sameDay.getTime()) stages.push('same_day');
    if (now.getTime() >= escalation.getTime()) stages.push('escalation');
    return stages;
}

/** Only the latest reminder stage is sent (a late server start must not send both). */
export const latestReminderStage = (stages: DeadlineStage[]): 'day_before' | 'same_day' | null =>
    stages.includes('same_day') ? 'same_day' : stages.includes('day_before') ? 'day_before' : null;

interface DeadlineItem {
    kind: 'task' | 'event';
    id: string;
    circleId: string;
    title: string;
    deadline: Date;
}

interface DeadlineRecipient {
    member_id: string;
    user_id: string;
    role: string;
    language: string;
    email: string;
    name: string;
}

function buildDeadlineTexts(
    item: DeadlineItem,
    stage: DeadlineStage,
    language: string,
    hoursLeft: number,
    assigneeNames: string
): ReminderTexts {
    const lang = pickLang(language);
    const hm = format(item.deadline, 'HH:mm');
    const t = item.title;
    const isTask = item.kind === 'task';

    if (stage === 'day_before') {
        if (lang === 'es') return { title: `⏰ Mañana: ${t}`, body: isTask ? `Para mañana antes de las ${hm}.` : `Mañana a las ${hm}.` };
        if (lang === 'en') return { title: `⏰ Tomorrow: ${t}`, body: isTask ? `Due tomorrow by ${hm}.` : `Tomorrow at ${hm}.` };
        return { title: `⏰ Demain : ${t}`, body: isTask ? `À faire demain avant ${hm}.` : `Demain à ${hm}.` };
    }
    if (stage === 'same_day') {
        if (lang === 'es') return { title: `⏰ Hoy: ${t}`, body: isTask ? `Quedan unas ${hoursLeft} h (antes de las ${hm}).` : `Empieza en unas ${hoursLeft} h (${hm}).` };
        if (lang === 'en') return { title: `⏰ Today: ${t}`, body: isTask ? `About ${hoursLeft} h left (by ${hm}).` : `Starts in about ${hoursLeft} h (${hm}).` };
        return { title: `⏰ Aujourd'hui : ${t}`, body: isTask ? `Il reste environ ${hoursLeft} h (avant ${hm}).` : `Commence dans environ ${hoursLeft} h (${hm}).` };
    }
    // escalation
    if (lang === 'es') {
        return { title: `🤝 Se necesita ayuda: ${t}`, body: `${assigneeNames || 'La persona asignada'} aún no lo ha terminado (antes de las ${hm}). ¿Alguien puede ayudar?` };
    }
    if (lang === 'en') {
        return { title: `🤝 Needs a hand: ${t}`, body: `${assigneeNames || 'The assigned person'} has not finished this yet (due by ${hm}). Can someone step in?` };
    }
    return { title: `🤝 Besoin d'un coup de main : ${t}`, body: `${assigneeNames || 'La personne assignée'} n'a pas encore terminé (avant ${hm}). Quelqu'un peut-il prendre le relais ?` };
}

async function sendDeadlineEmail(recipient: DeadlineRecipient, texts: ReminderTexts, kind: 'task' | 'event'): Promise<void> {
    if (process.env.REMINDER_EMAIL === 'false') return;
    if (!isMailConfigured()) {
        logger.info('reminder.email_skipped', { reason: 'smtp_not_configured', subject: texts.title });
        return;
    }
    const lang = pickLang(recipient.language);
    const greeting = lang === 'es' ? `Hola ${recipient.name},` : lang === 'en' ? `Hello ${recipient.name},` : `Bonjour ${recipient.name},`;
    const link = `${getAppUrl()}${kind === 'task' ? '/tasks' : '/calendar'}`;
    try {
        await sendMail({
            to: recipient.email,
            subject: texts.title,
            text: `${greeting}\n\n${texts.body}\n\n${link}`,
            html: `<p>${greeting}</p><p>${texts.body}</p><p><a href="${link}">${link}</a></p>`,
        });
        logger.info('reminder.email_sent', { subject: texts.title });
    } catch (err) {
        logger.warn('reminder.email_failed', { error: err instanceof Error ? err.message : String(err) });
    }
}

/** Circle members who have not yet received this (type, related_id) notification. */
async function deadlineRecipients(circleId: string, relatedId: string, type: string): Promise<DeadlineRecipient[]> {
    const { rows } = await query(
        `SELECT cm.id AS member_id, cm.user_id, cm.role, COALESCE(u.language, 'fr') AS language, u.email, u.name
         FROM circle_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.circle_id = $1
           AND NOT EXISTS (
             SELECT 1 FROM notifications n
             WHERE n.user_id = cm.user_id AND n.related_id = $2 AND n.type = $3
           )`,
        [circleId, relatedId, type]
    );
    return rows as DeadlineRecipient[];
}

async function notifyDeadline(
    item: DeadlineItem,
    stage: DeadlineStage,
    recipients: DeadlineRecipient[],
    now: Date,
    assigneeNames = ''
): Promise<void> {
    if (recipients.length === 0) return;
    const type = `${item.kind}_${stage}`;
    const hoursLeft = Math.max(1, Math.round((item.deadline.getTime() - now.getTime()) / 3_600_000));
    for (const recipient of recipients) {
        const texts = buildDeadlineTexts(item, stage, recipient.language, hoursLeft, assigneeNames);
        await createNotification({
            userId: recipient.user_id,
            circleId: item.circleId,
            title: texts.title,
            message: texts.body,
            type,
            relatedId: item.id,
            url: item.kind === 'task' ? '/tasks' : '/calendar',
            tag: `${type}-${item.id}`,
        });
        await sendDeadlineEmail(recipient, texts, item.kind);
    }
    logger.info('reminder.deadline_sent', { kind: item.kind, itemId: item.id, stage, recipients: recipients.length });
}

const isCareGiver = (r: DeadlineRecipient): boolean => r.role === 'admin' || r.role === 'family';

async function processTaskDeadlines(now: Date, cfg: ReminderConfig): Promise<void> {
    const { rows } = await query(
        `SELECT t.id, t.circle_id, t.title,
                to_char(t.due_date, 'YYYY-MM-DD"T"HH24:MI:SS') AS due,
                COALESCE(t.assigned_to, '[]'::jsonb) AS assigned_to
         FROM tasks t
         WHERE t.is_completed = FALSE
           AND t.due_date IS NOT NULL
           AND t.due_date >= $1 AND t.due_date < $2`,
        [toLocalNaive(startOfDay(now)), toLocalNaive(addDays(startOfDay(now), 3))]
    );

    for (const row of rows as Array<{ id: string; circle_id: string; title: string; due: string; assigned_to: unknown }>) {
        const deadline = taskDeadline(row.due, cfg);
        const stages = reachedStages(now, deadline, cfg);
        if (stages.length === 0) continue;

        const item: DeadlineItem = { kind: 'task', id: row.id, circleId: row.circle_id, title: row.title, deadline };
        const assigned = Array.isArray(row.assigned_to) ? (row.assigned_to as string[]) : [];

        // 1) Reminder (day before / same day): the assigned members, or every
        //    admin/family member when nobody is assigned.
        const reminder = latestReminderStage(stages);
        if (reminder) {
            const all = await deadlineRecipients(item.circleId, item.id, `task_${reminder}`);
            const targets = assigned.length > 0 ? all.filter((r) => assigned.includes(r.member_id)) : all.filter(isCareGiver);
            await notifyDeadline(item, reminder, targets, now);
        }

        // 2) Escalation: still not completed shortly before the deadline, so the
        //    other care-circle members are asked to step in.
        if (stages.includes('escalation') && assigned.length > 0) {
            const all = await deadlineRecipients(item.circleId, item.id, 'task_escalation');
            const others = all.filter((r) => isCareGiver(r) && !assigned.includes(r.member_id));
            if (others.length > 0) {
                const { rows: names } = await query(
                    `SELECT u.name FROM circle_members cm JOIN users u ON u.id = cm.user_id
                     WHERE cm.circle_id = $1 AND cm.id = ANY($2::uuid[])`,
                    [item.circleId, assigned]
                );
                await notifyDeadline(item, 'escalation', others, now, (names as Array<{ name: string }>).map((n) => n.name).join(', '));
            }
        }
    }
}

async function processEventDeadlines(now: Date, cfg: ReminderConfig): Promise<void> {
    const { rows } = await query(
        `SELECT e.id, e.circle_id, e.title, to_char(e.start_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS due
         FROM events e
         WHERE (e.reminder_30min = TRUE OR e.reminder_1hour = TRUE)
           AND e.start_time >= $1 AND e.start_time < $2`,
        [toLocalNaive(now), toLocalNaive(addDays(startOfDay(now), 3))]
    );

    for (const row of rows as Array<{ id: string; circle_id: string; title: string; due: string }>) {
        const deadline = parseNaive(row.due);
        const reminder = latestReminderStage(reachedStages(now, deadline, cfg));
        if (!reminder) continue;
        const item: DeadlineItem = { kind: 'event', id: row.id, circleId: row.circle_id, title: row.title, deadline };
        await notifyDeadline(item, reminder, await deadlineRecipients(item.circleId, item.id, `event_${reminder}`), now);
    }
}

export async function checkDeadlineReminders(now: Date = new Date(), cfg: ReminderConfig = loadReminderConfig()): Promise<void> {
    try {
        await processTaskDeadlines(now, cfg);
        await processEventDeadlines(now, cfg);
    } catch (err) {
        logger.error('reminder.deadline_error', { error: err instanceof Error ? err.message : String(err) });
    }
}

export function startReminderScheduler(): void {
    const tz = process.env.TZ ?? 'Europe/Paris';

    // Event reminders: every minute
    cron.schedule('* * * * *', () => {
        void checkEventReminders();
    }, { timezone: tz });

    // Deadline reminders (day before / same day, e-mail + notification) and
    // escalation to the other members: every minute, deduplicated per user.
    cron.schedule('* * * * *', () => {
        void checkDeadlineReminders();
    }, { timezone: tz });

    // Heat-episode hydration reminders: every minute (matches the configured
    // HH:mm slots; the per-circle dedup window makes a double tick idempotent)
    cron.schedule('* * * * *', () => {
        void checkHeatwaveHydration();
    }, { timezone: tz });

    // Prescription renewals: every day at 9:00 (the daily dedup makes it idempotent)
    cron.schedule('0 9 * * *', () => {
        void checkPrescriptionRenewals();
    }, { timezone: tz });

    logger.info('reminder.scheduler_started', { timezone: tz });
}
