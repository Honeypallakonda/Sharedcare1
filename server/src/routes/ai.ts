import { Router, Response } from 'express';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import { circleMiddleware, requireAdmin, requireContentWriter, CircleRequest } from '../middleware/circle';
import { encryptCredentials } from '../utils/crypto';
import { assertSafeIntegrationUrl, UnsafeUrlError, unsafeUrlMessage } from '../utils/urlGuard';
import {
    aiComplete,
    AiError,
    DEFAULT_BASE_URLS,
    loadAiSettingsRow,
    decryptStoredApiKey,
    type AiProvider,
    type AiSettings,
    type AiSettingsRow,
} from '../services/ai';
import {
    PARSE_SCHEMA,
    CHANGES_SCHEMA,
    buildParsePrompt,
    buildChangesPrompt,
    validateParsedItems,
    validateChanges,
    localToday,
    type CircleMemberRef,
    type DetectedChange,
} from '../services/ai/assistant';
import logger from '../lib/logger';
import { langFromRequest, t, type Lang } from '../lib/i18n';

const router = Router();

// All AI settings are scoped to the active care circle (X-Circle-Id header).
router.use(authMiddleware);
router.use(circleMiddleware);

const PROVIDERS: AiProvider[] = ['ollama', 'openai', 'anthropic'];

const toAiSettings = (row: AiSettingsRow): AiSettings => ({
    provider: row.provider,
    base_url: row.base_url,
    api_key: decryptStoredApiKey(row.encrypted_api_key),
    model: row.model,
});

const handleAiError = (res: Response, error: unknown, context: string, lang: Lang) => {
    if (error instanceof AiError) {
        // The code is machine-readable (the client maps it to a localized message)
        // and `message` is a neutral text in the user's language. The detailed
        // provider message can leak an internal URL, so it only goes to the logs.
        logger.warn(`ai.${context}_provider_error`, { code: error.code, detail: error.message });
        return res.status(502).json({ success: false, error: error.code, message: t(lang, `ai.${error.code}`) });
    }
    logger.error(`ai.${context}_error`, {
        error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ success: false, error: 'Internal server error' });
};

