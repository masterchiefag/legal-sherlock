import { describe, it, expect } from 'vitest';
import { parseQuery, buildSearchFilter } from '../search-filter.js';

// ═══════════════════════════════════════════════════
// parseQuery
// ═══════════════════════════════════════════════════
describe('parseQuery', () => {
  it('wraps simple words with quotes and wildcard', () => {
    expect(parseQuery('hello')).toBe('"hello"*');
  });

  it('wraps multiple words separately', () => {
    expect(parseQuery('hello world')).toBe('"hello"* "world"*');
  });

  it('passes quoted phrases through', () => {
    expect(parseQuery('"exact match"')).toBe('"exact match"');
  });

  it('preserves OR operator', () => {
    expect(parseQuery('cat OR dog')).toBe('"cat"* OR "dog"*');
  });

  it('preserves AND operator', () => {
    expect(parseQuery('cat AND dog')).toBe('"cat"* AND "dog"*');
  });

  it('preserves NOT operator', () => {
    expect(parseQuery('cat NOT dog')).toBe('"cat"* NOT "dog"*');
  });

  it('converts -exclude to NOT "exclude"*', () => {
    expect(parseQuery('-draft')).toBe('NOT "draft"*');
  });

  it('passes column filters through', () => {
    expect(parseQuery('email_from:"john"')).toBe('email_from:"john"');
  });

  it('handles combined operators', () => {
    const result = parseQuery('report OR "quarterly earnings" -draft');
    expect(result).toBe('"report"* OR "quarterly earnings" NOT "draft"*');
  });

  it('returns empty string for empty input', () => {
    expect(parseQuery('')).toBe('');
  });

  it('returns empty string for whitespace input', () => {
    expect(parseQuery('   ')).toBe('');
  });

  it('strips stray quotes from words', () => {
    expect(parseQuery("'hello'")).toBe('"hello"*');
  });

  it('handles original_name column filter', () => {
    expect(parseQuery('original_name:"pdf"')).toBe('original_name:"pdf"');
  });
});

