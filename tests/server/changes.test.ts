import { describe, it, expect } from 'vitest';
import {
    containsMedicalTerm,
    validateChanges,
    buildSummary,
    type DetectedChange,
} from '../../server/src/services/ai/assistant';

const changes: DetectedChange[] = [
    { id: 'c1', kind: 'vital', severity: 'alert', fact: 'pain: average 2 -> 6.5 /10 (+225%)' },
    { id: 'c2', kind: 'vital', severity: 'watch', fact: 'weight: average 70.1 -> 62.1 kg (-11%)' },
];

describe('plain-language guard', () => {
    it('flags medical wording in English, French and Spanish', () => {
        for (const text of ['Adjust pain medication dosage', 'Talk to the doctor', 'Appeler le médecin', 'Ir al hospital', 'Book a blood test']) {
            expect(containsMedicalTerm(text)).toBe(true);
        }
    });
    it('lets everyday wording through', () => {
        for (const text of ['Check in with them today', 'Call a relative this evening', 'Prendre des nouvelles', 'Hacer una visita hoy']) {
            expect(containsMedicalTerm(text)).toBe(false);
        }
    });
});

describe('validateChanges', () => {
    it('replaces a suggestion with medical wording by a plain one', () => {
        const r = validateChanges(
            { suggestions: [{ change_id: 'c1', kind: 'task', title: 'Adjust pain medication dosage', description: '', due_in_days: 1, priority: 'Haute' }] },
            changes,
            'en'
        );
        expect(r.suggestions.some((s) => containsMedicalTerm(s.title, s.description))).toBe(false);
        expect(r.suggestions.find((s) => s.change_id === 'c1')?.kind).toBe('reminder'); // alert -> dated reminder
    });
    it('drops suggestions that point to an unknown change', () => {
        const r = validateChanges({ suggestions: [{ change_id: 'zz', kind: 'task', title: 'Ghost', description: '', due_in_days: 1, priority: 'Haute' }] }, changes, 'en');
        expect(r.suggestions.find((s) => s.title === 'Ghost')).toBeUndefined();
    });
    it('keeps a good suggestion and recomputes its date itself', () => {
        const r = validateChanges(
            { suggestions: [{ change_id: 'c2', kind: 'reminder', title: 'Check in again in two days', description: 'Spend time together', due_in_days: 2, priority: 'Moyenne' }] },
            changes,
            'en'
        );
        const s = r.suggestions.find((x) => x.change_id === 'c2');
        expect(s?.kind).toBe('reminder');
        expect(s?.start_time).toMatch(/^\d{4}-\d{2}-\d{2}T09:00:00$/);
    });
});

describe('buildSummary', () => {
    it('is built from the facts, in the requested language', () => {
        expect(buildSummary(changes, 'en', 7)).toBe('2 changes noticed over the last 7 days. 1 to follow up soon. 1 to keep an eye on.');
        expect(buildSummary(changes, 'fr', 7)).toContain('2 changements');
        expect(buildSummary([], 'en', 7)).toBe('');
    });
});
