// Prompt building + server-side validation for the AI assistant features.
//
// The JSON schemas below are shared by all providers. Constraints:
//  - every object carries additionalProperties:false (Anthropic structured outputs),
//  - no minLength/maxLength/minimum/maximum (unsupported there): all bounds are
//    enforced by the validators in this file, which NEVER trust the model output.
//  - every property is required; "not applicable" is conveyed with '' / [] / 0 so
//    the same schema behaves identically on Ollama, OpenAI-compatible and Anthropic.

import { pick, pickLang } from '../../lib/i18n';

export const TASK_PRIORITIES = ['Haute', 'Moyenne', 'Basse'] as const;
export const TASK_FREQUENCIES = ['Une fois', 'Quotidien', 'Hebdomadaire', 'Mensuel', 'Annuel'] as const;
export const SHOPPING_CATEGORIES = ['Alimentation', 'Hygiene', 'Menage', 'Sante', 'Autre'] as const;
export const EXPENSE_CATEGORIES = [
    'Pharmacie', 'Auxiliaire', 'Travaux', 'Transport', 'Sante', 'Autre',
] as const;

/** A member of the care circle (circle_members.id + display name). */
export interface CircleMemberRef {
    id: string;
    name: string;
}

// ─── /api/ai/parse ────────────────────────────────────────────────────────────

export const PARSE_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
        items: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: [
                    'type', 'title', 'description', 'date', 'start_time', 'end_time',
                    'location', 'member_names', 'priority', 'frequency',
                    'quantity', 'unit', 'category', 'amount', 'is_expense',
                ],
                properties: {
                    type: { type: 'string', enum: ['task', 'appointment', 'shopping_item', 'budget_entry'] },
                    title: { type: 'string' },
                    description: { type: 'string' },
                    date: { type: 'string' },
                    start_time: { type: 'string' },
                    end_time: { type: 'string' },
                    location: { type: 'string' },
                    member_names: { type: 'array', items: { type: 'string' } },
                    priority: { type: 'string', enum: ['', ...TASK_PRIORITIES] },
                    frequency: { type: 'string', enum: ['', ...TASK_FREQUENCIES] },
                    quantity: { type: 'number' },
                    unit: { type: 'string' },
                    category: { type: 'string' },
                    amount: { type: 'number' },
                    is_expense: { type: 'boolean' },
                },
            },
        },
    },
};

const WEEKDAYS_FR = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Server-local "today", as YYYY-MM-DD + French weekday name. */
export function localToday(): { iso: string; weekday: string } {
    const now = new Date();
    return {
        iso: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`,
        weekday: WEEKDAYS_FR[now.getDay()],
    };
}

export function buildParsePrompt(members: CircleMemberRef[]): string {
    const { iso, weekday } = localToday();
    const memberList = members.length > 0
        ? members.map((m) => `- ${m.name}`).join('\n')
        : '(aucun membre enregistré)';

    return [
        `Tu es l'assistant d'une application de coordination d'aidants familiaux autour d'une personne âgée. Un aidant écrit une note en langage naturel (français ou anglais). Extrais-en un ou plusieurs éléments actionnables.`,
        ``,
        `Date du jour : ${iso} (${weekday}). Résous toutes les dates relatives ("demain", "jeudi matin", "next week"…) par rapport à cette date, vers le futur le plus proche.`,
        ``,
        `Membres du cercle de soin (utilise exactement ces prénoms dans member_names) :`,
        memberList,
        ``,
        `Types d'éléments :`,
        `- "task" : tâche/rappel pour les aidants (passer à la pharmacie, appeler le médecin, lessive...). title = intitulé. date = échéance "YYYY-MM-DD" ou "". priority parmi ${TASK_PRIORITIES.join('/')} ou "". frequency parmi ${TASK_FREQUENCIES.join('/')} ou "". member_names = aidants assignés.`,
        `- "appointment" : rendez-vous à une heure précise (médecin, kiné, infirmière, visite, coiffeur...). start_time = "YYYY-MM-DDTHH:mm:ss" (heure locale, obligatoire), end_time pareil ou "". location = lieu (cabinet, hôpital, domicile...) ou "". member_names = aidants qui accompagnent.`,
        `- "shopping_item" : article à acheter pour le proche (courses, produits d'hygiène, parapharmacie...). title = nom de l'article. category parmi ${SHOPPING_CATEGORIES.join('/')}. quantity = nombre (0 si inconnu), unit = unité ("kg", "L"…) ou "".`,
        `- "budget_entry" : frais avancé pour le proche (pharmacie, auxiliaire de vie, matériel...). title = libellé. amount = montant (nombre > 0). is_expense = true. category parmi ${EXPENSE_CATEGORIES.join('/')}. date = "YYYY-MM-DD" ("" = aujourd'hui).`,
        ``,
        `Règles :`,
        `- Chaque champ non pertinent vaut "" (chaîne vide), 0 (nombre) ou [] (liste). is_expense vaut true par défaut.`,
        `- "Rendez-vous cardiologue mardi 14h" = appointment. "Racheter du paracétamol" = shopping_item (catégorie Sante). "Penser à renouveler l'ordonnance" sans horaire = task.`,
        `- "Ordonnance pharmacie 23,50" avec un montant = budget_entry (catégorie Pharmacie).`,
        `- Un passage d'intervenant (infirmière, auxiliaire) avec un horaire = appointment.`,
        `- N'invente rien : pas de date si la note n'en donne pas, pas de membre non listé.`,
        `- Réponds UNIQUEMENT avec un objet JSON de la forme {"items":[...]} respectant exactement les champs ci-dessus, sans texte autour.`,
    ].join('\n');
}

