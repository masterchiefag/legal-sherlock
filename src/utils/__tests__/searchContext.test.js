import { describe, it, expect } from 'vitest';
import { buildSearchContextParams, searchContextToApiParams, hasSearchContext } from '../searchContext.js';

describe('buildSearchContextParams', () => {
    it('includes investigation ID as inv param', () => {
        const params = buildSearchContextParams({ investigationId: 'inv-123' });
        expect(params.get('inv')).toBe('inv-123');
    });

    it('omits inv when investigationId is null', () => {
        const params = buildSearchContextParams({});
        expect(params.has('inv')).toBe(false);
    });

    it('includes query and filters', () => {
        const params = buildSearchContextParams({
            query: 'fraud',
            reviewStatus: 'relevant',
            docType: 'email',
            investigationId: 'inv-abc',
        });
        expect(params.get('q')).toBe('fraud');
        expect(params.get('status')).toBe('relevant');
        expect(params.get('type')).toBe('email');
        expect(params.get('inv')).toBe('inv-abc');
    });
});

describe('searchContextToApiParams', () => {
    it('maps inv to investigation_id', () => {
        const urlParams = new URLSearchParams('inv=inv-123');
        const apiParams = searchContextToApiParams(urlParams);
        expect(apiParams.get('investigation_id')).toBe('inv-123');
        expect(apiParams.has('inv')).toBe(false);
    });

    it('does not set investigation_id when inv is absent', () => {
        const urlParams = new URLSearchParams('q=test');
        const apiParams = searchContextToApiParams(urlParams);
        expect(apiParams.has('investigation_id')).toBe(false);
    });

    it('maps all filter params correctly', () => {
        const urlParams = new URLSearchParams(
            'q=fraud&status=relevant&type=email&score=3%2B&from=2024-01-01&to=2024-12-31&inv=inv-456'
        );
        const apiParams = searchContextToApiParams(urlParams);
        expect(apiParams.get('q')).toBe('fraud');
        expect(apiParams.get('review_status')).toBe('relevant');
        expect(apiParams.get('doc_type')).toBe('email');
        expect(apiParams.get('score_min')).toBe('3');
        expect(apiParams.get('date_from')).toBe('2024-01-01');
        expect(apiParams.get('date_to')).toBe('2024-12-31');
        expect(apiParams.get('investigation_id')).toBe('inv-456');
    });
});

describe('hasSearchContext', () => {
    it('returns true when inv param is present', () => {
        const params = new URLSearchParams('inv=inv-123');
        expect(hasSearchContext(params)).toBe(true);
    });

    it('returns true when q param is present', () => {
        const params = new URLSearchParams('q=test');
        expect(hasSearchContext(params)).toBe(true);
    });

    it('returns false when no search context params', () => {
        const params = new URLSearchParams('foo=bar');
        expect(hasSearchContext(params)).toBe(false);
    });
});
