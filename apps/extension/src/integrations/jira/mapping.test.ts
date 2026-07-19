import { describe, expect, it } from 'vitest';
import type { JiraConfig } from '@qa-copilot/shared';
import {
  OPENQA_LABEL,
  SUMMARY_MAX_LENGTH,
  extractSeverity,
  extractSummary,
  mapReportToIssue,
} from './mapping.js';
import { BUG_REPORT_MARKDOWN } from './fixtures.js';

const config: Pick<JiraConfig, 'projectKey' | 'issueTypeId' | 'priorityMap'> = {
  projectKey: 'QA',
  issueTypeId: '10004',
  priorityMap: { critical: 'Highest', high: 'High', medium: 'Medium', low: 'Low' },
};

describe('extractSummary', () => {
  it('uses the first level-1 heading', () => {
    expect(extractSummary(BUG_REPORT_MARKDOWN)).toBe(
      'Release date does not default from requested delivery date',
    );
  });

  it('strips inline markdown from the heading', () => {
    expect(extractSummary('# Login **fails** with `500` on [save](https://x.io)')).toBe(
      'Login fails with 500 on save',
    );
  });

  it('falls back to an explicit Title line', () => {
    expect(extractSummary('**Title:** Cart total is wrong\n\nrest')).toBe('Cart total is wrong');
    expect(extractSummary('Title: Cart total is wrong')).toBe('Cart total is wrong');
  });

  it('falls back to the first line with content', () => {
    expect(extractSummary('\n\n  Something broke\n\nmore')).toBe('Something broke');
  });

  it('never returns an empty summary', () => {
    expect(extractSummary('')).toBe('Bug report');
    expect(extractSummary('   \n\n  ')).toBe('Bug report');
  });

  it('truncates to Jira’s 255-character limit', () => {
    const summary = extractSummary(`# ${'x'.repeat(400)}`);
    expect(summary).toHaveLength(SUMMARY_MAX_LENGTH);
  });

  it('collapses newlines and runs of whitespace', () => {
    expect(extractSummary('#    Spaced    out   title')).toBe('Spaced out title');
  });
});

describe('extractSeverity', () => {
  it('reads a bold Severity line', () => {
    expect(extractSeverity(BUG_REPORT_MARKDOWN)).toBe('critical');
  });

  it('reads a plain Severity line regardless of case', () => {
    expect(extractSeverity('Severity: HIGH')).toBe('high');
    expect(extractSeverity('severity:  medium')).toBe('medium');
  });

  it('reads a Severity table row', () => {
    expect(extractSeverity('| Field | Value |\n| --- | --- |\n| Severity | low |')).toBe('low');
  });

  it('returns null when absent or unrecognized', () => {
    expect(extractSeverity('no severity here')).toBeNull();
    expect(extractSeverity('Severity: catastrophic')).toBeNull();
    expect(extractSeverity('')).toBeNull();
  });
});

describe('mapReportToIssue', () => {
  it('builds a payload from the report with project, type, summary and ADF description', () => {
    const payload = mapReportToIssue(BUG_REPORT_MARKDOWN, { config });

    expect(payload.fields.project.key).toBe('QA');
    expect(payload.fields.issuetype.id).toBe('10004');
    expect(payload.fields.summary).toBe(
      'Release date does not default from requested delivery date',
    );
    expect(payload.fields.description.type).toBe('doc');
    expect(payload.fields.description.content.length).toBeGreaterThan(0);
  });

  it('maps severity to the configured priority name', () => {
    expect(mapReportToIssue(BUG_REPORT_MARKDOWN, { config }).fields.priority).toEqual({
      name: 'Highest',
    });
    expect(mapReportToIssue('# t\n\nSeverity: low', { config }).fields.priority).toEqual({
      name: 'Low',
    });
  });

  it('omits priority when the report has no recognizable severity', () => {
    expect(mapReportToIssue('# just a title', { config }).fields.priority).toBeUndefined();
  });

  it('applies the openqa label by default', () => {
    expect(mapReportToIssue(BUG_REPORT_MARKDOWN, { config }).fields.labels).toEqual([OPENQA_LABEL]);
  });

  it('lets the composer override summary, labels and priority', () => {
    const payload = mapReportToIssue(BUG_REPORT_MARKDOWN, {
      config,
      overrides: {
        summary: 'Edited by the tester',
        labels: ['openqa', 'regression'],
        priorityName: 'Medium',
      },
    });

    expect(payload.fields.summary).toBe('Edited by the tester');
    expect(payload.fields.labels).toEqual(['openqa', 'regression']);
    expect(payload.fields.priority).toEqual({ name: 'Medium' });
  });

  it('truncates an over-long override rather than letting Jira reject it', () => {
    const payload = mapReportToIssue('# t', { config, overrides: { summary: 'y'.repeat(400) } });
    expect(payload.fields.summary).toHaveLength(SUMMARY_MAX_LENGTH);
  });

  it('drops priority when the composer explicitly clears it', () => {
    const payload = mapReportToIssue(BUG_REPORT_MARKDOWN, {
      config,
      overrides: { priorityName: null },
    });
    expect(payload.fields.priority).toBeUndefined();
  });

  it('merges dynamic required fields from createmeta', () => {
    const payload = mapReportToIssue('# t', {
      config,
      overrides: { extraFields: { customfield_101: { id: '5' } } },
    });
    expect(payload.fields.customfield_101).toEqual({ id: '5' });
  });
});