interface RawParsedItem {
    type?: unknown;
    title?: unknown;
    description?: unknown;
    date?: unknown;
    start_time?: unknown;
    end_time?: unknown;
    location?: unknown;
    member_names?: unknown;
    priority?: unknown;
    frequency?: unknown;
    quantity?: unknown;
    unit?: unknown;
    category?: unknown;
    amount?: unknown;
    is_expense?: unknown;
}

export type ParsedProposal =
    | {
        type: 'task';
        title: string;
        description: string | null;
        due_date: string | null;
        priority: string | null;
        frequency: string | null;
        assigned_to: string[];
        member_names: string[];
    }
    | {
        type: 'appointment';
        title: string;
        description: string | null;
        start_time: string;
        end_time: string | null;
        location: string | null;
        member_ids: string[];
        member_names: string[];
    }
    | {
        type: 'shopping_item';
        name: string;
        category: string;
        quantity: number | null;
        unit: string | null;
    }
    | {
        type: 'budget_entry';
        category: string;
        amount: number;
        description: string | null;
        date: string;
        is_expense: boolean;
    };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

const cleanString = (value: unknown, maxLength: number): string => {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, maxLength);
};

const cleanDate = (value: unknown): string | null => {
    const s = cleanString(value, 10);
    return DATE_RE.test(s) ? s : null;
};

/** Normalize to naive local "YYYY-MM-DDTHH:mm:ss". */
const cleanDateTime = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const match = value.trim().match(DATETIME_RE);
    if (!match) return null;
    return `${match[1]}T${match[2]}:${match[3]}:${match[4] ?? '00'}`;
};

const cleanPositiveNumber = (value: unknown, max: number): number | null => {
    const n = typeof value === 'string' ? parseFloat(value) : (value as number);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.min(Math.round(n * 100) / 100, max);
};

const resolveMembers = (
    names: unknown,
    members: CircleMemberRef[]
): { ids: string[]; names: string[] } => {
    if (!Array.isArray(names)) return { ids: [], names: [] };
    const byName = new Map(members.map((m) => [m.name.trim().toLowerCase(), m]));
    const ids: string[] = [];
    const resolved: string[] = [];
    for (const raw of names) {
        if (typeof raw !== 'string') continue;
        const member = byName.get(raw.trim().toLowerCase());
        if (member && !ids.includes(member.id)) {
            ids.push(member.id);
            resolved.push(member.name);
        }
    }
    return { ids, names: resolved };
};

// ─── Synthèse hebdomadaire (weekly digest) ────────────────────────────────────

export const WEEKLY_DIGEST_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'stats', 'attention_points', 'weak_signals'],
    properties: {
        summary: { type: 'string' },
        stats: {
            type: 'object',
            additionalProperties: false,
            required: ['visits', 'journal_entries'],
            properties: {
                visits: { type: 'number' },
                journal_entries: { type: 'number' },
            },
        },
        attention_points: { type: 'array', items: { type: 'string' } },
        weak_signals: { type: 'array', items: { type: 'string' } },
    },
};