// GET /api/ai/settings : visible to every circle member; the key NEVER leaves the server.
router.get('/settings', async (req: CircleRequest, res) => {
    try {
        const row = await loadAiSettingsRow(req.circleId!);
        if (!row) {
            return res.json({ success: true, data: { configured: false, enabled: false } });
        }
        res.json({
            success: true,
            data: {
                configured: Boolean(row.model),
                enabled: row.enabled,
                provider: row.provider,
                base_url: row.base_url,
                model: row.model,
                has_api_key: Boolean(row.encrypted_api_key),
                companion_enabled: row.companion_enabled,
            },
        });
    } catch (error) {
        console.error('Get AI settings error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// PUT /api/ai/settings : circle admins only. Empty api_key keeps the stored one,
// explicit null clears it; the key is encrypted at rest (AES-256-GCM).
router.put('/settings', requireAdmin, async (req: CircleRequest, res) => {
    const lang = langFromRequest(req);
    try {
        const { provider, base_url, api_key, model, enabled, companion_enabled } = req.body as {
            provider?: string;
            base_url?: string | null;
            api_key?: string | null;
            model?: string;
            enabled?: boolean;
            companion_enabled?: boolean;
        };

        if (!provider || !PROVIDERS.includes(provider as AiProvider)) {
            return res.status(400).json({ success: false, error: 'provider invalide' });
        }
        const cleanedModel = typeof model === 'string' ? model.trim().slice(0, 100) : '';
        if (!cleanedModel) {
            return res.status(400).json({ success: false, error: t(lang, 'ai.modelRequired') });
        }

        // Anthropic uses the official endpoint, so there is no base URL to store.
        let cleanedBaseUrl: string | null = null;
        if (provider !== 'anthropic') {
            const rawUrl = typeof base_url === 'string' ? base_url.trim().replace(/\/+$/, '') : '';
            if (rawUrl) {
                try {
                    await assertSafeIntegrationUrl(rawUrl);
                } catch (e) {
                    return res.status(400).json({
                        success: false,
                        error: e instanceof UnsafeUrlError ? unsafeUrlMessage(e, lang) : t(lang, 'url.invalid'),
                    });
                }
                cleanedBaseUrl = rawUrl;
            }
        }

        // api_key: undefined/'' keeps the existing key; explicit null clears it; string replaces it.
        let encryptedKeyExpr: string | null | undefined;
        if (api_key === null) {
            encryptedKeyExpr = null;
        } else if (typeof api_key === 'string' && api_key.trim()) {
            encryptedKeyExpr = encryptCredentials({ api_key: api_key.trim() });
        } else {
            encryptedKeyExpr = undefined; // keep
        }

        const result = await query(
            `INSERT INTO ai_settings (circle_id, provider, base_url, encrypted_api_key, model, enabled, companion_enabled)
             VALUES ($1, $2, $3, $4, $5, $6, $8)
             ON CONFLICT (circle_id) DO UPDATE SET
               provider = EXCLUDED.provider,
               base_url = EXCLUDED.base_url,
               encrypted_api_key = CASE WHEN $7 THEN EXCLUDED.encrypted_api_key ELSE ai_settings.encrypted_api_key END,
               model = EXCLUDED.model,
               enabled = EXCLUDED.enabled,
               companion_enabled = EXCLUDED.companion_enabled,
               updated_at = NOW()
             RETURNING provider, base_url, encrypted_api_key, model, enabled, companion_enabled`,
            [
                req.circleId,
                provider,
                cleanedBaseUrl,
                encryptedKeyExpr === undefined ? null : encryptedKeyExpr,
                cleanedModel,
                enabled === undefined ? true : Boolean(enabled),
                encryptedKeyExpr !== undefined, // $7: replace/clear the key?
                Boolean(companion_enabled), // $8
            ]
        );

        const row = result.rows[0] as AiSettingsRow;
        res.json({
            success: true,
            data: {
                configured: Boolean(row.model),
                enabled: row.enabled,
                provider: row.provider,
                base_url: row.base_url,
                model: row.model,
                has_api_key: Boolean(row.encrypted_api_key),
                companion_enabled: row.companion_enabled,
            },
        });
    } catch (error) {
        console.error('Update AI settings error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// POST /api/ai/test : circle admins only, trivial completion through the abstraction.
// Body fields override the saved settings so "Tester" works before saving;
// an empty api_key falls back to the stored (decrypted) one.
router.post('/test', requireAdmin, async (req: CircleRequest, res) => {
    const lang = langFromRequest(req);
    try {
        const row = await loadAiSettingsRow(req.circleId!);
        const body = req.body as { provider?: string; base_url?: string; api_key?: string; model?: string };

        const provider = (PROVIDERS.includes(body.provider as AiProvider) ? body.provider : row?.provider) as
            | AiProvider
            | undefined;
        const model = (typeof body.model === 'string' && body.model.trim()) || row?.model || '';
        if (!provider || !model) {
            return res.status(400).json({ success: false, error: 'AI_NOT_CONFIGURED' });
        }

        const settings: AiSettings = {
            provider,
            base_url:
                (typeof body.base_url === 'string' && body.base_url.trim().replace(/\/+$/, '')) ||
                row?.base_url ||
                DEFAULT_BASE_URLS[provider],
            api_key:
                (typeof body.api_key === 'string' && body.api_key.trim()) ||
                decryptStoredApiKey(row?.encrypted_api_key ?? null),
            model: model.trim().slice(0, 100),
        };

        const result = await aiComplete(settings, {
            system: 'Tu es un test de connexion. Réponds uniquement en JSON.',
            user: 'Réponds avec {"ok":true}',
            jsonSchema: {
                type: 'object',
                additionalProperties: false,
                required: ['ok'],
                properties: { ok: { type: 'boolean' } },
            },
        });

        if (result.ok !== true) {
            return res.status(502).json({
                success: false,
                error: 'AI_INVALID_RESPONSE',
                message: t(lang, 'ai.testNotJson'),
            });
        }
        res.json({ success: true, message: 'OK' });
    } catch (error) {
        handleAiError(res, error, 'test', lang);
    }
});

/** Loads + checks the circle's configured & enabled settings, or sends the 4xx response. */
const requireConfiguredAi = async (req: CircleRequest, res: Response): Promise<AiSettings | null> => {
    const row = await loadAiSettingsRow(req.circleId!);
    if (!row || !row.model) {
        res.status(400).json({ success: false, error: 'AI_NOT_CONFIGURED' });
        return null;
    }
    if (!row.enabled) {
        res.status(400).json({ success: false, error: 'AI_DISABLED' });
        return null;
    }
    return toAiSettings(row);
};

// POST /api/ai/parse : any circle member, natural-language note to validated proposals.
// Nothing is saved: the client confirms then POSTs to the existing endpoints.
router.post('/parse', async (req: CircleRequest, res) => {
    const lang = langFromRequest(req);
    try {
        const settings = await requireConfiguredAi(req, res);
        if (!settings) return;

        const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
        if (!text) {
            return res.status(400).json({ success: false, error: 'text est requis' });
        }

        const membersResult = await query(
            `SELECT m.id, u.name
             FROM circle_members m
             JOIN users u ON u.id = m.user_id
             WHERE m.circle_id = $1
             ORDER BY u.name`,
            [req.circleId]
        );
        const members = membersResult.rows as CircleMemberRef[];

        const raw = await aiComplete(settings, {
            system: buildParsePrompt(members),
            user: text.slice(0, 2000),
            jsonSchema: PARSE_SCHEMA,
        });

        const items = validateParsedItems(raw, members);
        res.json({ success: true, data: { items } });
    } catch (error) {
        handleAiError(res, error, 'parse', lang);
    }
});

// ─── Change detection (deterministic, SQL) ───────────────────────────────────

const MIN_VITAL_SAMPLES = 2;
const VITAL_RELATIVE_THRESHOLD = 0.1; // 10 % between the two windows

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Compares the last `days` days with the `days` days before them.
 * Returns an empty list when nothing noteworthy changed (no model call needed).
 */
async function detectChanges(circleId: string, days = 7): Promise<DetectedChange[]> {
    const now = new Date();
    const curStart = new Date(now.getTime() - days * 86_400_000);
    const prevStart = new Date(now.getTime() - 2 * days * 86_400_000);
    const changes: Omit<DetectedChange, 'id'>[] = [];

    const [vitals, intakes, journal, newMeds, stoppedMeds, prescriptions] = await Promise.all([
        query(
            `SELECT type,
                    AVG(value) FILTER (WHERE measured_at >= $2)::float8 AS cur,
                    AVG(value) FILTER (WHERE measured_at <  $2)::float8 AS prev,
                    COUNT(*) FILTER (WHERE measured_at >= $2)::int AS cur_n,
                    COUNT(*) FILTER (WHERE measured_at <  $2)::int AS prev_n,
                    MAX(unit) AS unit
             FROM vitals
             WHERE circle_id = $1 AND measured_at >= $3
             GROUP BY type`,
            [circleId, curStart, prevStart]
        ),
        query(
            `SELECT COUNT(*) FILTER (WHERE due_at >= $2 AND status = 'missed')::int AS cur_missed,
                    COUNT(*) FILTER (WHERE due_at <  $2 AND status = 'missed')::int AS prev_missed
             FROM medication_intakes
             WHERE circle_id = $1 AND due_at >= $3 AND due_at <= $4`,
            [circleId, curStart, prevStart, now]
        ),
        query(
            `SELECT type,
                    COUNT(*) FILTER (WHERE occurred_at >= $2)::int AS cur,
                    COUNT(*) FILTER (WHERE occurred_at <  $2)::int AS prev
             FROM journal_entries
             WHERE circle_id = $1 AND type IN ('incident', 'mood') AND occurred_at >= $3
             GROUP BY type`,
            [circleId, curStart, prevStart]
        ),
        query(
            `SELECT name, dosage FROM medications
             WHERE circle_id = $1 AND created_at >= $2 AND active = TRUE`,
            [circleId, curStart]
        ),
        query(
            `SELECT name FROM medications
             WHERE circle_id = $1 AND end_date >= $2::date AND end_date <= CURRENT_DATE`,
            [circleId, curStart]
        ),
        query(
            `SELECT title, to_char(renewal_date, 'YYYY-MM-DD') AS renewal_date
             FROM prescriptions
             WHERE circle_id = $1 AND renewal_date IS NOT NULL
               AND renewal_date <= CURRENT_DATE + INTERVAL '14 days'
             ORDER BY renewal_date`,
            [circleId]
        ),
    ]);

    for (const v of vitals.rows as Array<{ type: string; cur: number | null; prev: number | null; cur_n: number; prev_n: number; unit: string | null }>) {
        if (v.cur === null || v.prev === null || v.cur_n < MIN_VITAL_SAMPLES || v.prev_n < MIN_VITAL_SAMPLES || v.prev === 0) continue;
        const delta = (v.cur - v.prev) / Math.abs(v.prev);
        if (Math.abs(delta) < VITAL_RELATIVE_THRESHOLD) continue;
        const pct = Math.round(Math.abs(delta) * 100);
        changes.push({
            kind: 'vital',
            severity: Math.abs(delta) >= 0.2 ? 'alert' : 'watch',
            fact: `${v.type}: average ${round1(v.prev)} -> ${round1(v.cur)}${v.unit ? ' ' + v.unit : ''} (${delta > 0 ? '+' : '-'}${pct}%, ${v.prev_n} vs ${v.cur_n} measurements)`,
        });
    }

    const intake = intakes.rows[0] as { cur_missed: number; prev_missed: number } | undefined;
    if (intake && intake.cur_missed > intake.prev_missed && intake.cur_missed >= 2) {
        changes.push({
            kind: 'missed_doses',
            severity: intake.cur_missed >= 4 ? 'alert' : 'watch',
            fact: `Missed medication doses: ${intake.prev_missed} -> ${intake.cur_missed} over the last ${days} days`,
        });
    }

    for (const j of journal.rows as Array<{ type: 'incident' | 'mood'; cur: number; prev: number }>) {
        if (j.cur > j.prev) {
            changes.push({
                kind: j.type,
                severity: j.type === 'incident' ? 'alert' : 'watch',
                fact: `Journal "${j.type}" entries: ${j.prev} -> ${j.cur} over the last ${days} days`,
            });
        }
    }

    for (const m of newMeds.rows as Array<{ name: string; dosage: string | null }>) {
        changes.push({ kind: 'medication', severity: 'watch', fact: `New medication added: ${m.name}${m.dosage ? ' ' + m.dosage : ''}` });
    }
    for (const m of stoppedMeds.rows as Array<{ name: string }>) {
        changes.push({ kind: 'medication', severity: 'info', fact: `Medication treatment ended: ${m.name}` });
    }
    for (const p of prescriptions.rows as Array<{ title: string; renewal_date: string }>) {
        changes.push({
            kind: 'prescription',
            severity: p.renewal_date < localToday().iso ? 'alert' : 'watch',
            fact: `Prescription "${p.title}" renewal due ${p.renewal_date}`,
        });
    }

    return changes.slice(0, 12).map((c, i) => ({ ...c, id: `c${i + 1}` }));
}

// POST /api/ai/changes : family/admin only. Compares the last N days with the N days
// before (deterministic), then asks the model to explain the changes and propose
// tasks. Nothing is saved: the client confirms then POSTs to /api/tasks.
router.post('/changes', requireContentWriter, async (req: CircleRequest, res) => {
    const lang = langFromRequest(req);
    try {
        const settings = await requireConfiguredAi(req, res);
        if (!settings) return;

        const rawDays = Number(req.body?.days);
        const days = [7, 14, 30].includes(rawDays) ? rawDays : 7;

        const changes = await detectChanges(req.circleId!, days);
        if (changes.length === 0) {
            return res.json({ success: true, data: { summary: '', changes: [], suggestions: [] } });
        }

        const recipient = await query('SELECT first_name FROM care_recipients WHERE circle_id = $1', [req.circleId]);
        const { system, user } = buildChangesPrompt(changes, recipient.rows[0]?.first_name ?? '', lang, days);
        const raw = await aiComplete(settings, { system, user, jsonSchema: CHANGES_SCHEMA });

        res.json({ success: true, data: validateChanges(raw, changes, lang, days) });
    } catch (error) {
        handleAiError(res, error, 'changes', lang);
    }
});

export default router;
