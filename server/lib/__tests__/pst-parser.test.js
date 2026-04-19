import { describe, it, expect } from 'vitest';
import {
    parsePst,
    collectAuthoritativeDates,
    classifyMapiMessage,
    extractNonEmailMapi,
} from '../pst-parser.js';

// These tests cover exported surface + input validation + classification behavior.
// Full end-to-end behavior against a real PST is exercised by manual re-ingest
// of a known Yesha-style PST — we don't ship a PST fixture (binary, >MB, legal).

describe('pst-parser exports', () => {
    it('exports parsePst, collectAuthoritativeDates, classifyMapiMessage, extractNonEmailMapi', () => {
        expect(typeof parsePst).toBe('function');
        expect(typeof collectAuthoritativeDates).toBe('function');
        expect(typeof classifyMapiMessage).toBe('function');
        expect(typeof extractNonEmailMapi).toBe('function');
    });
});

describe('collectAuthoritativeDates error handling', () => {
    it('throws when given a non-existent path', () => {
        expect(() => collectAuthoritativeDates('/tmp/definitely-not-a-real-pst.pst')).toThrow();
    });

    it('throws when given a non-PST file', () => {
        // An empty or tiny file is not a valid PST
        expect(() => collectAuthoritativeDates('/etc/hosts')).toThrow();
    });
});

describe('classifyMapiMessage', () => {
    it('recognizes regular mail as email (Phase 1 handles it)', () => {
        expect(classifyMapiMessage('IPM.Note')).toBe('email');
        expect(classifyMapiMessage('IPM.Note.SMIME')).toBe('email');
        expect(classifyMapiMessage('IPM.Note.SMIME.MultipartSigned')).toBe('email');
        expect(classifyMapiMessage('IPM')).toBe('email');
    });

    it('recognizes calendar appointments and meeting requests', () => {
        expect(classifyMapiMessage('IPM.Appointment')).toBe('calendar');
        expect(classifyMapiMessage('IPM.Appointment.Occurrence')).toBe('calendar');
        expect(classifyMapiMessage('IPM.Schedule.Meeting.Request')).toBe('calendar');
        expect(classifyMapiMessage('IPM.Schedule.Meeting.Canceled')).toBe('calendar');
        expect(classifyMapiMessage('IPM.Schedule.Meeting.Resp.Pos')).toBe('calendar');
    });

    it('recognizes tasks and task requests', () => {
        expect(classifyMapiMessage('IPM.Task')).toBe('task');
        expect(classifyMapiMessage('IPM.TaskRequest')).toBe('task');
        expect(classifyMapiMessage('IPM.TaskRequest.Accept')).toBe('task');
    });

    it('recognizes sticky notes and journal entries', () => {
        expect(classifyMapiMessage('IPM.StickyNote')).toBe('note');
        expect(classifyMapiMessage('IPM.Activity')).toBe('note');
    });

    it('recognizes contacts and distribution lists', () => {
        expect(classifyMapiMessage('IPM.Contact')).toBe('contact');
        expect(classifyMapiMessage('IPM.DistList')).toBe('contact');
    });

    it('is case-insensitive (MAPI strings vary across exporters)', () => {
        expect(classifyMapiMessage('ipm.appointment')).toBe('calendar');
        expect(classifyMapiMessage('IPM.TASK')).toBe('task');
    });

    it('returns "other" for unknown / empty / non-string', () => {
        // Empty / null / non-string → "other" (conservative: Phase 1.3 will skip these)
        expect(classifyMapiMessage('')).toBe('other');
        expect(classifyMapiMessage('IPM.SomethingWeird')).toBe('other');
        expect(classifyMapiMessage(null)).toBe('other');
        expect(classifyMapiMessage(undefined)).toBe('other');
        expect(classifyMapiMessage(42)).toBe('other');
    });

    it('distinguishes IPM.Note.Rule (not an email doc) — intentional gap', () => {
        // We accept IPM.Note.Rule.* as email too (conservative). This test is a
        // regression canary — if we later exclude rule notifications, update.
        expect(classifyMapiMessage('IPM.Note.Rule.Notification.Recall')).toBe('other');
    });
});

describe('extractNonEmailMapi error handling', () => {
    it('throws when given a non-existent path', () => {
        expect(() => extractNonEmailMapi('/tmp/definitely-not-a-real-pst.pst')).toThrow();
    });

    it('throws when given a non-PST file', () => {
        expect(() => extractNonEmailMapi('/etc/hosts')).toThrow();
    });
});