export interface WeeklyDigestJournalLine {
    /** Human-readable day, e.g. "lundi 2026-06-01". */
    day: string;
    type: string;
    author: string;
    /** Already truncated to 200 chars by the caller. */
    content: string;
}

export interface WeeklyDigestVitalWeek {
    /** Monday of the week, YYYY-MM-DD. */
    week: string;
    type: string;
    avg: number;
    /** Second value (diastolic for bp), null otherwise. */
    avg2: number | null;
    count: number;
    unit: string | null;
}

export interface WeeklyDigestFacts {
    recipientFirstName: string;
    /** Monday of the summarized week, YYYY-MM-DD. */
    weekStart: string;
    /** Sunday of the summarized week, YYYY-MM-DD. */
    weekEnd: string;
    /** Target language of the digest texts ('fr' default, 'en' and 'es' supported). */
    language: string;
    journalEntries: WeeklyDigestJournalLine[];
    journalEntriesCount: number;
    /** Weekly averages per vital type over the last 8 weeks (slow trends). */
    vitalsByWeek: WeeklyDigestVitalWeek[];
    intakes: {
        scheduled: number;
        taken: number;
        missed: number;
        skipped: number;
        /** Days of the missed intakes, e.g. ["mardi 2026-06-02"]. */
        missedDays: string[];
    };
    visitsByDay: Array<{ day: string; count: number }>;
    visitsCount: number;
    tasksDone: number;
}

const digestVitalLine = (v: WeeklyDigestVitalWeek): string => {
    const value = v.avg2 !== null ? `${v.avg}/${v.avg2}` : String(v.avg);
    const unit = v.unit ? ` ${v.unit}` : '';
    return `semaine du ${v.week}: ${value}${unit} (${v.count} mesure${v.count > 1 ? 's' : ''})`;
};

/**
 * Builds the system + user prompts of the weekly digest. The system prompt is
 * written in French; the model is instructed to WRITE the digest in the
 * circle's language (French by default).
 */
export function buildWeeklyDigestPrompt(facts: WeeklyDigestFacts): { system: string; user: string } {
    const languageLabel = pick(pickLang(facts.language), { fr: 'français', en: 'anglais', es: 'espagnol' });

    const system = [
        `Tu rédiges la synthèse hebdomadaire d'un cercle d'aidants familiaux autour de ${facts.recipientFirstName || 'une personne âgée'}. Les lecteurs sont la famille: ton chaleureux, factuel, rassurant quand c'est justifié, jamais alarmiste.`,
        ``,
        `Réponds UNIQUEMENT avec un objet JSON de la forme:`,
        `{"summary": "...", "stats": {"visits": 0, "journal_entries": 0}, "attention_points": ["..."], "weak_signals": ["..."]}`,
        ``,
        `Règles:`,
        `- "summary": 2 à 3 phrases qui résument la semaine (ambiance générale, visites, constantes, prises de médicaments). Exemple de ton: "Semaine calme. 5 visites. Tension stable."`,
        `- "stats": recopie exactement les totaux fournis (visites et entrées de journal de la semaine).`,
        `- "attention_points": 0 à 3 points concrets et vérifiables tirés des données de la semaine (prises manquées avec les jours, incident relaté, douleur signalée...). Pas de conseil médical, pas de généralité.`,
        `- "weak_signals": 0 à 2 tendances lentes UNIQUEMENT si les moyennes hebdomadaires sur les 8 semaines montrent une évolution nette et régulière (perte de poids continue, moral en baisse récurrente, tension qui monte...). En cas de doute ou de données insuffisantes: liste vide []. N'invente RIEN, ne déduis rien d'une mesure isolée.`,
        `- Rédige tous les textes en ${languageLabel}.`,
        `- N'utilise jamais le caractère tiret long.`,
    ].join('\n');

    const journalLines = facts.journalEntries.length > 0
        ? facts.journalEntries.map((e) => `- ${e.day} [${e.type}] ${e.author}: ${e.content || '(sans texte)'}`).join('\n')
        : '(aucune entrée cette semaine)';

    const vitalTypes = Array.from(new Set(facts.vitalsByWeek.map((v) => v.type)));
    const vitalsBlock = vitalTypes.length > 0
        ? vitalTypes.map((type) => {
            const weeks = facts.vitalsByWeek.filter((v) => v.type === type);
            return `- ${type}:\n${weeks.map((w) => `    ${digestVitalLine(w)}`).join('\n')}`;
        }).join('\n')
        : '(aucune mesure sur les 8 dernières semaines)';

    const visitsBlock = facts.visitsByDay.length > 0
        ? facts.visitsByDay.map((v) => `- ${v.day}: ${v.count}`).join('\n')
        : '(aucune visite enregistrée)';

    const missedDays = facts.intakes.missedDays.length > 0
        ? ` (jours: ${facts.intakes.missedDays.join(', ')})`
        : '';

    const user = [
        `Semaine du ${facts.weekStart} (lundi) au ${facts.weekEnd} (dimanche). Personne aidée: ${facts.recipientFirstName || '(prénom inconnu)'}.`,
        ``,
        `Totaux de la semaine: ${facts.visitsCount} visite(s), ${facts.journalEntriesCount} entrée(s) de journal, ${facts.tasksDone} tâche(s) terminée(s).`,
        ``,
        `Entrées de journal de la semaine:`,
        journalLines,
        ``,
        `Constantes: moyennes par semaine sur les 8 dernières semaines (pour repérer les tendances lentes):`,
        vitalsBlock,
        ``,
        `Médicaments cette semaine: ${facts.intakes.scheduled} prise(s) prévue(s), ${facts.intakes.taken} confirmée(s), ${facts.intakes.missed} manquée(s)${missedDays}, ${facts.intakes.skipped} volontairement sautée(s).`,
        ``,
        `Visites par jour:`,
        visitsBlock,
    ].join('\n');

    return { system, user };
}