// ═══════════════════════════════════════════════════
// buildSearchFilter
// ═══════════════════════════════════════════════════
describe('buildSearchFilter', () => {
  it('returns empty filter for empty params', () => {
    const { filterWhere, filterParams } = buildSearchFilter({}, null);
    expect(filterWhere).toBe('');
    expect(filterParams).toEqual([]);
  });

  it('does NOT exclude attachments by default', () => {
    const { filterWhere } = buildSearchFilter({}, null);
    expect(filterWhere).not.toContain('attachment');
  });

  it('filters by doc_type when specified', () => {
    const { filterWhere, filterParams } = buildSearchFilter({ doc_type: 'email' }, null);
    expect(filterWhere).toContain('d.doc_type = ?');
    expect(filterParams).toContain('email');
  });

  it('filters by doc_type attachment when specified', () => {
    const { filterWhere, filterParams } = buildSearchFilter({ doc_type: 'attachment' }, null);
    expect(filterWhere).toContain('d.doc_type = ?');
    expect(filterParams).toContain('attachment');
  });

  it('adds hide_duplicates filter', () => {
    const { filterWhere } = buildSearchFilter({ hide_duplicates: '1' }, null);
    expect(filterWhere).toContain('d.is_duplicate = 0');
  });

  it('adds latest_thread_only filter', () => {
    const { filterWhere } = buildSearchFilter({ latest_thread_only: '1' }, null);
    expect(filterWhere).toContain('d.doc_type NOT IN');
    expect(filterWhere).toContain('MAX(t2.email_date)');
  });

  it('scopes by investigation_id', () => {
    const { filterWhere, filterParams } = buildSearchFilter(
      { investigation_id: 'inv-123' }, null
    );
    expect(filterWhere).toContain('d.investigation_id = ?');
    expect(filterParams).toContain('inv-123');
  });

  it('scopes non-admin user to their investigations', () => {
    const user = { id: 'user-1', role: 'reviewer' };
    const { filterWhere, filterParams } = buildSearchFilter({}, user);
    expect(filterWhere).toContain('investigation_members');
    expect(filterWhere).toContain('user_id = ?');
    expect(filterParams).toContain('user-1');
  });

  it('does not scope admin user', () => {
    const user = { id: 'admin-1', role: 'admin' };
    const { filterWhere } = buildSearchFilter({}, user);
    expect(filterWhere).not.toContain('investigation_members');
  });

  it('prefers investigation_id over user scoping', () => {
    const user = { id: 'user-1', role: 'reviewer' };
    const { filterWhere, filterParams } = buildSearchFilter(
      { investigation_id: 'inv-123' }, user
    );
    expect(filterWhere).toContain('d.investigation_id = ?');
    expect(filterWhere).not.toContain('investigation_members');
    expect(filterParams).toContain('inv-123');
  });

  it('adds status filter', () => {
    const { filterWhere, filterParams } = buildSearchFilter({ status: 'ready' }, null);
    expect(filterWhere).toContain('d.status = ?');
    expect(filterParams).toContain('ready');
  });

  it('adds custodian filter', () => {
    const { filterWhere, filterParams } = buildSearchFilter({ custodian: 'John' }, null);
    expect(filterWhere).toContain('d.custodian = ?');
    expect(filterParams).toContain('John');
  });

  it('adds review_status subquery', () => {
    const { filterWhere, filterParams } = buildSearchFilter(
      { review_status: 'relevant' }, null
    );
    expect(filterWhere).toContain('document_reviews');
    expect(filterParams).toContain('relevant');
  });

  it('handles tags as comma-separated string', () => {
    const { filterWhere, filterParams } = buildSearchFilter(
      { tags: 'privileged,responsive' }, null
    );
    expect(filterWhere).toContain('dt.tag_name IN (?,?)');
    expect(filterParams).toContain('privileged');
    expect(filterParams).toContain('responsive');
  });

  it('handles tags as array', () => {
    const { filterWhere, filterParams } = buildSearchFilter(
      { tags: ['privileged', 'responsive'] }, null
    );
    expect(filterWhere).toContain('dt.tag_name IN (?,?)');
    expect(filterParams).toContain('privileged');
  });

  it('adds date_from filter', () => {
    const { filterWhere, filterParams } = buildSearchFilter(
      { date_from: '2024-01-01' }, null
    );
    expect(filterWhere).toContain('>= ?');
    expect(filterParams).toContain('2024-01-01');
  });

  it('adds date_to filter with T23:59:59', () => {
    const { filterWhere, filterParams } = buildSearchFilter(
      { date_to: '2024-12-31' }, null
    );
    expect(filterWhere).toContain('<= ?');
    expect(filterParams).toContain('2024-12-31T23:59:59');
  });

  it('handles score_min=unscored', () => {
    const { filterWhere } = buildSearchFilter({ score_min: 'unscored' }, null);
    expect(filterWhere).toContain('NOT IN (SELECT document_id FROM classifications)');
  });

  it('handles numeric score_min', () => {
    const { filterWhere, filterParams } = buildSearchFilter(
      { score_min: '3' }, null
    );
    expect(filterWhere).toContain('c2.score >= ?');
    expect(filterParams).toContain(3);
  });

  it('handles score_max', () => {
    const { filterWhere, filterParams } = buildSearchFilter(
      { score_max: '4' }, null
    );
    expect(filterWhere).toContain('c2.score <= ?');
    expect(filterParams).toContain(4);
  });

  it('adds ocr_applied filter', () => {
    const { filterWhere } = buildSearchFilter({ ocr_applied: '1' }, null);
    expect(filterWhere).toContain('d.ocr_applied = 1');
  });

  it('adds batch_id filter', () => {
    const { filterWhere, filterParams } = buildSearchFilter(
      { batch_id: 'batch-1' }, null
    );
    expect(filterWhere).toContain('review_batch_documents');
    expect(filterParams).toContain('batch-1');
  });

  it('detects doc_identifier query and uses LIKE', () => {
    const { filterWhere, filterParams } = buildSearchFilter(
      { q: 'RIT_SAN_00001' }, null
    );
    expect(filterWhere).toContain('d.doc_identifier LIKE ?');
    expect(filterParams).toContain('%RIT_SAN_00001%');
  });

  it('does not use doc_identifier LIKE for regular queries', () => {
    const { filterWhere } = buildSearchFilter({ q: 'hello world' }, null);
    expect(filterWhere).not.toContain('doc_identifier');
  });

  it('combines multiple filters', () => {
    const { filterWhere, filterParams } = buildSearchFilter({
      investigation_id: 'inv-1',
      doc_type: 'email',
      hide_duplicates: '1',
      date_from: '2024-01-01',
      ocr_applied: '1',
    }, null);

    expect(filterWhere).toContain('d.investigation_id = ?');
    expect(filterWhere).toContain('d.doc_type = ?');
    expect(filterWhere).toContain('d.is_duplicate = 0');
    expect(filterWhere).toContain('>= ?');
    expect(filterWhere).toContain('d.ocr_applied = 1');
    expect(filterParams).toEqual(['inv-1', 'email', '2024-01-01']);
  });
});
