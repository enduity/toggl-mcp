import { describe, expect, it } from 'vitest';
import {
  applyTimeEntryPatchOps,
  putBodyFromEntry,
  requiresPutUpdate,
} from '../src/patch.js';
import type { TimeEntry } from '../src/types.js';

const baseEntry: TimeEntry = {
  id: 1,
  workspace_id: 100,
  description: 'Old',
  project_id: 10,
  billable: false,
  start: '2026-08-24T08:00:00.000Z',
  stop: '2026-08-24T09:00:00.000Z',
  duration: 3600,
};

describe('patch helpers', () => {
  it('requires PUT when start stop or duration is patched', () => {
    expect(
      requiresPutUpdate([{ op: 'replace', path: '/description', value: 'x' }])
    ).toBe(false);
    expect(
      requiresPutUpdate([{ op: 'replace', path: '/start', value: 'x' }])
    ).toBe(true);
  });

  it('applies offset timestamps and reconciles duration', () => {
    const next = applyTimeEntryPatchOps(baseEntry, [
      { op: 'replace', path: '/description', value: 'New' },
      {
        op: 'replace',
        path: '/start',
        value: '2026-08-24T11:14:10+03:00',
      },
      {
        op: 'replace',
        path: '/stop',
        value: '2026-08-24T11:49:10+03:00',
      },
    ]);
    expect(next).toMatchObject({
      description: 'New',
      start: '2026-08-24T08:14:10.000Z',
      stop: '2026-08-24T08:49:10.000Z',
      duration: 2100,
    });
    expect(putBodyFromEntry(next, 100)).toMatchObject({
      workspace_id: 100,
      start: '2026-08-24T08:14:10.000Z',
      stop: '2026-08-24T08:49:10.000Z',
      duration: 2100,
    });
  });
});