export interface WeeklyDigestContent {
    summary: string;
    stats: { visits: number; journal_entries: number };
    attention_points: string[];
    weak_signals: string[];
}

/**
 * Structural validation of the weekly digest output. The stats are NEVER taken
 * from the model: they are overwritten with the counts computed server-side.
 * Returns null when the model did not produce a usable summary.
 */
export function validateWeeklyDigest(
    raw: Record<string, unknown>,
    counts: { visits: number; journal_entries: number }
): WeeklyDigestContent | null {
    const cleanList = (value: unknown, max: number): string[] => {
        if (!Array.isArray(value)) return [];
        return value
            .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            .map((item) => item.trim().slice(0, 300))
            .slice(0, max);
    };

    const summary = cleanString(raw.summary, 800);
    if (!summary) return null;

    return {
        summary,
        stats: {
            visits: counts.visits,
            journal_entries: counts.journal_entries,
        },
        attention_points: cleanList(raw.attention_points, 3),
        weak_signals: cleanList(raw.weak_signals, 2),
    };
}

/**
 * Structural validation of the model output: drop invalid items, clamp values,
 * resolve member names → ids (case-insensitively). Returns at most 20 proposals.
 */
export function validateParsedItems(raw: Record<string, unknown>, members: CircleMemberRef[]): ParsedProposal[] {
    const items = Array.isArray(raw.items) ? (raw.items as RawParsedItem[]) : [];
    const proposals: ParsedProposal[] = [];

    for (const item of items.slice(0, 20)) {
        if (!item || typeof item !== 'object') continue;
        const title = cleanString(item.title, 255);
        if (!title) continue;
        const description = cleanString(item.description, 1000) || null;

        switch (item.type) {
            case 'task': {
                const priority = cleanString(item.priority, 20);
                const frequency = cleanString(item.frequency, 30);
                const { ids, names } = resolveMembers(item.member_names, members);
                proposals.push({
                    type: 'task',
                    title,
                    description,
                    due_date: cleanDate(item.date),
                    priority: (TASK_PRIORITIES as readonly string[]).includes(priority) ? priority : null,
                    frequency: (TASK_FREQUENCIES as readonly string[]).includes(frequency) ? frequency : null,
                    assigned_to: ids,
                    member_names: names,
                });
                break;
            }
            case 'appointment': {
                const startTime = cleanDateTime(item.start_time);
                if (!startTime) continue; // start_time is mandatory for appointments
                let endTime = cleanDateTime(item.end_time);
                if (endTime && endTime <= startTime) endTime = null;
                const { ids, names } = resolveMembers(item.member_names, members);
                proposals.push({
                    type: 'appointment',
                    title,
                    description,
                    start_time: startTime,
                    end_time: endTime,
                    location: cleanString(item.location, 255) || null,
                    member_ids: ids,
                    member_names: names,
                });
                break;
            }
            case 'shopping_item': {
                const category = cleanString(item.category, 30);
                proposals.push({
                    type: 'shopping_item',
                    name: title,
                    category: (SHOPPING_CATEGORIES as readonly string[]).includes(category) ? category : 'Autre',
                    quantity: cleanPositiveNumber(item.quantity, 9999),
                    unit: cleanString(item.unit, 20) || null,
                });
                break;
            }
            case 'budget_entry': {
                const amount = cleanPositiveNumber(item.amount, 1_000_000);
                if (amount === null) continue; // amount is mandatory for budget entries
                const category = cleanString(item.category, 50);
                proposals.push({
                    type: 'budget_entry',
                    category: (EXPENSE_CATEGORIES as readonly string[]).includes(category) ? category : 'Autre',
                    amount,
                    description: description ?? title,
                    date: cleanDate(item.date) ?? localToday().iso,
                    is_expense: item.is_expense === false ? false : true,
                });
                break;
            }
            default:
                break;
        }
    }

    return proposals;
}

