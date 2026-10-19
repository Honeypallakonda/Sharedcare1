import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, Loader2, Plus, Check } from 'lucide-react';
import { api } from '../../lib/api';
import { useCircle } from '../../contexts/CircleContext';
import { useAiEnabled } from '../../lib/aiStatus';

// Carte « Ce qui a changé » : compare les N derniers jours aux N précédents
// (détection côté serveur), puis propose des tâches. Rien n'est créé sans clic.

interface DetectedChange {
    id: string;
    kind: string;
    severity: 'info' | 'watch' | 'alert';
    fact: string;
}

interface Suggestion {
    change_id: string;
    kind: 'task' | 'reminder';
    title: string;
    description: string | null;
    due_date: string;
    start_time: string;
    priority: string;
}

interface ChangesData {
    summary: string;
    changes: DetectedChange[];
    suggestions: Suggestion[];
}

const SEVERITY_DOT: Record<DetectedChange['severity'], string> = {
    info: 'bg-muted-foreground',
    watch: 'bg-amber-500',
    alert: 'bg-red-500',
};

const PERIODS = [7, 14, 30] as const;

const ChangesCard: React.FC = () => {
    const { t } = useTranslation(['ai']);
    const { canWriteContent } = useCircle();
    const aiEnabled = useAiEnabled();

    const [days, setDays] = useState<number>(7);
    const [data, setData] = useState<ChangesData | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [added, setAdded] = useState<Set<number>>(new Set());
    const [adding, setAdding] = useState<number | null>(null);

    if (!canWriteContent || !aiEnabled) return null;

    const analyze = async () => {
        setLoading(true);
        setError('');
        setAdded(new Set());
        try {
            const response = await api.post<{ success: boolean; data: ChangesData }>('/api/ai/changes', { days });
            setData(response.success ? response.data : null);
        } catch (err) {
            console.error('Changes analysis error:', err);
            setData(null);
            setError(t('ai:changes.error', { defaultValue: 'Analysis failed. Check the AI settings and try again.' }));
        } finally {
            setLoading(false);
        }
    };

    const addTask = async (index: number, s: Suggestion) => {
        setAdding(index);
        try {
            if (s.kind === 'reminder') {
                // A reminder is a calendar event that notifies 30 min before it starts.
                await api.post('/api/events', {
                    title: s.title,
                    ...(s.description ? { description: s.description } : {}),
                    category: 'other',
                    start_time: s.start_time,
                    reminder_30min: true,
                    reminder_1hour: false,
                    member_ids: [],
                });
            } else {
                await api.post('/api/tasks', {
                    title: s.title,
                    ...(s.description ? { description: s.description } : {}),
                    due_date: s.due_date,
                    priority: s.priority,
                    assigned_to: [],
                });
            }
            setAdded((current) => new Set(current).add(index));
        } catch (err) {
            console.error('Add suggested task error:', err);
            setError(t('ai:changes.addError', { defaultValue: 'Could not create the task.' }));
        } finally {
            setAdding(null);
        }
    };

    const changeById = (id: string) => data?.changes.find((c) => c.id === id);

    return (
        <section className="flex flex-col rounded-card border border-border bg-card p-5 shadow-surface">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 text-body font-semibold text-foreground">
                    <Activity className="h-4 w-4 text-muted-foreground" />
                    {t('ai:changes.title', { defaultValue: 'What changed' })}
                </h2>
                <div className="flex items-center gap-2">
                    <select
                        value={days}
                        onChange={(e) => setDays(Number(e.target.value))}
                        className="min-h-[44px] rounded-md border border-border bg-card px-2 text-caption"
                        aria-label={t('ai:changes.period', { defaultValue: 'Period' })}
                    >
                        {PERIODS.map((p) => (
                            <option key={p} value={p}>
                                {t('ai:changes.lastDays', { defaultValue: 'Last {{count}} days', count: p })}
                            </option>
                        ))}
                    </select>
                    <button
                        type="button"
                        onClick={() => void analyze()}
                        disabled={loading}
                        className="flex min-h-[44px] items-center gap-1.5 rounded-md bg-primary px-3 text-caption font-medium text-primary-foreground disabled:opacity-60"
                    >
                        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        {t('ai:changes.analyze', { defaultValue: 'Analyze' })}
                    </button>
                </div>
            </div>

            {error && <p className="text-caption text-red-600">{error}</p>}

            {!data && !error && (
                <p className="text-caption text-muted-foreground">
                    {t('ai:changes.intro', {
                        defaultValue: 'Compares recent days with the previous period and suggests tasks. Nothing is created without your click.',
                    })}
                </p>
            )}

            {data && data.changes.length === 0 && (
                <p className="text-caption text-muted-foreground">
                    {t('ai:changes.none', { defaultValue: 'No notable change detected over this period.' })}
                </p>
            )}

            {data && data.changes.length > 0 && (
                <div className="space-y-4">
                    {data.summary && <p className="text-body text-foreground">{data.summary}</p>}

                    <ul className="space-y-1.5">
                        {data.changes.map((c) => (
                            <li key={c.id} className="flex items-start gap-2 text-caption text-foreground">
                                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[c.severity]}`} />
                                <span>{c.fact}</span>
                            </li>
                        ))}
                    </ul>

                    {data.suggestions.length > 0 && (
                        <div>
                            <h3 className="mb-2 text-caption font-semibold text-foreground">
                                {t('ai:changes.suggested', { defaultValue: 'Suggested tasks' })}
                            </h3>
                            <ul className="space-y-2">
                                {data.suggestions.map((s, i) => (
                                    <li key={`${s.change_id}-${i}`} className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
                                        <div className="min-w-0">
                                            <p className="text-body font-medium text-foreground">
                                                <span className="mr-2 rounded-full border border-border px-2 py-0.5 text-caption text-muted-foreground">
                                                    {s.kind === 'reminder'
                                                        ? t('ai:changes.reminder', { defaultValue: 'Reminder' })
                                                        : t('ai:changes.task', { defaultValue: 'Task' })}
                                                </span>
                                                {s.title}
                                            </p>
                                            {s.description && <p className="text-caption text-muted-foreground">{s.description}</p>}
                                            <p className="mt-1 text-caption text-muted-foreground">
                                                {s.kind === 'reminder' ? `${s.due_date} 09:00` : `${s.priority} · ${s.due_date}`}
                                                {changeById(s.change_id) ? ` · ${changeById(s.change_id)!.fact}` : ''}
                                            </p>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => void addTask(i, s)}
                                            disabled={added.has(i) || adding === i}
                                            className="flex min-h-[44px] shrink-0 items-center gap-1 rounded-md border border-border px-3 text-caption disabled:opacity-60"
                                        >
                                            {added.has(i) ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                                            {added.has(i)
                                                ? t('ai:changes.added', { defaultValue: 'Added' })
                                                : t('ai:changes.add', { defaultValue: 'Add' })}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    <p className="text-caption text-muted-foreground">
                        {t('ai:changes.disclaimer', {
                            defaultValue: 'AI-generated from documented records. Not medical advice: discuss any concern with the doctor.',
                        })}
                    </p>
                </div>
            )}
        </section>
    );
};

export default ChangesCard;