// ─── /api/voice/journal (journal vocal) ───────────────────────────────────────

export const VOICE_JOURNAL_TYPES = ['visit', 'note', 'incident', 'mood'] as const;
export type VoiceJournalEntryType = (typeof VOICE_JOURNAL_TYPES)[number];

export const VOICE_JOURNAL_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['entry', 'shopping_items'],
    properties: {
        entry: {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'content'],
            properties: {
                type: { type: 'string', enum: [...VOICE_JOURNAL_TYPES] },
                content: { type: 'string' },
            },
        },
        shopping_items: { type: 'array', items: { type: 'string' } },
    },
};

/**
 * Prompt for filing a caregiver's voice dictation: a clean journal entry plus
 * the shopping items it mentions ("prévoir du paracétamol" becomes "Paracétamol").
 */
export function buildVoiceJournalPrompt(): string {
    return [
        `Tu es l'assistant d'une application de coordination d'aidants familiaux autour d'une personne âgée. Un aidant vient de dicter une note vocale, transcrite automatiquement (français ou anglais, ponctuation parfois approximative). Range cette dictée.`,
        ``,
        `Produis :`,
        `- entry.content : une entrée de journal concise et propre qui reprend fidèlement les faits dictés (repas, état, soins, visite, incident). Corrige la ponctuation, retire les hésitations et répétitions, garde la langue de la dictée, n'invente rien. Retire de l'entrée les achats à prévoir : ils vont dans shopping_items.`,
        `- entry.type : "visit" si la dictée raconte un passage auprès du proche, "incident" en cas de chute, problème ou urgence, "mood" si elle porte surtout sur le moral, sinon "note".`,
        `- shopping_items : les achats ou produits à prévoir mentionnés, sous forme de noms d'articles courts avec une majuscule initiale ("prévoir du paracétamol" devient "Paracétamol", "il faudra racheter du lait" devient "Lait"). [] si aucun.`,
        ``,
        `Réponds UNIQUEMENT avec un objet JSON de la forme {"entry":{"type":"...","content":"..."},"shopping_items":["..."]} sans texte autour.`,
    ].join('\n');
}

export interface VoiceJournalResult {
    type: VoiceJournalEntryType;
    content: string;
    shopping_items: string[];
}

/**
 * Structural validation of the voice-journal model output. Never trusts the
 * model: falls back to the raw dictation text when the entry is empty.
 */
export function validateVoiceJournal(raw: Record<string, unknown>, fallbackText: string): VoiceJournalResult {
    const entry = raw.entry && typeof raw.entry === 'object' && !Array.isArray(raw.entry)
        ? (raw.entry as Record<string, unknown>)
        : {};

    const rawType = typeof entry.type === 'string' ? entry.type : '';
    const type: VoiceJournalEntryType = (VOICE_JOURNAL_TYPES as readonly string[]).includes(rawType)
        ? (rawType as VoiceJournalEntryType)
        : 'note';

    const content = cleanString(entry.content, 4000) || cleanString(fallbackText, 4000);

    const items: string[] = [];
    const seen = new Set<string>();
    const rawItems = Array.isArray(raw.shopping_items) ? raw.shopping_items : [];
    for (const rawItem of rawItems.slice(0, 20)) {
        const name = cleanString(rawItem, 255);
        if (!name) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(name);
    }

    return { type, content, shopping_items: items };
}

// ─── /api/ai/changes ──────────────────────────────────────────────────────────
// "What changed": the comparison itself is done in SQL/TypeScript (see the route);
// the model only suggests everyday tasks/reminders. Everything it returns is
// re-validated here and filtered for medical wording.

export type ChangeKind = 'vital' | 'missed_doses' | 'incident' | 'mood' | 'medication' | 'prescription';
export type ChangeSeverity = 'info' | 'watch' | 'alert';

export interface DetectedChange {
    /** Stable id within one response (c1, c2...). Suggestions must reference it. */
    id: string;
    kind: ChangeKind;
    severity: ChangeSeverity;
    /** One factual sentence, built from numbers, not from the model. */
    fact: string;
}

// ─── Model call: explain + propose ───────────────────────────────────────────

export const SUGGESTION_KINDS = ['task', 'reminder'] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

export const CHANGES_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['suggestions'],
    properties: {
        suggestions: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['change_id', 'kind', 'title', 'description', 'due_in_days', 'priority'],
                properties: {
                    change_id: { type: 'string' },
                    kind: { type: 'string', enum: [...SUGGESTION_KINDS] },
                    title: { type: 'string' },
                    description: { type: 'string' },
                    due_in_days: { type: 'number' },
                    priority: { type: 'string', enum: [...TASK_PRIORITIES] },
                },
            },
        },
    },
};

export function buildChangesPrompt(changes: DetectedChange[], recipientFirstName: string, language: string, days: number): { system: string; user: string } {
    const languageLabel = pick(pickLang(language), { fr: 'français', en: 'anglais', es: 'espagnol' });
    const system = [
        `Tu aides un cercle d'aidants familiaux autour de ${recipientFirstName || 'une personne âgée'}. On te donne une liste de CHANGEMENTS déjà détectés par le système en comparant les ${days} derniers jours aux ${days} jours précédents. Tu ne détectes rien toi-même.`,
        ``,
        `Réponds UNIQUEMENT avec un objet JSON: {"suggestions":[{"change_id":"c1","kind":"task","title":"...","description":"...","due_in_days":2,"priority":"Haute"}]}`,
        ``,
        `Règles:`,
        `- "suggestions": 0 à 4 propositions. Chaque proposition DOIT référencer un change_id de la liste.`,
        `- "kind": "task" pour quelque chose à faire, "reminder" pour un rappel à une date précise.`,
        `- LANGAGE SIMPLE ET QUOTIDIEN UNIQUEMENT dans title et description: aucun vocabulaire médical ou de santé (pas de médecin, médicament, dose, traitement, douleur, symptôme, hôpital, infirmier, pharmacie, analyse, sang, consultation, etc.).`,
        `- Propose seulement des gestes humains simples: prendre des nouvelles, appeler un proche, écrire une note dans le journal, passer du temps ensemble, demander de l'aide à un autre aidant, prévenir le cercle, revoir la routine de la journée.`,
        `- Titre court (une action concrète), description d'une phrase.`,
        `- due_in_days: nombre de jours à partir d'aujourd'hui (0 = aujourd'hui). priority parmi ${TASK_PRIORITIES.join('/')}.`,
        `- N'invente aucun fait qui ne figure pas dans la liste.`,
        `- Rédige tous les textes en ${languageLabel}. N'utilise jamais le caractère tiret long.`,
    ].join('\n');
    const user = changes.map((c) => `- ${c.id} [${c.severity}] ${c.fact}`).join('\n');
    return { system, user };
}

export interface ChangeSuggestion {
    change_id: string;
    kind: SuggestionKind;
    title: string;
    description: string | null;
    due_date: string; // YYYY-MM-DD, computed server-side
    start_time: string; // YYYY-MM-DDT09:00:00, used when kind === 'reminder'
    priority: string;
}

export interface ChangesResult {
    summary: string;
    changes: DetectedChange[];
    suggestions: ChangeSuggestion[];
}

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ─── Plain-language guard ────────────────────────────────────────────────────

/**
 * Suggestions must read like everyday life, never like medical advice.
 * Matched on accent-stripped lowercase text (EN / FR / ES word stems).
 */
const MEDICAL_TERM_RE = new RegExp(
    '\\b(' +
        [
            'doctor\\w*', 'dr', 'physician\\w*', 'gp', 'medic\\w*', 'dos(e|es|age|ages|is)', 'pain\\w*', 'ache\\w*', 'sore',
            'symptom\\w*', 'treat\\w*', 'therap\\w*', 'hospital\\w*', 'clinic\\w*', 'nurs\\w*', 'pharmac\\w*', 'prescri\\w*',
            'drug\\w*', 'pill\\w*', 'tablet\\w*', 'inject\\w*', 'blood', 'labs?', 'tests?', 'consult\\w*', 'diagnos\\w*',
            'oncolog\\w*', 'chemo\\w*', 'radio\\w*', 'cancer', 'tumou?r\\w*', 'scan', 'x-ray', 'mri', 'vital\\w*', 'pressure',
            'tension', 'illness', 'disease\\w*', 'sick\\w*', 'health\\w*', 'patient\\w*', 'surgery', 'surgeon\\w*', 'emergency',
            'medecin\\w*', 'douleur\\w*', 'ordonnance\\w*', 'traitement\\w*', 'symptome\\w*', 'infirmi\\w*', 'hopital\\w*',
            'sang', 'analyse\\w*', 'posologie', 'malad\\w*', 'sante', 'urgence\\w*',
            'dolor\\w*', 'receta\\w*', 'tratamiento\\w*', 'enfermer\\w*', 'farmacia\\w*', 'sintoma\\w*', 'sangre', 'salud',
            'enfermedad\\w*', 'urgencia\\w*',
        ].join('|') +
        ')\\b'
);

const normalize = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export const containsMedicalTerm = (...texts: Array<string | null | undefined>): boolean =>
    texts.some((t) => typeof t === 'string' && MEDICAL_TERM_RE.test(normalize(t)));

type Localized = { fr: string; en: string; es: string };
const PLAIN_TEMPLATES: Record<ChangeKind, { title: Localized; description: Localized; watch?: { title: Localized; description: Localized } }> = {
    vital: {
        watch: {
            title: { fr: 'Noter dans le journal cette semaine', en: 'Add a note to the journal this week', es: 'Anotar en el diario esta semana' },
            description: {
                fr: 'Écrire comment il ou elle semble au fil des jours pour que le cercle puisse comparer.',
                en: 'Write down how they seem from day to day so the circle can compare.',
                es: 'Escribir cómo se le ve día a día para que el círculo pueda comparar.',
            },
        },
        title: { fr: "Prendre des nouvelles aujourd'hui", en: 'Check in with them today', es: 'Hacer una visita hoy' },
        description: {
            fr: 'Passer un moment ensemble et écrire une courte note dans le journal.',
            en: 'Spend a few minutes together and write a short note in the journal.',
            es: 'Pasar un rato juntos y escribir una nota breve en el diario.',
        },
    },
    missed_doses: {
        title: { fr: 'Revoir la routine quotidienne ensemble', en: 'Look over the daily routine together', es: 'Revisar la rutina diaria juntos' },
        description: {
            fr: 'Voir ensemble ce qui a été oublié cette semaine et comment simplifier.',
            en: 'See together what was missed this week and how to make it easier.',
            es: 'Ver juntos lo que se olvidó esta semana y cómo facilitarlo.',
        },
    },
    incident: {
        title: { fr: 'En discuter avec le cercle', en: 'Talk it over with the circle', es: 'Hablarlo con el círculo' },
        description: {
            fr: "Partager ce qui s'est passé cette semaine avec les autres aidants et décider de la suite.",
            en: 'Share what happened this week with the other caregivers and agree on next steps.',
            es: 'Compartir lo ocurrido esta semana con los demás cuidadores y acordar los siguientes pasos.',
        },
    },
    mood: {
        title: { fr: 'Passer un bon moment ensemble', en: 'Spend some quality time together', es: 'Pasar un buen rato juntos' },
        description: {
            fr: "Prévoir une activité calme qui lui plaît et noter comment la journée s'est passée.",
            en: 'Plan a calm activity they enjoy and note how the day went.',
            es: 'Planear una actividad tranquila que disfrute y anotar cómo fue el día.',
        },
    },
    medication: {
        title: { fr: 'Prévenir tout le cercle', en: 'Let everyone in the circle know', es: 'Avisar a todo el círculo' },
        description: {
            fr: 'S’assurer que tous les aidants sont au courant du changement récent.',
            en: 'Make sure all caregivers are aware of the recent change.',
            es: 'Asegurarse de que todos los cuidadores conocen el cambio reciente.',
        },
    },
    prescription: {
        title: { fr: 'Vérifier les papiers à renouveler bientôt', en: 'Check the paperwork that is due soon', es: 'Revisar los papeles que vencen pronto' },
        description: {
            fr: "Regarder les documents dont l'échéance approche et décider qui s'en occupe.",
            en: 'Look at the documents with an upcoming date and decide who takes care of them.',
            es: 'Mirar los documentos con fecha próxima y decidir quién se encarga.',
        },
    },
};

const isoDay = (daysFromNow: number): string => {
    const d = new Date(Date.now() + daysFromNow * 86_400_000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Neutral suggestion built from a template. Alerts become a dated reminder, others a task. */
const buildPlainFallback = (change: DetectedChange, lang: string): ChangeSuggestion => {
    const base = PLAIN_TEMPLATES[change.kind];
    const l = pickLang(lang);
    const alert = change.severity === 'alert';
    const tpl = !alert && base.watch ? base.watch : base;
    const due = isoDay(alert ? 2 : 5);
    return {
        change_id: change.id,
        kind: alert ? 'reminder' : 'task',
        title: pick(l, tpl.title),
        description: pick(l, tpl.description),
        due_date: due,
        start_time: `${due}T09:00:00`,
        priority: alert ? 'Haute' : 'Moyenne',
    };
};

/** Summary built from the detected facts: always accurate, always in the user's language. */
export const buildSummary = (changes: DetectedChange[], lang: string, days: number): string => {
    const l = pickLang(lang);
    const alerts = changes.filter((c) => c.severity === 'alert').length;
    const watches = changes.filter((c) => c.severity === 'watch').length;
    const n = changes.length;
    if (n === 0) return '';
    const head = pick(l, {
        fr: `${n} changement${n > 1 ? 's' : ''} repéré${n > 1 ? 's' : ''} sur les ${days} derniers jours.`,
        en: `${n} change${n > 1 ? 's' : ''} noticed over the last ${days} days.`,
        es: `${n} cambio${n > 1 ? 's' : ''} detectado${n > 1 ? 's' : ''} en los últimos ${days} días.`,
    });
    const a = alerts ? pick(l, { fr: ` ${alerts} à suivre rapidement.`, en: ` ${alerts} to follow up soon.`, es: ` ${alerts} para atender pronto.` }) : '';
    const w = watches ? pick(l, { fr: ` ${watches} à garder à l'œil.`, en: ` ${watches} to keep an eye on.`, es: ` ${watches} para vigilar.` }) : '';
    return head + a + w;
};

/**
 * Drops suggestions that do not reference a detected change or that use medical
 * wording; recomputes dates; guarantees every alert/watch change a plain-language
 * task or reminder (template-based) when the model gave none.
 */
export function validateChanges(raw: Record<string, unknown>, changes: DetectedChange[], lang = 'fr', days = 7): ChangesResult {
    const byId = new Map(changes.map((c) => [c.id, c]));
    const out: ChangeSuggestion[] = [];
    const seen = new Set<string>();
    const list = Array.isArray(raw.suggestions) ? (raw.suggestions as Array<Record<string, unknown>>) : [];

    for (const s of list.slice(0, 5)) {
        if (!s || typeof s !== 'object') continue;
        const changeId = clean(s.change_id, 10);
        const title = clean(s.title, 255);
        const description = clean(s.description, 1000) || null;
        if (!byId.has(changeId) || !title || seen.has(title.toLowerCase())) continue;
        if (containsMedicalTerm(title, description)) continue; // plain language only
        seen.add(title.toLowerCase());

        const days = Math.min(30, Math.max(0, Math.round(Number(s.due_in_days) || 0)));
        const due = isoDay(days);
        const priority = clean(s.priority, 20);
        const kind = (SUGGESTION_KINDS as readonly string[]).includes(clean(s.kind, 10)) ? (clean(s.kind, 10) as SuggestionKind) : 'task';
        out.push({
            change_id: changeId,
            kind,
            title,
            description,
            due_date: due,
            start_time: `${due}T09:00:00`,
            priority: (TASK_PRIORITIES as readonly string[]).includes(priority) ? priority : 'Moyenne',
        });
    }

    const covered = new Set(out.map((x) => x.change_id));
    for (const c of changes) {
        if (c.severity === 'info' || covered.has(c.id) || out.length >= 6) continue;
        const fallback = buildPlainFallback(c, lang);
        // Two changes can map to the same everyday action: propose it once.
        if (!out.some((x) => x.title === fallback.title)) out.push(fallback);
    }
    return { summary: buildSummary(changes, lang, days), changes, suggestions: out };
}
